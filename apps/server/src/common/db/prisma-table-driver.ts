/**
 * Prisma 表驱动 —— `TableDriver` 的生产实现
 * ============================================================================
 * 设计目标：让 14 个业务域**零改动**地从 `MemoryTableDriver` 切到真实 MySQL。
 *
 * 🔴 三个必须说清的设计决定（都源于 Prisma 与 `TableDriver` 的语义差异）：
 *
 *   1. **`update` 必须走 `updateMany`，不能走 `update`。**
 *      `TableDriver.update(model, where, data)` 的契约是「按任意条件批量更新，
 *      返回受影响行数」。而 Prisma 的 `update()` 只接受**唯一选择器**
 *      （`{id}` / `{@@unique 组合}`），且不接受 `version` 这类普通列。
 *      CAS 乐观锁（E7）恰恰依赖 `where = {id, version, deletedAt}` 这种
 *      **非唯一** 组合 + 「0 行 → 409」的判定，所以只有 `updateMany` 满足语义。
 *      `updateMany` 返回 `{count}`，正好就是 `affectedRows`。
 *
 *   2. **`findUnique` 必须走 `findFirst`。**
 *      域代码大量使用 `{familyId, userId, role: 'OWNER', deletedAt: null}` 这类
 *      **非唯一组合** 做单行查询（`findUnique` 在 `TableDriver` 里表达的是
 *      「至多取一行」，不是 SQL 的唯一约束语义）。Prisma 的 `findUnique()`
 *      会直接拒绝这种选择器，故统一用 `findFirst`。
 *
 *   3. **`where` 走显式登记的方言，未知形态一律抛错。**
 *      支持：标量等值（含 `null`）/ 数组（IN）/ 操作符对象
 *      (`gt|gte|lt|lte|in|not`) / 逻辑组合 (`OR`|`AND`，递归)。
 *      🔴 绝不静默降级：若把 `{ OR: [...] }` 当成「名为 OR 的列 = 数组」，
 *      查询会恒空且不报错；若把未登记的键透传给 Prisma，Prisma 会**忽略**它，
 *      条件被丢弃 → 查询范围意外放大 → 越权读风险。故未登记形态直接抛错。
 *
 * 🔴 不变量（与内存驱动逐条对齐）：
 *   · `dbNow()` 是唯一时间来源 —— 走 DB 时钟（`NOW(3)`），绝不回退应用时钟。
 *   · `insert` / `update` 不隐式补 `createdAt/updatedAt`。
 *   · `update` 返回受影响行数（CAS 依赖）。
 *   · 事务内所有操作复用**同一个** `Prisma.TransactionClient`。
 */

import type { PrismaClient } from '@prisma/client';
import {
  isWhereOperators,
  type DriverTxRunner,
  type FindManyOptions,
  type OrderBy,
  type Row,
  type TableDriver,
  type Where,
  type WhereOperators,
} from './table-client.js';

/** 驱动可接受的标量取值 */
type Scalar = string | number | bigint | boolean | Date | null;

/** 已登记的操作符键 —— 与 `WhereOperators` 保持同步 */
const SUPPORTED_OPERATORS: Record<string, true> = {
  gt: true,
  gte: true,
  lt: true,
  lte: true,
  in: true,
  not: true,
};

/**
 * 把操作符对象翻译成 Prisma 的 `{ gt: ... }` 形态。
 *
 * Prisma 的区间操作符语法与本方言**同构**，故大部分可直接透传；
 * 显式逐键拷贝而不是 `{...ops}` 的原因是：
 *   · 未登记的键必须在**这里**被拒绝（否则未知键会原样发给 Prisma，
 *     而 Prisma 会忽略它 → 条件被静默丢弃 → 查询范围放大）。
 *   · 需要保证只输出 Prisma 认识的键，避免下游因未知键报错或静默忽略。
 */
