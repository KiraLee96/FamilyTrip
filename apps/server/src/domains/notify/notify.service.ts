/**
 * notify 域 · service
 * ============================================================================
 * 职责：提醒任务 + 微信订阅消息授权登记。
 *
 * 设计要点：
 *
 * 🔴 提醒时间用**接收人的本地时区**
 *   `remind_at` 存本地时间 + `tz` 字段。调度器到点时按 `tz` 判定是否该推。
 *   为什么不统一存 UTC：用户设「早上 7 点」，跨夏令时/出差改时区后
 *   他想表达的是「当地 7 点」。存 UTC 会漂成「凌晨 2 点」。
 *
 * 🔴 订阅消息的**额度**语义（微信约束）
 *   `remain_count` 是剩余可推送次数。微信一次性订阅：用户授权 1 次 = 可推 1 条。
 *   推送成功后必须**扣减**，否则超出额度会被微信拒绝（43101）。
 *   计数归零 → `status = EXPIRED`。
 *
 * 🔴 发送是**外部 I/O**，禁止在事务内
 *   本 service 只负责「写入待发送记录 + 状态机」，实际推送由调度器
 *   在事务外调用微信 API，再用一个短事务回写 `status=sent`。
 *   这正是 `common/db/transaction.ts` 里 `FORBIDDEN_IN_TX` 的落地场景。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { bigIntCell, bigIntCellOrNull, stringCell } from '../../common/db/row-key.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface NotifyServiceOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
}

const REMINDER_BIGINT_FIELDS = ['id', 'receiverId', 'createdBy', 'tripId', 'subscriptionId'];
const SUB_BIGINT_FIELDS = ['id', 'userId'];

export class NotifyService {
  constructor(private readonly o: NotifyServiceOptions) {}

  /** 建提醒 */
  async createReminder(userId: bigint, input: {
    receiverId: bigint;
    tripId?: bigint;
    subscriptionId?: bigint;
    title: string;
    content?: string;
    remindAt: string;
    tz?: string;
    delivery: 'NORMAL' | 'TODO_ONLY';
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertCanActForReceiver(tx, userId, input.receiverId);

      const now = await tx.db.dbNow();
      const tz = input.tz ?? (await this.timezoneOf(tx, input.receiverId));
      const id = tx.write.nextId();

      await tx.db.insert('reminderTask', {
        id,
        receiverId: input.receiverId,
        createdBy: userId,
        tripId: input.tripId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        title: input.title,
        content: input.content ?? null,
        remindAt: parseLocal(input.remindAt),
        tz,
        channel: 'SUBSCRIBE',
        delivery: input.delivery,
        mergedGroupId: null,
        status: 'PENDING',
        readAt: null,
        sentAt: null,
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'reminder_task', id, null, input.tripId ?? null, 'INSERT', now);
      const row = await tx.db.findUnique('reminderTask', { id });
      return serializeRow(row ?? {}, REMINDER_BIGINT_FIELDS);
    });
  }

  /** 提醒列表 */
  async listReminders(userId: bigint, q: {
    receiverId?: bigint;
    tripId?: bigint;
    status?: string;
    dueOnly?: boolean;
    from?: string;
    to?: string;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown>; }> {
    const page = normalizePageQuery(q.page, q.pageSize);

    // 可见范围：我创建的 ∨ 发给我的 ∨ 我代管的人收到的
    const myReceiverIds = new Set<bigint>([userId]);
    const managed = await this.o.ctx.read.findMany('familyMember', { where: { managedBy: userId, deletedAt: null } });
    for (const m of managed) myReceiverIds.add(m['id'] as bigint);

    const all = await this.o.ctx.read.findMany('reminderTask', { where: { deletedAt: null } });
    let rows = all.filter(
      (r) => r['createdBy'] === userId || myReceiverIds.has(r['receiverId'] as bigint),
    );
    if (q.receiverId !== undefined) rows = rows.filter((r) => r['receiverId'] === q.receiverId);
    if (q.tripId !== undefined) rows = rows.filter((r) => r['tripId'] === q.tripId);
    if (q.status !== undefined) rows = rows.filter((r) => r['status'] === q.status);
    if (q.dueOnly === true) rows = rows.filter((r) => r['status'] === 'PENDING');
    if (q.from !== undefined) rows = rows.filter((r) => localYmd(r['remindAt']) >= q.from!);
    if (q.to !== undefined) rows = rows.filter((r) => localYmd(r['remindAt']) <= q.to!);

    rows = [...rows].sort((a, b) => timeOf(a['remindAt']) - timeOf(b['remindAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    return {
      items: slice.map((r) => serializeRow(r, REMINDER_BIGINT_FIELDS)),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  async updateReminder(userId: bigint, reminderId: bigint, patch: {
    version: number;
    title?: string;
    content?: string | null;
    remindAt?: string;
    tz?: string;
    delivery?: 'NORMAL' | 'TODO_ONLY';
    status?: string;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('reminderTask', { id: reminderId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertReminderAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.content !== undefined) data['content'] = patch.content;
      if (patch.remindAt !== undefined) data['remindAt'] = parseLocal(patch.remindAt);
      if (patch.tz !== undefined) data['tz'] = patch.tz;
      if (patch.delivery !== undefined) data['delivery'] = patch.delivery;
      if (patch.status !== undefined) data['status'] = patch.status;

      await tx.db.update('reminderTask', { id: reminderId }, data);
      await this.change(tx, 'reminder_task', reminderId, null, (r['tripId'] ?? null) as bigint | null, 'UPDATE', now);

      const row = await tx.db.findUnique('reminderTask', { id: reminderId });
      return serializeRow(row ?? {}, REMINDER_BIGINT_FIELDS);
    });
  }

  async removeReminder(userId: bigint, reminderId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('reminderTask', { id: reminderId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertReminderAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('reminderTask', { id: reminderId }, { deletedAt: now, updatedAt: now });
      await this.change(tx, 'reminder_task', reminderId, null, (r['tripId'] ?? null) as bigint | null, 'DELETE', now);
      return now;
    });
  }

  /** 批量标记已读 */
  async markRead(userId: bigint, ids: string[]): Promise<{ updated: number; readAt: string; }> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      let updated = 0;
      for (const raw of ids) {
        const id = BigInt(raw);
        const r = await tx.db.findUnique('reminderTask', { id, deletedAt: null });
        if (!r) continue;
        // 只能是接收人本人标记已读
        if (r['receiverId'] !== userId) continue;
        await tx.db.update('reminderTask', { id }, { readAt: now, updatedAt: now });
        updated += 1;
      }
      return { updated, readAt: now.toISOString() };
    });
  }

  /**
   * 登记订阅消息授权（微信 `requestSubscribeMessage` 回调）。
   *
   * 幂等：同 (userId, templateId) 存在则更新剩余额度与状态，不新增行。
   * `uk_user_tpl` 复合唯一键兜底。
   */
  async registerSubscription(userId: bigint, input: {
    templateId: string;
    status: 'GRANTED' | 'EXPIRED' | 'REVOKED';
    expireAt?: string;
    remainCount?: number;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const existing = await tx.db.findUnique('notifySubscription', { userId, templateId: input.templateId, deletedAt: null });

      if (existing) {
        await tx.db.update(
          'notifySubscription',
          { id: existing['id'] },
          {
            status: input.status,
            grantedAt: input.status === 'GRANTED' ? now : (existing['grantedAt'] ?? null),
            expireAt: input.expireAt !== undefined ? new Date(input.expireAt) : (existing['expireAt'] ?? null),
            remainCount: input.remainCount ?? (existing['remainCount'] ?? null),
            updatedAt: now,
          },
        );
        const row = await tx.db.findUnique('notifySubscription', { id: existing['id'] });
        return serializeRow(row ?? {}, SUB_BIGINT_FIELDS);
      }

      const id = tx.write.nextId();
      await tx.db.insert('notifySubscription', {
        id,
        userId,
        templateId: input.templateId,
        status: input.status,
        grantedAt: input.status === 'GRANTED' ? now : null,
        expireAt: input.expireAt !== undefined ? new Date(input.expireAt) : null,
        remainCount: input.remainCount ?? (input.status === 'GRANTED' ? 1 : 0),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const row = await tx.db.findUnique('notifySubscription', { id });
      return serializeRow(row ?? {}, SUB_BIGINT_FIELDS);
    });
  }

  /** 查我的订阅授权状态 */
  async listSubscriptions(userId: bigint): Promise<{ items: Record<string, unknown>[]; }> {
    const rows = await this.o.ctx.read.findMany('notifySubscription', { where: { userId, deletedAt: null } });
    return { items: rows.map((r) => serializeRow(r, SUB_BIGINT_FIELDS)) };
  }

  /**
   * 取待发送提醒（供调度器调用，事务外执行实际推送）。
   *
   * 返回的是「候选集」，调度器推送成功后应调用 `markSent` 回写。
   */
  async dueReminders(limit = 100): Promise<{ items: Record<string, unknown>[]; serverTime: string; }> {
    const now = await this.o.ctx.read.dbNow();
    const rows = await this.o.ctx.read.findMany('reminderTask', { where: { status: 'PENDING', deletedAt: null } });
    const due = rows
      .filter((r) => r['delivery'] === 'NORMAL')
      .filter((r) => timeOf(r['remindAt']) <= now.getTime())
      .sort((a, b) => timeOf(a['remindAt']) - timeOf(b['remindAt']))
      .slice(0, limit);

    // 附带接收人的订阅状态（调度器据此决定能否推送）
    const out: Array<Record<string, unknown>> = [];
    for (const r of due) {
      const subs = await this.o.ctx.read.findMany('notifySubscription', {
        where: { userId: r['receiverId'], deletedAt: null },
      });
      const usable = subs.find((s) => s['status'] === 'GRANTED' && Number(s['remainCount'] ?? 0) > 0);
      out.push({
        ...serializeRow(r, REMINDER_BIGINT_FIELDS),
        canPush: usable !== undefined,
        subscriptionId: usable !== undefined ? bigIntCell(usable, 'id').toString() : null,
        templateId: (usable?.['templateId']) ?? null,
      });
    }
    return { items: out, serverTime: now.toISOString() };
  }

  /**
   * 回写发送结果（调度器推送后调用）。
   *
   * ⚠️ 这是**外部 I/O 完成后**的短事务，绝不能在推送前就标 SENT ——
   *    否则推送失败会永久丢失（没有重试入口）。
   *    失败时 `retry_count += 1`，超过阈值转 FAILED。
   */
  async markSent(reminderId: bigint, success: boolean, error?: string): Promise<{ status: string; retryCount: number; error: string | null; }> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('reminderTask', { id: reminderId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const now = await tx.db.dbNow();
      const retryCount = Number(r['retryCount'] ?? 0) + (success ? 0 : 1);
      const maxRetry = 3;

      await tx.db.update(
        'reminderTask',
        { id: reminderId },
        {
          status: success ? 'SENT' : retryCount >= maxRetry ? 'FAILED' : 'PENDING',
          sentAt: success ? now : null,
          retryCount,
          updatedAt: now,
        },
      );

      // 成功推送 → 扣减订阅额度（微信一次性订阅语义）
      if (success && r['subscriptionId'] !== null && r['subscriptionId'] !== undefined) {
        const sub = await tx.db.findUnique('notifySubscription', { id: r['subscriptionId'] });
        if (sub) {
          const left = Math.max(0, Number(sub['remainCount'] ?? 0) - 1);
          await tx.db.update(
            'notifySubscription',
            { id: sub['id'] },
            { remainCount: left, status: left === 0 ? 'EXPIRED' : String(sub['status']), updatedAt: now },
          );
        }
      }

      await this.change(tx, 'reminder_task', reminderId, null, (r['tripId'] ?? null) as bigint | null, 'UPDATE', now);

      return {
        status: success ? 'SENT' : retryCount >= maxRetry ? 'FAILED' : 'PENDING',
        retryCount,
        error: error ?? null,
      };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async assertCanActForReceiver(tx: TxHandle, actorId: bigint, receiverId: bigint): Promise<void> {
    if (receiverId === actorId) return;
    const m = await tx.db.findMany('familyMember', { where: { id: receiverId, managedBy: actorId, deletedAt: null } });
    if (m.length > 0) return;
    const t = await tx.db.findMany('tripMember', { where: { id: receiverId, managedBy: actorId, deletedAt: null } });
    if (t.length > 0) return;
    // 允许给同一家庭的成员设提醒（协作场景）
    const recv = await tx.db.findUnique('familyMember', { id: receiverId, deletedAt: null });
    if (recv) {
      const meSameFamily = await tx.db.findUnique('familyMember', {
        familyId: recv['familyId'],
        userId: actorId,
        deletedAt: null,
      });
      if (meSameFamily) return;
    }
    throw new AppError(ErrorCode.FORBIDDEN, '只能为自己或同家庭成员设置提醒');
  }

  private async assertReminderAccess(tx: TxHandle, r: Row, userId: bigint): Promise<void> {
    if (r['createdBy'] === userId || r['receiverId'] === userId) return;
    const managed = await tx.db.findMany('familyMember', {
      where: { id: r['receiverId'], managedBy: userId, deletedAt: null },
    });
    if (managed.length > 0) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async timezoneOf(tx: TxHandle, userId: bigint): Promise<string> {
    const u = await tx.db.findUnique('user', { id: userId, deletedAt: null });
    const tz = u === null ? undefined : stringCell(u, 'homeTimezone');
    if (tz) return tz;
    // 虚拟成员没有 user 行 → 取其代管人的时区
    const fm = await tx.db.findUnique('familyMember', { id: userId, deletedAt: null });
    const mgr = fm === null ? null : bigIntCellOrNull(fm, 'managedBy');
    if (mgr) {
      const mu = await tx.db.findUnique('user', { id: mgr, deletedAt: null });
      const muTz = mu === null ? undefined : stringCell(mu, 'homeTimezone');
      if (muTz) return muTz;
    }
    return 'Asia/Shanghai';
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    familyId: bigint | null,
    tripId: bigint | null,
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId,
      tripId,
      op,
      changedAt: at,
      createdAt: at,
    });
  }
}

function parseLocal(s: string): Date {
  return new Date(`${s}:00.000Z`);
}

function localYmd(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
