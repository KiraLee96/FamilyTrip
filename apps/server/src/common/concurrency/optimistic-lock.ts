/**
 * E7 · 并发写保护 —— CAS 乐观锁（清单勾选）
 * ============================================================================
 * 决策：C1 已决 —— **走乐观锁**（不是悲观锁、不是分布式锁）。
 *
 * 为什么清单勾选用乐观锁而非悲观锁：
 *   勾选是「低冲突、高频、容忍重试」的写。悲观锁（SELECT ... FOR UPDATE）
 *   会让同桌两个人同时勾不同物品时互相阻塞 —— 冲突概率极低，阻塞代价却恒定。
 *
 * 语义：
 *   UPDATE ... SET checked=?, version=version+1
 *    WHERE id=? AND version=?  AND deleted_at IS NULL
 *   → 影响行数 0 ⇒ 版本已变 → 抛 409（VERSION_CONFLICT）
 *
 * 🔴 关键不变量：**version 由 DB 递增，不由应用计算**。
 *    若应用读 v 再写 v+1，两个并发请求都读到 v，都会写 v+1 —— 乐观锁形同虚设。
 */

import { ErrorCode, AppError } from '../errors/error-code.js';

/** 乐观锁冲突 → 统一 409（ErrorCode.VERSION_CONFLICT=4090） */
export class OptimisticLockError extends AppError {
  constructor(
    readonly entity: string,
    readonly expectedVersion: number,
  ) {
    super(
      ErrorCode.VERSION_CONFLICT,
      `内容已更新，请刷新后重试（${entity} 期望版本 v${expectedVersion}）`,
    );
    this.name = 'OptimisticLockError';
  }
}

/**
 * CAS 更新结果判定。
 *
 * @param affectedRows 驱动返回的影响行数
 * @throws OptimisticLockError 当 0 行受影响（版本不符或行已被删）
 *
 * ⚠️ 0 行有两种成因：① 版本被并发改动；② 行已被软删。
 *    对客户端而言处置一致（都是「请刷新」），故合并为同一个 409。
 */
export function assertCasSucceeded(
  affectedRows: number,
  entity: string,
  expectedVersion: number,
): void {
  if (affectedRows !== 1) {
    throw new OptimisticLockError(entity, expectedVersion);
  }
}

/** CAS 更新入参（供 Repository 使用） */
export interface CasUpdateInput {
  id: bigint;
  /** 客户端携带的版本号（来自上次读取） */
  expectedVersion: number;
  /** 要更新的字段（不含 version，由实现自增） */
  patch: Record<string, unknown>;
  /** 期望的租约：作用域字段，防止跨作用域串改 */
  scope?: { tripId?: bigint; ownerId?: bigint };
}

/**
 * 构造 CAS 更新的 WHERE 片段 —— 单点收敛，避免各仓储各写一份写错。
 */
export function buildCasWhere(input: CasUpdateInput): Record<string, unknown> {
  const where: Record<string, unknown> = {
    id: input.id,
    version: input.expectedVersion,
    deletedAt: null,
  };
  if (input.scope?.tripId !== undefined) where.tripId = input.scope.tripId;
  if (input.scope?.ownerId !== undefined) where.ownerId = input.scope.ownerId;
  return where;
}

/**
 * 版本号校验（入参层）。
 *
 * 客户端必须显式携带 version；缺失即拒 —— 否则「不带 version 的写入」会绕过乐观锁，
 * 变成无保护的盲写。
 */
export function requireVersion(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new AppError(
      ErrorCode.VALIDATION_FAILED,
      '缺少或非法的 version（乐观锁要求写入必须携带当前版本号）',
      { field: 'version' },
    );
  }
  return n;
}

/**
 * 幂等 + 乐观锁的组合语义（E7 + §7 幂等）。
 *
 * 顺序很重要：
 *   1. 先走幂等闸 —— 重复 requestId 直接回放首次结果，**不进 CAS**。
 *      （否则重试会因 version 已变而误报 409，用户体验变成「明明没改也冲突」）
 *   2. 幂等闸放行后，才做 CAS。
 */
export interface WriteGuardResult {
  /** 是否需要真正执行写入 */
  execute: boolean;
  /** 幂等回放的结果（execute=false 时有效） */
  replay?: unknown;
}

/** 幂等 store 的最小接口（避免与 idempotency.ts 循环依赖） */
export interface MinimalIdempotencyStore {
  acquire(
    key: string,
    ttlSeconds: number,
  ): Promise<
    { kind: 'ACQUIRED' } | { kind: 'REPLAY'; record: { result?: unknown } } | { kind: 'IN_PROGRESS' }
  >;
}

/** 判定本次请求是否应进入 CAS 写入（供域 handler 复用） */
export async function shouldExecuteWrite(
  store: MinimalIdempotencyStore | null,
  key: string | null,
): Promise<WriteGuardResult> {
  if (store === null || key === null) return { execute: true };
  const acquired = await store.acquire(key, 24 * 60 * 60);
  if (acquired.kind === 'REPLAY') return { execute: false, replay: acquired.record.result };
  // IN_PROGRESS 也交给上层抛 4091（与 idempotency.ts 一致）
  return { execute: true };
}