function toPrismaOperators(field: string, ops: WhereOperators): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [op, val] of Object.entries(ops)) {
    if (val === undefined) continue;
    if (!(op in SUPPORTED_OPERATORS)) {
      throw new Error(
        `[PrismaTableDriver] where 字段 '${field}' 使用了未登记的操作符 '${op}'。` +
          `已登记: ${Object.keys(SUPPORTED_OPERATORS).join(', ')}。` +
          `如需新增，请在 table-client.ts 的 WhereOperators 与两个驱动里同步实现。`,
      );
    }
    // Prisma 的 not 支持标量/对象；null 表示 IS NOT NULL
    out[op] = val;
  }
  if (Object.keys(out).length === 0) {
    throw new Error(
      `[PrismaTableDriver] where 字段 '${field}' 的操作符对象为空（全部取值 undefined）。` +
        `空条件对象会被 Prisma 当作无条件匹配，比预期放宽范围 —— 请修正调用方。`,
    );
  }
  return out;
}

/**
 * `TableDriver.where` → Prisma `where`。
 *
 * 翻译规则（与 `MemoryTableDriver.matches` 逐条对齐）：
 *   · 标量（含 null / Date）        → 等值
 *   · 数组                          → `{ in: [...] }`（空数组天然恒假，与 SQL 一致）
 *   · 操作符对象 `{gt/gte/lt/lte/in/not}` → 同构透传
 *   · `OR` / `AND`                  → 逻辑组合，递归翻译子句
 *
 * 🔴 未登记的形态一律**抛错**，绝不静默降级 —— 静默降级的后果是
 *    「条件被丢弃、查询范围放大」，属于越权读风险。
 */
function toPrismaWhere(where: Where | undefined): Record<string, unknown> {
  if (where === undefined) return {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(where)) {
    // ── 逻辑组合 ────────────────────────────────────────
    if (key === 'OR' || key === 'AND') {
      if (!Array.isArray(value)) {
        throw new Error(
          `[PrismaTableDriver] where 的 '${key}' 必须是子句数组，收到: ${JSON.stringify(value)}`,
        );
      }
      // 空 OR 恒假、空 AND 恒真 —— 交给 Prisma 处理会因空数组语义歧义，
      // 故在内存驱动里已定义清楚，这里对空数组显式落成等价条件。
      if (value.length === 0) {
        if (key === 'OR') out['OR'] = []; // Prisma: OR: [] → 恒假
        continue; // AND: [] → 恒真，等价于不加条件
      }
      out[key] = (value as Where[]).map((clause) => toPrismaWhere(clause));
      continue;
    }

    // ── IN（数组） ──────────────────────────────────────
    if (Array.isArray(value)) {
      out[key] = { in: value as Scalar[] };
      continue;
    }

    // ── 区间操作符 ──────────────────────────────────────
    if (isWhereOperators(value)) {
      out[key] = toPrismaOperators(key, value);
      continue;
    }

    // ── 普通对象：非法方言 ───────────────────────────────
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      throw new Error(
        `[PrismaTableDriver] where 字段 '${key}' 收到无法识别的对象取值。` +
          `支持的是：标量（等值）、数组（IN）、操作符对象（${Object.keys(SUPPORTED_OPERATORS).join('/')}）。` +
          `收到: ${JSON.stringify(value)}。`,
      );
    }

    // ── 标量等值（含 null） ──────────────────────────────
    out[key] = value;
  }

  return out;
}

/** `TableDriver.orderBy`（数组套对象）→ Prisma `orderBy`（数组套对象，同构） */
function toPrismaOrderBy(orderBy: OrderBy | undefined): Record<string, 'asc' | 'desc'>[] | undefined {
  if (orderBy === undefined || orderBy.length === 0) return undefined;
  return orderBy.map((clause) => ({ ...clause }));
}

/**
 * 取 Prisma 的模型委托（`prisma.user` / `prisma.family` …）。
 *
 * 模型名在 schema 里已经是 camelCase 委托名（`@@map` 只管物理表名），
 * 所以这里不需要映射表。找不到就是拼错了模型名 —— 直接抛出，避免
 * `undefined.findMany` 这种难查的运行期错误。
 */
