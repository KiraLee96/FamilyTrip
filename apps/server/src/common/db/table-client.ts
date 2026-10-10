/**
 * 表级客户端适配器（`TxClient` 的通用实现骨架）
 * ============================================================================
 * 为什么需要这一层：
 *   1. `common/db/write-path.ts` 的 `TxClient` 只声明了 `dbNow/insert/update`
 *      三个最小能力，域代码只依赖它 —— 但真正落库时总得有人把它接到驱动上。
 *   2. 技术方案要求「域内不出现裸 SQL / 不出现驱动类型」，所以驱动接缝
 *      必须收敛到唯一一个文件。本文件就是这个接缝。
 *   3. v0.1 阶段 `@prisma/client` 尚未生成（只有 CLI），因此这里**同时**
 *      提供：
 *        · `TableDriver`  —— 驱动抽象（Prisma 适配层后续实现）
 *        · `MemoryTableDriver` —— 内存实现，供单测 / 本地起服务用
 *
 * 🔴 不变量：
 *   · `dbNow()` 是**唯一**的时间来源（E2）。任何 `new Date()` 进业务写路径
 *     都会被同步游标撕裂，故此处绝不回退到应用时钟。
 *   · `insert` / `update` 不隐式补 `createdAt/updatedAt` —— 时间必须由
 *     调用方从 `dbNow()` 取后显式传入，保证同一事务内时间一致。
 *   · `update` 返回**受影响行数**，CAS 判定（E7）依赖它，不可省略。
 */

import type { TxClient } from './write-path.js';
import { rowKeyOf, toDisplayString } from './row-key.js';

/** 单行记录（snake_case 由驱动负责映射；此层统一用 camelCase 作为契约） */
export type Row = Record<string, unknown>;

/**
 * 区间/集合比较操作符 —— where 的**显式**方言。
 *
 * 🔴 为什么是显式白名单而非「透传任意对象」：
 *    若允许任意对象透传，`{ OR: [...] }` 这类**逻辑操作符**会被驱动误当成
 *    「名为 OR 的列 = 某值」，查询恒空且不报错 —— 典型的静默错值。
 *    显式枚举可让「漏实现」变成**编译期/运行期错误**而不是错误结果。
 *
 * 目前只开放同步游标所需的 `gt` 与 `in`：
 *   · `gt`  —— 复合游标 `(changedAt, id)` 的严格大于语义（E1–E6）
 *   · `in`  —— 可见范围限定（familyIds / tripIds），替代全表扫描
 * 需要新操作符时**显式**在此登记，并在两个驱动里同步实现。
 */
export interface WhereOperators<T = unknown> {
  gt?: T;
  gte?: T;
  lt?: T;
  lte?: T;
  in?: T[];
  not?: T | null;
}

/** 判定「是不是操作符对象」（非 Date、非数组、非 null 的普通对象） */
export function isWhereOperators(value: unknown): value is WhereOperators {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value) || value instanceof Date) return false;
  // 只认显式登记的键，其它一律判为「非法方言」并交由驱动报错
  return Object.keys(value).some((k) => k in OPERATOR_KEYS);
}

const OPERATOR_KEYS: Record<string, true> = { gt: true, gte: true, lt: true, lte: true, in: true, not: true };

/** 单个字段的条件：标量（等值）、操作符对象、或 IN 数组 */
export type WhereValue = string | number | bigint | boolean | Date | null | undefined | WhereOperators | unknown[];

