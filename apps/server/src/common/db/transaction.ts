/**
 * 事务封装（技术方案 §1.1 · common/ 公共层要求「事务」；§2.4 错误码 5005）
 * ---------------------------------------------------------------------------
 * 背景（派发单 §2.4）：
 *   `5005 TX_QUOTA_EXCEEDED` —— 跨表事务超限，**已退化为「单笔事务 + reconcile」**。
 *   即：不追求一个超级跨表大事务，而是拆成若干单表/小事务，
 *   失败时通过 reconcile（对账补偿）保证最终一致。
 *
 * 设计要点：
 *   1. 事务执行器由调用方注入（`TxRunner`），本模块不绑定具体 ORM，
 *      以便 v1.4 落 Prisma 时以 `prisma.$transaction` 实现，测试期用内存实现。
 *   2. 事务**边界内禁止**做网络 I/O（如汇率抓取、KMS 调用）—— 会拉长锁持有时间、
 *      放大 5005 概率。红线：KMS 解密可在事务内（本地），但抓汇率不行。
 *   3. 盲索引与加密列**必须同事务**写入（红线 3），故二者共用一个 tx。
 */

/** 事务句柄：对上层不透明，由具体 ORM 适配层解释 */
export interface TxContext {
  /** 承载具体 ORM 的事务客户端；v1.4 落 Prisma 时为 Prisma.TransactionClient */
  readonly client: unknown;
}

/**
 * 事务执行器：把「一个使用 TxContext 的函数」放进真实事务里跑。
 * v1.4 用 Prisma 实现示例：
 *   const runner: TxRunner = (fn) => prisma.$transaction((tx) => fn({ client: tx }));
 */
export type TxRunner = <T>(fn: (ctx: TxContext) => Promise<T>) => Promise<T>;

/** 跨表事务超限（对应 ErrorCode.TX_QUOTA_EXCEEDED=5005） */
export class TxQuotaExceededError extends Error {
  readonly code = 5005;
  constructor(message = '跨表事务超限') {
    super(message);
    this.name = 'TxQuotaExceededError';
  }
}

/** 判定「是否是事务超限错误」——各 DB 驱动报错文案不一，集中在此处收敛 */
export function isTxQuotaExceeded(err: unknown): boolean {
  if (err instanceof TxQuotaExceededError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // MySQL/Prisma 常见文案：too many ... in a single transaction / max ... transaction
  return /too many|transaction.*(limit|exceed)|max.*transaction|1205|1213/i.test(msg);
}

/**
 * 事务内禁止的副作用类型（用于静态审查/运行期护栏）。
 * 事务内一旦出现这些，拉长锁持有时间 → 触发 5005。
 */
export const FORBIDDEN_IN_TX = [
  '网络 I/O（汇率抓取 / 第三方 API）',
  'KMS 远程加解密（本地解密除外）',
  '文件上传 / COS 读写',
  '长耗时计算（大于 100ms 的 CPU 密集）',
] as const;

/**
 * 在事务里执行；若因跨表超限失败，**降级为单笔事务 + reconcile**。
 *
 * 降级策略（派发单 §2.4）：
 *   1. 先尝试整体事务
 *   2. 命中 5005 → 调用方提供的 `singleShot` 用单笔事务逐个写
 *   3. 写完后调用 `reconcile` 做对账补偿，修正可能的不一致
 *
 * @param runner     事务执行器
 * @param body       整体事务体
 * @param onDegrade  降级回调：单笔事务 + 对账。缺省则直接抛出 5005。
 */
export async function withTransaction<T>(
  runner: TxRunner,
  body: (ctx: TxContext) => Promise<T>,
  onDegrade?: {
    singleShot: (ctx: TxContext) => Promise<T>;
    reconcile: (result: T) => Promise<void>;
  },
): Promise<T> {
  try {
    return await runner(body);
  } catch (err) {
    if (!isTxQuotaExceeded(err) || onDegrade === undefined) throw err;
    const result = await runner(onDegrade.singleShot);
    await onDegrade.reconcile(result);
    return result;
  }
}