interface ModelDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findFirst(args: Record<string, unknown>): Promise<unknown>;
  findMany(args: Record<string, unknown>): Promise<unknown[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  count(args: Record<string, unknown>): Promise<number>;
}

function delegateOf(client: PrismaClientLike, model: string): ModelDelegate {
  const delegate = (client as unknown as Record<string, unknown>)[model];
  if (delegate === undefined || delegate === null || typeof delegate !== 'object') {
    throw new Error(
      `[PrismaTableDriver] 未知模型 '${model}'。` +
        `请核对 prisma/schema.prisma 的模型名是否与调用方一致（模型名即 Prisma 委托名）。`,
    );
  }
  return delegate as ModelDelegate;
}

/**
 * 事务内外的最小 Prisma 表面。
 * 用结构化类型而非 `PrismaClient | Prisma.TransactionClient` 联合 ——
 * 后者在严格模式下会因联合方法签名不兼容而无法直接调用。
 */
interface PrismaClientLike {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $transaction<R>(fn: (tx: PrismaClientLike) => Promise<R>): Promise<R>;
  [model: string]: unknown;
}

/** 把 `Prisma.TransactionClient` 收窄成本文件的表面（供外部类型标注用） */
export type PrismaTransactionClient = Parameters<PrismaClient['$transaction']>[0] extends (
  tx: infer T,
) => unknown
  ? T
  : never;

/**
 * 在给定 Prisma 客户端上构造一个 `TableDriver`。
 *
 * 抽成独立函数（而非只给类）是因为事务里要用**同一个签名**把
 * `Prisma.TransactionClient` 也包成驱动 —— 二者方法集相同。
 *
 * @param client        PrismaClient（事务外）或 Prisma.TransactionClient（事务内）
 * @param modelNames    允许访问的模型名白名单；用于启动期/首次访问校验
 */
function driverOver(client: PrismaClientLike, modelNames?: readonly string[]): TableDriver {
  const guarded = (model: string): ModelDelegate => {
    if (modelNames !== undefined && !modelNames.includes(model)) {
      throw new Error(
        `[PrismaTableDriver] 模型 '${model}' 不在已知模型清单内。` +
          `已知: ${modelNames.join(', ')}。`,
      );
    }
    return delegateOf(client, model);
  };

  return {
    // ── 时间：唯一来源是 DB 时钟（E2） ─────────────────────
    async dbNow(): Promise<Date> {
      // NOW(3) 与 schema 的 DATETIME(3) 对齐，避免毫秒被截断导致
      // 同步游标 (changedAt, id) 在同一秒内出现并列时间。
      const rows = await client.$queryRaw<Array<{ now: Date }>>`SELECT NOW(3) AS now`;
      const row = rows[0];
      if (row === undefined) {
        throw new Error('[PrismaTableDriver] dbNow(): SELECT NOW(3) 未返回任何行');
      }
      return row.now;
    },

    // ── 写 ────────────────────────────────────────────────
    async insert(model: string, data: Row): Promise<void> {
      const d = guarded(model);
      // `create` 的重复主键/唯一键冲突会抛 PrismaClientKnownRequestError(P2002)。
      // 这里**不**吞掉 —— 上层（幂等/重试）需要区分冲突与其它失败。
      await d.create({ data: { ...data } });
    },

    async update(model: string, where: Where, data: Row): Promise<number> {
      const d = guarded(model);
      // 🔴 updateMany 而非 update：见文件头第 1 条。返回的 count 即 affectedRows，
      //    CAS（E7）靠它为 0 判定 409，语义必须精确。
      const result = await d.updateMany({
        where: toPrismaWhere(where),
        data: { ...data },
      });
      return result.count;
    },

    // ── 读 ────────────────────────────────────────────────
    async findUnique(model: string, where: Where): Promise<Row | null> {
      const d = guarded(model);
      // 🔴 findFirst 而非 findUnique：见文件头第 2 条。
      const row = await d.findFirst({ where: toPrismaWhere(where) });
      return row === null || row === undefined ? null : (row as Row);
    },

    async findMany(model: string, options: FindManyOptions = {}): Promise<Row[]> {
      const d = guarded(model);
      const args: Record<string, unknown> = { where: toPrismaWhere(options.where) };
      const orderBy = toPrismaOrderBy(options.orderBy);
      if (orderBy !== undefined) args['orderBy'] = orderBy;
      if (options.take !== undefined) args['take'] = options.take;
      if (options.skip !== undefined) args['skip'] = options.skip;
      const rows = await d.findMany(args);
      return rows as Row[];
    },

    async count(model: string, where?: Where): Promise<number> {
      const d = guarded(model);
      return d.count({ where: toPrismaWhere(where) });
    },

    // ── dump：**有意不实现** ────────────────────────────────
    // 契约声明它是可选的，且「生产适配器可以不实现」。
    // 理由：dump 用于验收「落库后的物理行」（密文列是 Buffer、明文列为 null）。
    // 生产环境不该有整表快照出口 —— 既是性能风险也是越权读风险。
    // 验收类断言在 Prisma 上通过 $queryRaw 单独取证，不复用此通道。
  };
}

