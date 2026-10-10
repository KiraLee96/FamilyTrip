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

/** where 条件：等值匹配（含 null）；`in` 用数组表达 */
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

function matches(row: Row, where: Where | undefined): boolean {
  if (where === undefined) return true;
  for (const [k, v] of Object.entries(where)) {
    const actual = row[k] ?? null;
    if (Array.isArray(v)) {
      if (!v.some((x) => deepEqual(x, actual))) return false;
      continue;
    }
    if (!deepEqual(v ?? null, actual)) return false;
  }
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
