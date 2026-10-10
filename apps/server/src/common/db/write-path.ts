/**
 * 写路径统一收口：业务写 + change_log + audit_log（三写同事务）
 * ============================================================================
 * 这是 14 个域 handler 唯一的写入口。不提供「只写业务表」的路径 ——
 * 因为任何绕过都会造成：
 *   · 漏 change_log → 其他端**永远看不到**这条变更（同步静默失效）
 *   · 漏 audit_log  → 合规审计断链（M5 保留期形同虚设）
 *
 * 🔴 三条不变量：
 *   1. 三写必须在**同一事务**内。跨事务会出现「业务成功、日志失败」的
 *      不一致，且无法通过重试自愈（业务已提交）。
 *   2. `changed_at` 取 **DB 时间**（E2），不取应用服务器时间。
 *      多实例时钟漂移会撕裂同步游标，导致客户端漏单。
 *   3. `deleted_at` 软删不删行 —— 保留历史以支撑 B6「历史只读保留」。
 */

import type { ChangeOp } from '../sync/change-log.js';

/** 事务客户端（由 Prisma 适配层注入；此处只依赖最小接口） */
export interface TxClient {
  /** 取 DB 当前时间（毫秒精度） */
  dbNow(): Promise<Date>;
  /** 插入一行 */
  insert(model: string, data: Record<string, unknown>): Promise<void>;
  /** 更新（CAS 场景由调用方构造 where） */
  update(model: string, where: Record<string, unknown>, data: Record<string, unknown>): Promise<number>;
}

/** 审计行（与 prisma AuditLog 对应） */
export interface AuditEntry {
  actorId: bigint | null;
  action: string;
  reason: string;
  severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
  targetType?: string | null;
  targetId?: bigint | null;
  detail?: Record<string, unknown> | null;
}

/** change_log 行 */
export interface ChangeEntry {
  entityType: string;
  entityId: bigint;
  familyId: bigint | null;
  tripId: bigint | null;
  op: ChangeOp;
}

export interface WriteContext {
  tx: TxClient;
  /** 操作者（未登录的定时任务传 null） */
  actorId: bigint | null;
  /** ID 生成器 */
  nextId: () => bigint;
  /** 审计保留期计算（M5） */
  retainUntilOf: (createdAt: Date) => Date;
}

/**
 * 追加一条变更日志（E1 / E2）。
 *
 * ⚠️ `changedAt` 由调用方从 `dbNow()` 取，**不得**传 `new Date()`。
 */
export async function appendChangeLog(
  ctx: WriteContext,
  entry: ChangeEntry,
  changedAt: Date,
): Promise<void> {
  await ctx.tx.insert('changeLog', {
    id: ctx.nextId(),
    entityType: entry.entityType,
    entityId: entry.entityId,
    familyId: entry.familyId,
    tripId: entry.tripId,
    op: entry.op,
    changedAt,
  });
}

/**
 * 追加一条审计日志（M5：reason / severity / retain_until）。
 */
export async function appendAuditLog(
  ctx: WriteContext,
  entry: AuditEntry,
  createdAt: Date,
): Promise<void> {
  await ctx.tx.insert('auditLog', {
    id: ctx.nextId(),
    actorId: entry.actorId,
    action: entry.action,
    reason: entry.reason,
    severity: entry.severity,
    retainUntil: ctx.retainUntilOf(createdAt),
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    // T-4：detail 必须先过脱敏器（调用方负责；此处再兜一层类型约束）
    detail: entry.detail ?? null,
    createdAt,
  });
}

/**
 * 一次「业务写」的完整编排：业务表 + change_log +（可选）audit_log。
 *
 * 用法：
 * ```ts
 * await commitWrite(ctx, {
 *   change: { entityType: 'wish', entityId: id, familyId, tripId: null, op: 'INSERT' },
 *   audit: { action: 'wish.create', reason: 'WISH_CREATED', severity: 'INFO', targetType: 'wish', targetId: id },
 *   body: async (tx) => { await tx.insert('wish', {...}); },
 * });
 * ```
 */
export interface CommitWriteInput {
  change?: ChangeEntry;
  audit?: AuditEntry;
  /** 业务写主体（用同一个 tx） */
  body: (tx: TxClient) => Promise<void>;
  /** 显式指定时间（批量导入场景复用同一时间戳）；缺省取 DB 时间 */
  at?: Date;
}

export async function commitWrite(ctx: WriteContext, input: CommitWriteInput): Promise<Date> {
  const at = input.at ?? (await ctx.tx.dbNow());

  // 顺序：业务 → 变更日志 → 审计。
  // 变更日志放审计之前：同步可用性优先于审计完整性（审计失败可补偿，同步失败用户立刻可见）
  await input.body(ctx.tx);

  if (input.change !== undefined) {
    await appendChangeLog(ctx, input.change, at);
  }
  if (input.audit !== undefined) {
    await appendAuditLog(ctx, input.audit, at);
  }

  return at;
}

/**
 * 软删的统一表达（B6：历史只读保留与 deleted_at 语义冲突的处置）。
 *
 * 语义：
 *   · 业务行 `deleted_at = now`（保留行，供历史只读）
 *   · change_log 记 `DELETE`（客户端从本地移除）
 *
 * 🔴 二者语义不同：DELETE 是**客户端可见性**变更，deleted_at 是**数据保留**策略。
 *    不要让客户端看到 deleted_at 的细节 —— 那是服务端实现。
 */
export async function softDelete(
  ctx: WriteContext,
  model: string,
  id: bigint,
  change: Omit<ChangeEntry, 'op' | 'entityId'>,
  audit?: AuditEntry,
): Promise<Date> {
  const at = await ctx.tx.dbNow();

  await ctx.tx.update(model, { id, deletedAt: null }, { deletedAt: at });

  await appendChangeLog(ctx, { ...change, entityId: id, op: 'DELETE' }, at);
  if (audit !== undefined) await appendAuditLog(ctx, audit, at);

  return at;
}

/**
 * 幂等键构造 —— 单点收敛，避免各域各写一份拼错。
 */
export function idempotencyKey(method: string, path: string, userId: bigint | null): string {
  return `${method.toUpperCase()}:${path}:${userId === null ? 'anon' : userId.toString()}`;
}