/**
 * where 条件。
 *
 * 支持形态（**这就是全部**，驱动不得静默扩展）：
 *   · `{ field: scalar }`         —— 等值（含 `null`）
 *   · `{ field: [a, b] }`         —— IN
 *   · `{ field: { gt: x } }`      —— 区间比较（显式操作符）
 *   · `{ OR: [ {...}, {...} ] }`  —— 逻辑或（同步游标需要）
 *   · `{ AND: [ {...}, {...} ] }` —— 逻辑与
 *
 * 🔴 为什么值类型是 `unknown` 而不是收紧成 `ScalarLike`：
 *    域代码大量写 `{ tripId: row['tripId'] }`，而 `row[k]` 天然是 `unknown`
 *    （`Row = Record<string, unknown>`）。若把值类型收紧，会强迫 14 个域
 *    到处加类型断言 —— 收益只是编译期更严，代价是噪声断言反而**掩盖**真正的
 *    类型问题。运行期的保护由驱动承担：非法形态（未登记操作符 / 未知对象）
 *    一律抛错，见 `PrismaTableDriver.toPrismaWhere`。
 *    即：**边界处运行期强校验 > 全域编译期弱约束**。
 */
export type Where = Record<string, unknown>;

export type OrderBy = Array<Record<string, 'asc' | 'desc'>>;

export interface FindManyOptions {
  where?: Where;
  orderBy?: OrderBy;
  take?: number;
  skip?: number;
}

/**
 * 驱动抽象 —— 一张表一个 `table()`，模型名用 Prisma 的 camelCase 名。
 *
 * Prisma 适配层实现要点：
 *   `table(model) => (prisma as any)[model]`，其余方法直接透传。
 */
export interface TableDriver {
  /** DB 当前时间；MySQL 上建议 `SELECT NOW(3)` */
  dbNow(): Promise<Date>;
  insert(model: string, data: Row): Promise<void>;
  /** 返回受影响行数（CAS 判定依赖） */
  update(model: string, where: Where, data: Row): Promise<number>;
  findUnique(model: string, where: Where): Promise<Row | null>;
  findMany(model: string, options?: FindManyOptions): Promise<Row[]>;
  count(model: string, where?: Where): Promise<number>;
  /**
   * 仅供**测试与运维巡检**的整表快照（只读，行对象为副本）。
   *
   * 🔴 存在的理由：加密域（C 组）与软删（A 组）的验收点，
   *    断言对象是**落库后的物理行**（如「明文列必须为 null」「密文列是 Buffer」），
   *    而这些正是业务读路径**故意不暴露**的字段 —— 只能从驱动层取。
   *
   * ⛔ 业务代码严禁调用。生产 Prisma 适配器可以不实现（返回 undefined），
   *    因此标可选；调用方必须自行判空。
   */
  dump?(model: string): Row[];
}

