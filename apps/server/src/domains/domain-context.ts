/**
 * 域共享上下文 —— handler 的「工具箱」
 * ============================================================================
 * 每个域 handler 都需要的三件事：
 *   ① 表驱动（读）
 *   ② 事务 + 写路径收口（写，三写同事务）
 *   ③ ID 生成器 / 审计保留期
 *
 * 把它们打包成一个 `DomainContext`，避免每个域各造一遍，
 * 也避免把 `TableDriver` 直接暴露给 handler（那样会绕过写路径收口）。
 */

import { nextId as defaultNextId } from '../common/id/snowflake.js';
import { asTxClient, type DriverTxRunner, type TableDriver, type Row } from '../common/db/table-client.js';
import { commitWrite, softDelete, type AuditEntry, type ChangeEntry, type WriteContext } from '../common/db/write-path.js';
import type { TxContext, TxRunner } from '../common/db/transaction.js';

/** 审计保留期（M5）：默认 365 天，可按 action 覆写 */
export const DEFAULT_AUDIT_RETENTION_DAYS = 365;

export interface DomainContextOptions {
  /** 读驱动（可指向只读副本） */
  reader: TableDriver;
  /** 事务跑者（写路径必须经它） */
  runner: DriverTxRunner;
  /** ID 生成器 */
  nextId?: () => bigint;
  /** 审计保留期计算 */
  retainUntilOf?: (createdAt: Date) => Date;
  /** 应用服务器时区（仅用于展示，不用于游标） */
  clock?: () => Date;
}

export interface DomainContext {
  /** 只读查询 */
  read: TableDriver;

  /**
   * 在一个事务里执行读改写。
   * `body` 收 `TxHandle`：既有业务写能力，又有读能力（同事务内读己写）。
   */
  tx<T>(body: (tx: TxHandle) => Promise<T>): Promise<T>;

  /** 一键软删（含 change_log） */
  softDelete(model: string, id: bigint, change: Omit<ChangeEntry, 'op' | 'entityId'>, audit?: AuditEntry): Promise<Date>;
}

/** 事务内句柄 */
export interface TxHandle {
  /** 表驱动（与外部共享同一内存实例 / 同一 Prisma tx） */
  db: TableDriver;
  /** 写路径收口 */
  write: WriteContext;
  /** 简写：业务写 + change_log +（可选）audit_log */
  commit: (input: Parameters<typeof commitWrite>[1]) => Promise<Date>;
}

export function createDomainContext(opts: DomainContextOptions): DomainContext {
  const { reader, runner } = opts;
  const nextId = opts.nextId ?? defaultNextId;
  const retainUntilOf =
    opts.retainUntilOf ??
    ((createdAt: Date) => new Date(createdAt.getTime() + DEFAULT_AUDIT_RETENTION_DAYS * 86_400_000));

  return {
    read: reader,

    async tx<T>(body: (tx: TxHandle) => Promise<T>): Promise<T> {
      return runner.run(async (driver) => {
        const write: WriteContext = {
          tx: asTxClient(driver),
          actorId: null, // 由 handler 用 withActor 覆写
          nextId,
          retainUntilOf,
        };
        const handle: TxHandle = {
          db: driver,
          write,
          commit: (input) => commitWrite(write, input),
        };
        return body(handle);
      });
    },

    softDelete: (model, id, change, audit) =>
      runner.run(async (driver) => {
        const write: WriteContext = { tx: asTxClient(driver), actorId: null, nextId, retainUntilOf };
        return softDelete(write, model, id, change, audit);
      }),
  };
}

/** 把 actorId 注入事务句柄（handler 进入事务第一件事） */
export function withActor(tx: TxHandle, actorId: bigint | null): TxHandle {
  return {
    ...tx,
    write: { ...tx.write, actorId },
    commit: (input) => commitWrite({ ...tx.write, actorId }, input),
  };
}

/**
 * `TxRunner` 兼容包装 —— `common/db/transaction.ts` 的 `TxRunner`
 * 与 `DriverTxRunner` 是同构的，此处做显式适配，避免两套抽象漂移。
 */
export function asTxRunner(runner: DriverTxRunner): TxRunner {
  return <T,>(body: (tx: TxContext) => Promise<T>) => runner.run((driver) => body({ client: driver }));
}

/** 从 `TxContext` 取回驱动（配合 `asTxRunner` 使用） */
export function driverOf(ctx: TxContext): TableDriver {
  return ctx.client as TableDriver;
}

/** 小工具：安全取 bigint */
export function asBigint(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

/** 小工具：把行里的 bigint 转成字符串（JSON 序列化需要） */
export function stringifyIds<T extends Row>(row: T, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const f of fields) {
    const v = out[f];
    if (typeof v === 'bigint') out[f] = v.toString();
  }
  return out;
}

/** 小工具：批量把 bigint 字段转字符串 */
export function serializeRow(row: Row, bigintFields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = bigintFields.includes(k) && typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