/**
 * Prisma 表驱动（生产实现）。
 *
 * 同时实现 `TableDriver` 与 `DriverTxRunner`：后者让 `DomainContext.tx()`
 * 能把整段读写改放进一个真实事务。
 *
 * ```ts
 * const driver = new PrismaTableDriver(prisma);
 * const app = buildApp({ driver });
 * ```
 */
export class PrismaTableDriver implements TableDriver, DriverTxRunner {
  private readonly client: PrismaClientLike & PrismaClient;
  private readonly modelNames: readonly string[];

  constructor(client: PrismaClient, modelNames?: readonly string[]) {
    this.client = client as PrismaClientLike & PrismaClient;
    // 未知模型清单：从客户端自身属性推导，供首访守卫使用。
    this.modelNames =
      modelNames ??
      Object.keys(client as unknown as Record<string, unknown>).filter(
        (k) => !k.startsWith('_') && !k.startsWith('$'),
      );
  }

  // ── 非事务路径：直接作用于 PrismaClient ─────────────────
  dbNow(): Promise<Date> {
    return driverOver(this.client, this.modelNames).dbNow();
  }

  insert(model: string, data: Row): Promise<void> {
    return driverOver(this.client, this.modelNames).insert(model, data);
  }

  update(model: string, where: Where, data: Row): Promise<number> {
    return driverOver(this.client, this.modelNames).update(model, where, data);
  }

  findUnique(model: string, where: Where): Promise<Row | null> {
    return driverOver(this.client, this.modelNames).findUnique(model, where);
  }

  findMany(model: string, options?: FindManyOptions): Promise<Row[]> {
    return driverOver(this.client, this.modelNames).findMany(model, options);
  }

  count(model: string, where?: Where): Promise<number> {
    return driverOver(this.client, this.modelNames).count(model, where);
  }

  // ── 事务路径：`run()` 里的所有操作复用同一个 tx ─────────
  /**
   * 在一个真实事务里执行 `body`。
   *
   * 🔴 为什么必须把 tx 包成新的 `TableDriver`：
   *    `Prisma.TransactionClient` 与 `PrismaClient` 的方法集一致（少了
   *    `$connect` / `$transaction` 等），所以同一个 `driverOver` 工厂可以直接
   *    复用。**绝不能**在 body 里退回用外层 `this` —— 那样事务外的
   *    PrismaClient 会另开连接，写操作脱离事务，回滚失效。
   */
  run<T>(body: (driver: TableDriver) => Promise<T>): Promise<T> {
    return this.client.$transaction(async (tx) => {
      const txDriver = driverOver(tx, this.modelNames);
      return body(txDriver);
    });
  }

  /** 生命周期：显式断开连接（进程优雅退出时调用） */
  disconnect(): Promise<void> {
    return this.client.$disconnect();
  }
}