/** 事务上下文包装：把驱动 + 事务生命周期收敛成一个对象 */
export interface DriverTxRunner {
  /** 在一个事务里执行；失败必须整体回滚 */
  run<T>(body: (driver: TableDriver) => Promise<T>): Promise<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 内存实现
// ─────────────────────────────────────────────────────────────────────────────

interface MemoryTable {
  rows: Map<string, Row>;
  /** 单调递增的内部序号，保证同毫秒插入也有稳定顺序（游标分页依赖） */
  seq: number;
}

function keyOf(row: Row): string {
  return rowKeyOf(row);
}

/**
 * 内存版 where 匹配 —— 必须与 `PrismaTableDriver` 的翻译**逐条语义对齐**。
 *
 * 对齐清单（改一处必须改另一处）：
 *   · `{ f: null }`            → `f IS NULL`
 *   · `{ f: scalar }`          → `f = scalar`
 *   · `{ f: [..] }`            → `f IN (..)`；空数组恒假
 *   · `{ f: {gt:x} }`          → `f > x`（可组合 gte/lt/lte/not）
 *   · `{ OR: [..] }`           → 逻辑或（空数组恒假，与 SQL 一致）
 *   · `{ AND: [..] }`          → 逻辑与（空数组恒真，与 SQL 一致）
 */
function matches(row: Row, where: Where | undefined): boolean {
  if (where === undefined) return true;
  for (const [k, v] of Object.entries(where)) {
    // ── 逻辑组合 ────────────────────────────────────────
    if (k === 'OR' || k === 'AND') {
      const clauses = (Array.isArray(v) ? v : []) as Where[];
      // SQL 语义：OR 空集恒假、AND 空集恒真
      if (clauses.length === 0) {
        if (k === 'OR') return false;
        continue;
      }
      const ok = clauses.map((clause) => matches(row, clause));
      if (k === 'OR' && !ok.some(Boolean)) return false;
      if (k === 'AND' && !ok.every(Boolean)) return false;
      continue;
    }

    const actual = row[k] ?? null;

    // ── IN（数组） ──────────────────────────────────────
    if (Array.isArray(v)) {
      if (!v.some((x) => deepEqual(x, actual))) return false;
      continue;
    }

    // ── 区间操作符 ──────────────────────────────────────
    if (isWhereOperators(v)) {
      if (!matchOperators(actual, v)) return false;
      continue;
    }

    // ── 标量等值（含 null） ──────────────────────────────
    if (!deepEqual(v ?? null, actual)) return false;
  }
  return true;
}

/** 区间操作符匹配；`not` 与其余条件同时满足（SQL 的 AND 组合） */
function matchOperators(actual: unknown, ops: WhereOperators): boolean {
  if (ops.gt !== undefined && !(compareValue(actual, ops.gt) > 0)) return false;
  if (ops.gte !== undefined && !(compareValue(actual, ops.gte) >= 0)) return false;
  if (ops.lt !== undefined && !(compareValue(actual, ops.lt) < 0)) return false;
  if (ops.lte !== undefined && !(compareValue(actual, ops.lte) <= 0)) return false;
  if (ops.in !== undefined && !ops.in.some((x) => deepEqual(x, actual))) return false;
  if (ops.not !== undefined && deepEqual(ops.not, actual)) return false;
  return true;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    return toDisplayString(a) === toDisplayString(b);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual((a as Row)[k], (b as Row)[k]));
  }
  return false;
}

function compareBy(a: Row, b: Row, orderBy: OrderBy): number {
  for (const clause of orderBy) {
    for (const [field, dir] of Object.entries(clause)) {
      const av = a[field];
      const bv = b[field];
      const r = compareValue(av, bv);
      if (r !== 0) return dir === 'desc' ? -r : r;
    }
  }
  return 0;
}

