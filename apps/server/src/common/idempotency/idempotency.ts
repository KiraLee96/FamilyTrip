/**
 * 幂等（技术方案 §7 / 派发单 §2.3）
 * ---------------------------------------------------------------------------
 * 写入接口统一支持幂等：同一 `requestId` 在 TTL（24h）内重复提交
 * 返回**首次结果**，不重复执行副作用。
 *
 * 幂等表在 v1.4 会给出关系型结构；本文件只定义**接口与语义**，
 * 仓储实现待v1.4 后注入。
 */

export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h

export type IdempotencyStatus = 'IN_PROGRESS' | 'DONE';

export interface IdempotencyRecord {
  requestId: string;
  /** 作用域：通常 `${method}:${path}:${userId}`，防止跨用户撞 key */
  scope: string;
  status: IdempotencyStatus;
  /** DONE 时为首次执行的结果信封 */
  result?: unknown;
  createdAt: Date;
  expiresAt: Date;
}

/** 幂等仓储 —— 生产用 MySQL（唯一索引 (scope, request_id)） */
export interface IdempotencyStore {
  /**
   * 尝试占位。
   * @returns `ACQUIRED` 占位成功；`REPLAY` 命中已完成记录；`IN_PROGRESS` 同key 正在执行
   */
  acquire(
    key: string,
    ttlSeconds: number,
  ): Promise<
    { kind: 'ACQUIRED' } | { kind: 'REPLAY'; record: IdempotencyRecord } | { kind: 'IN_PROGRESS' }
  >;
  /** 写入首次执行结果 */
  complete(key: string, result: unknown, ttlSeconds: number): Promise<void>;
  /** 执行失败时释放占位，允许客户端重试 */
  release(key: string): Promise<void>;
}

export type AcquireResult = { kind: 'RUN'; result: unknown } | { kind: 'REPLAY'; result: unknown };

export interface IdempotencyOptions {
  /** 幂等作用域；默认 `${method} ${path}#${userId}` */
  scope: string;
  requestId: string | undefined;
  store: IdempotencyStore;
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('同一 requestId 的请求正在处理中，请稍后重试');
    this.name = 'IdempotencyConflictError';
  }
}

/**
 * 包装一次写操作。
 *
 * - 未带 requestId → 直接执行（不启用幂等）
 * - 首次 → 执行并记录结果
 * - 重复且已完成 → 返回首次结果，**不重复执行副作用**
 * - 重复且执行中 → 抛冲突（不回放半成品）
 */
export async function withIdempotency<T>(
  options: IdempotencyOptions,
  fn: () => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<AcquireResult> {
  const { requestId, scope, store } = options;

  // 未带 requestId 即不启用幂等 —— 不做隐式生成，避免客户端误以为有幂等保护
  if (!requestId) return { kind: 'RUN', result: await fn() };

  const key = `${scope}::${requestId}`;
  const ttl = IDEMPOTENCY_TTL_SECONDS;

  const acquired = await store.acquire(key, ttl);

  if (acquired.kind === 'REPLAY') {
    return { kind: 'REPLAY', result: acquired.record.result };
  }
  if (acquired.kind === 'IN_PROGRESS') {
    throw new IdempotencyConflictError();
  }

  void now; // 时钟由 store 负责计算 expiresAt
  try {
    const result = await fn();
    await store.complete(key, result, ttl);
    return { kind: 'RUN', result };
  } catch (e) {
    // 失败不写记录，释放占位让客户端可重试
    await store.release(key);
    throw e;
  }
}

/** 内存实现 —— 单测与本地开发用；生产必须换 MySQL 唯一索引实现 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  acquire(
    key: string,
    ttlSeconds: number,
  ): Promise<
    { kind: 'ACQUIRED' } | { kind: 'REPLAY'; record: IdempotencyRecord } | { kind: 'IN_PROGRESS' }
  > {
    const existing = this.rows.get(key);
    const expired = existing ? existing.expiresAt.getTime() <= this.now().getTime() : false;

    // 未过期且存在 → 命中既有记录，不重新占位
    if (existing && !expired) {
      if (existing.status === 'DONE') {
        return Promise.resolve({ kind: 'REPLAY', record: existing });
      }
      return Promise.resolve({ kind: 'IN_PROGRESS' });
    }

    // 不存在，或已过期（先清场再重新占位）
    if (existing && expired) this.rows.delete(key);
    const createdAt = this.now();
    this.rows.set(key, {
      requestId: key,
      scope: key,
      status: 'IN_PROGRESS',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000),
    });
    return Promise.resolve({ kind: 'ACQUIRED' });
  }

  complete(key: string, result: unknown, ttlSeconds: number): Promise<void> {
    const row = this.rows.get(key);
    if (!row) return Promise.resolve();
    const createdAt = this.now();
    this.rows.set(key, {
      ...row,
      status: 'DONE',
      result,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + ttlSeconds * 1000),
    });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.rows.delete(key);
    return Promise.resolve();
  }

  /** 测试辅助：当前记录数 */
  get size(): number {
    return this.rows.size;
  }
}