function compareValue(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : 1;
  if (a instanceof Date && b instanceof Date) {
    const d = a.getTime() - b.getTime();
    return d === 0 ? 0 : d < 0 ? -1 : 1;
  }
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : 1;
  const sa = toDisplayString(a);
  const sb = toDisplayString(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * 内存驱动。
 *
 * 用途（明确边界）：
 *   ✅ 单测 / 集成测试 / 本地无 MySQL 起服务
 *   ❌ 不是生产实现。没有并发控制、没有索引、没有持久化。
 *
 * 事务语义：`run()` 里先记录受影响表的快照，body 抛错则回滚。
 */
export class MemoryTableDriver implements TableDriver, DriverTxRunner {
  private readonly tables = new Map<string, MemoryTable>();

  /** 可控时钟；默认跟随系统时间，便于测试里注入固定时间 */
  private clockOffsetMs = 0;

  constructor(private readonly opts: { freezeAt?: Date } = {}) {}

  // ── 事务包装 ─────────────────────────────────────────────
  async run<T>(body: (driver: TableDriver) => Promise<T>): Promise<T> {
    const snapshot = this.snapshot();
    try {
      return await body(this);
    } catch (e) {
      this.restore(snapshot);
      throw e;
    }
  }

  private snapshot(): Map<string, Row[]> {
    const snap = new Map<string, Row[]>();
    for (const [name, t] of this.tables) {
      snap.set(name, [...t.rows.values()].map((r) => ({ ...r })));
    }
    return snap;
  }

  private restore(snap: Map<string, Row[]>): void {
    for (const [name, rows] of snap) {
      const t = this.table(name);
      t.rows = new Map(rows.map((r) => [keyOf(r), r]));
    }
  }

  private table(model: string): MemoryTable {
    let t = this.tables.get(model);
    if (!t) {
      t = { rows: new Map(), seq: 0 };
      this.tables.set(model, t);
    }
    return t;
  }

  // ── 时间 ────────────────────────────────────────────────
  // ⚠️ 内存实现是纯同步的，但 `TableDriver` 契约要求 Promise。
  //    显式 `Promise.resolve` 而非 `async` —— 避免让调用方以为这里有 I/O。
  dbNow(): Promise<Date> {
    if (this.opts.freezeAt) return Promise.resolve(new Date(this.opts.freezeAt.getTime()));
    return Promise.resolve(new Date(Date.now() + this.clockOffsetMs));
  }

  /** 测试辅助：把时钟往前推（模拟跨毫秒游标推进） */
  advance(ms: number): void {
    this.clockOffsetMs += ms;
  }

  // ── 写 ──────────────────────────────────────────────────
  // 三个写/读方法同样是纯同步的，按契约要求包成 Promise（见 dbNow 的说明）。
  insert(model: string, data: Row): Promise<void> {
    const t = this.table(model);
    if (data['id'] === undefined || data['id'] === null) {
      return Promise.reject(new Error(`[MemoryTableDriver] ${model}.insert 缺少主键 id`));
    }
    const k = keyOf(data);
    if (t.rows.has(k)) {
      return Promise.reject(new Error(`[MemoryTableDriver] ${model} 主键冲突: ${k}`));
    }
    t.seq += 1;
    t.rows.set(k, { ...data });
    return Promise.resolve();
  }

  update(model: string, where: Where, data: Row): Promise<number> {
    const t = this.table(model);
    let affected = 0;
    for (const row of t.rows.values()) {
      if (!matches(row, where)) continue;
      for (const [k, v] of Object.entries(data)) {
        if (k === 'id') continue; // 主键不可变
        row[k] = v;
      }
      affected += 1;
    }
    return Promise.resolve(affected);
  }

  // ── 读 ──────────────────────────────────────────────────
  findUnique(model: string, where: Where): Promise<Row | null> {
    for (const row of this.table(model).rows.values()) {
      if (matches(row, where)) return Promise.resolve({ ...row });
    }
    return Promise.resolve(null);
  }

  findMany(model: string, options: FindManyOptions = {}): Promise<Row[]> {
    let rows = [...this.table(model).rows.values()].filter((r) => matches(r, options.where));
    if (options.orderBy && options.orderBy.length > 0) {
      const orderBy = options.orderBy;
      rows = rows.sort((a, b) => compareBy(a, b, orderBy));
    }
    if (options.skip !== undefined) rows = rows.slice(options.skip);
    if (options.take !== undefined) rows = rows.slice(0, options.take);
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  count(model: string, where?: Where): Promise<number> {
    let n = 0;
    for (const row of this.table(model).rows.values()) if (matches(row, where)) n += 1;
    return Promise.resolve(n);
  }

  // ── 测试辅助 ────────────────────────────────────────────
  /** 直接灌种子数据（绕过业务写路径，仅供测试） */
  seed(model: string, rows: Row[]): void {
    const t = this.table(model);
    for (const r of rows) t.rows.set(keyOf(r), { ...r });
  }

  dump(model: string): Row[] {
    return [...this.table(model).rows.values()].map((r) => ({ ...r }));
  }
}

/**
 * 把 `TableDriver` 收窄成 `write-path` 需要的 `TxClient`。
 *
 * 这样域代码可以只持有 `TxClient`（最小接口），测试里塞内存驱动，
 * 生产里塞 Prisma 驱动，两边零改动。
 */
export function asTxClient(driver: TableDriver): TxClient {
  return {
    dbNow: () => driver.dbNow(),
    insert: (model, data) => driver.insert(model, data),
    update: (model, where, data) => driver.update(model, where, data),
  };
}
