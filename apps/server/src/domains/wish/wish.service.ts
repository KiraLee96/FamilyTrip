/**
 * wish 域 · service
 * ============================================================================
 * 职责：家庭心愿池 —— 创建 / 编辑 / 投票 / 转出行草稿。
 *
 * 🔴 投票计数的并发陷阱：
 *   `wish.vote_count` 是**冗余计数**，真值在 `wish_vote` 表。
 *   朴素做法 `vote_count = vote_count + 1` 会在并发下丢更新（读改写竞态）。
 *   本实现：先写 `wish_vote`（唯一键 `uk_wish_user` 兜底幂等），
 *   再由**事务内重新 COUNT** 回写 `vote_count` —— 即「以明细为准」，
 *   计数只是物化视图，最终一致。
 *   同时 `vote_count_synced_at` 记录同步时刻，便于对账。
 *
 * 🔴 心愿 → 出行草稿的原子性：
 *   建 trip + 改 wish 状态 + 写权限成员 必须同事务。中途失败会留下
 *   「心愿已 PLANNED 但没有对应出行」的悬空引用。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { stringCell } from '../../common/db/row-key.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface WishServiceOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
}

const WISH_BIGINT_FIELDS = ['id', 'familyId', 'tripId', 'createdBy'];
const TRIP_BIGINT_FIELDS = ['id', 'familyId', 'createdBy', 'leaderId'];

export class WishService {
  private readonly retentionDays: number;

  constructor(private readonly o: WishServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 创建心愿 */
  async create(userId: bigint, input: {
    familyId: bigint;
    tripId?: bigint;
    title: string;
    description?: string;
    priority: number;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertFamilyMember(tx, input.familyId, userId);
      const now = await tx.db.dbNow();

      const id = tx.write.nextId();
      await tx.db.insert('wish', {
        id,
        familyId: input.familyId,
        tripId: input.tripId ?? null,
        createdBy: userId,
        title: input.title,
        description: input.description ?? null,
        status: 'WANT',
        voteCount: 0,
        voteCountSyncedAt: now,
        priority: input.priority,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'wish', id, input.familyId, input.tripId ?? null, 'INSERT', now);

      const row = await tx.db.findUnique('wish', { id });
      return serializeRow(row ?? {}, WISH_BIGINT_FIELDS);
    });
  }

  /** 心愿列表（家庭维度） */
  async list(userId: bigint, q: {
    familyId?: bigint;
    tripId?: bigint;
    status?: string;
    unplannedOnly?: boolean;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: { votedByMe: boolean; }[]; meta: Record<string, unknown>; }> {
    const page = normalizePageQuery(q.page, q.pageSize);

    // 先确定「我可见的家庭范围」
    const myFamilies = await this.visibleFamilyIds(userId);
    const familyIds = q.familyId !== undefined ? [...myFamilies].filter((f) => f === q.familyId) : [...myFamilies];
    if (q.familyId !== undefined && familyIds.length === 0) {
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }

    const all = await this.o.ctx.read.findMany('wish', { where: { deletedAt: null } });
    let rows = all.filter((w) => familyIds.some((f) => f === w['familyId']));
    if (q.tripId !== undefined) rows = rows.filter((w) => w['tripId'] === q.tripId);
    if (q.status !== undefined) rows = rows.filter((w) => w['status'] === q.status);
    if (q.unplannedOnly === true) rows = rows.filter((w) => w['tripId'] === null || w['tripId'] === undefined);

    // 排序：优先级降序 → 创建时间升序
    rows = [...rows].sort((a, b) => {
      const pd = Number(b['priority'] ?? 0) - Number(a['priority'] ?? 0);
      if (pd !== 0) return pd;
      return timeOf(a['createdAt']) - timeOf(b['createdAt']);
    });

    const votes = await this.o.ctx.read.findMany('wishVote', { where: { deletedAt: null } });
    const slice = rows.slice(page.skip, page.skip + page.take);

    const items = slice.map((w) => ({
      ...serializeRow(w, WISH_BIGINT_FIELDS),
      /** 当前用户是否已投票 —— 客户端高亮用 */
      votedByMe: votes.some((v) => v['wishId'] === w['id'] && v['userId'] === userId),
    }));

    return { items, meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown> };
  }

  /** 心愿详情 */
  async detail(userId: bigint, wishId: bigint): Promise<{ wish: { votedByMe: boolean; }; voteCount: number; }> {
    const w = await this.o.ctx.read.findUnique('wish', { id: wishId, deletedAt: null });
    if (!w) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertFamilyMember(this.o.ctx, w['familyId'] as bigint, userId);

    const votes = await this.o.ctx.read.findMany('wishVote', { where: { wishId, deletedAt: null } });
    return {
      wish: {
        ...serializeRow(w, WISH_BIGINT_FIELDS),
        votedByMe: votes.some((v) => v['userId'] === userId),
      },
      voteCount: votes.length,
    };
  }

  /** 更新心愿 */
  async update(userId: bigint, wishId: bigint, patch: {
    title?: string;
    description?: string | null;
    status?: string;
    priority?: number;
    tripId?: string | null;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const w = await tx.db.findUnique('wish', { id: wishId, deletedAt: null });
      if (!w) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const familyId = w['familyId'] as bigint;
      await this.assertFamilyMember(tx, familyId, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.description !== undefined) data['description'] = patch.description;
      if (patch.status !== undefined) data['status'] = patch.status;
      if (patch.priority !== undefined) data['priority'] = patch.priority;
      if (patch.tripId !== undefined) data['tripId'] = patch.tripId === null ? null : BigInt(patch.tripId);

      await tx.db.update('wish', { id: wishId }, data);
      await this.change(tx, 'wish', wishId, familyId, (w['tripId'] as bigint | null) ?? null, 'UPDATE', now);

      const row = await tx.db.findUnique('wish', { id: wishId });
      return serializeRow(row ?? {}, WISH_BIGINT_FIELDS);
    });
  }

  /** 删除心愿（创建者或户主） */
  async remove(userId: bigint, wishId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const w = await tx.db.findUnique('wish', { id: wishId, deletedAt: null });
      if (!w) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const familyId = w['familyId'] as bigint;

      const isCreator = w['createdBy'] === userId;
      if (!isCreator) await this.assertFamilyOwner(tx, familyId, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('wish', { id: wishId }, { deletedAt: now, updatedAt: now });
      // 连带撤销该心愿的所有投票（明细表也要软删，否则 COUNT 会算到已删心愿上）
      const votes = await tx.db.findMany('wishVote', { where: { wishId, deletedAt: null } });
      for (const v of votes) {
        await tx.db.update('wishVote', { id: v['id'] }, { deletedAt: now });
      }

      await this.change(tx, 'wish', wishId, familyId, (w['tripId'] as bigint | null) ?? null, 'DELETE', now);
      return now;
    });
  }

  /**
   * 投票 / 取消投票。
   *
   * 幂等语义：
   *   · `vote=true` 且未投过 → 插入明细
   *   · `vote=true` 且已投过 → 无操作（幂等）
   *   · `vote=false` 且已投过 → 软删明细
   *   · `vote=false` 且未投过 → 无操作（幂等）
   *
   * 计数回写：事务内重新 COUNT，避免「读改写」竞态丢更新。
   */
  async vote(userId: bigint, wishId: bigint, on: boolean): Promise<{ wishId: string; voteCount: number; votedByMe: boolean; }> {
    return this.o.ctx.tx(async (tx) => {
      const w = await tx.db.findUnique('wish', { id: wishId, deletedAt: null });
      if (!w) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const familyId = w['familyId'] as bigint;
      await this.assertFamilyMember(tx, familyId, userId);

      const now = await tx.db.dbNow();
      const existing = await tx.db.findUnique('wishVote', { wishId, userId, deletedAt: null });

      if (on && !existing) {
        await tx.db.insert('wishVote', {
          id: tx.write.nextId(),
          wishId,
          userId,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
      } else if (!on && existing) {
        await tx.db.update('wishVote', { id: existing['id'] }, { deletedAt: now, updatedAt: now });
      }

      // 以明细为准重新计数（物化视图回写）
      const count = await this.countVotes(tx, wishId);
      await tx.db.update('wish', { id: wishId }, { voteCount: count, voteCountSyncedAt: now, updatedAt: now });

      await this.change(tx, 'wish', wishId, familyId, (w['tripId'] as bigint | null) ?? null, 'UPDATE', now);

      return { wishId: wishId.toString(), voteCount: count, votedByMe: on };
    });
  }

  /**
   * 心愿 → 出行草稿（v0.1 验收路径第 6 步）。
   *
   * 原子性要求（同事务）：
   *   1. 建 trip（status=DRAFT）
   *   2. 把选中心愿 status → PLANNED 且 tripId → 新 trip
   *   3. 建 trip_member（创建者 = LEADER + ACTIVE）
   */
  async toTripDraft(userId: bigint, input: {
    familyId: bigint;
    wishIds?: bigint[];
    title?: string;
    startDate?: string;
    endDate?: string;
    timezone?: string;
  }): Promise<{ trip: Record<string, unknown>; promotedWishIds: string[]; }> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertFamilyMember(tx, input.familyId, userId);
      const now = await tx.db.dbNow();

      // 选出要固化的心愿
      const allWishes = await tx.db.findMany('wish', { where: { deletedAt: null } });
      let picked = allWishes.filter((w) => w['familyId'] === input.familyId);
      if (input.wishIds && input.wishIds.length > 0) {
        picked = picked.filter((w) => input.wishIds!.some((id) => id === w['id']));
        if (picked.length !== input.wishIds.length) {
          throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
        }
      } else {
        picked = picked.filter((w) => w['status'] === 'WANT');
      }
      if (picked.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, '没有可转为出行的心愿');
      }

      // 1. 建出行草稿
      const tripId = tx.write.nextId();
      const title = input.title ?? deriveTripTitle(picked);
      await tx.db.insert('trip', {
        id: tripId,
        familyId: input.familyId,
        createdBy: userId,
        leaderId: userId,
        title,
        status: 'DRAFT',
        startDate: input.startDate ? new Date(`${input.startDate}T00:00:00.000Z`) : null,
        endDate: input.endDate ? new Date(`${input.endDate}T00:00:00.000Z`) : null,
        timezone: input.timezone ?? 'Asia/Shanghai',
        destinationsJson: null,
        actualJson: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      // 2. 心愿批量转 PLANNED 并挂到新出行
      for (const w of picked) {
        await tx.db.update('wish', { id: w['id'] }, { status: 'PLANNED', tripId, updatedAt: now });
        await this.change(tx, 'wish', w['id'] as bigint, input.familyId, tripId, 'UPDATE', now);
      }

      // 3. 创建者作为 LEADER 成员
      const memberId = tx.write.nextId();
      await tx.db.insert('tripMember', {
        id: memberId,
        tripId,
        userId,
        managedBy: null,
        role: 'LEADER',
        isExternal: false,
        accessLevel: 'ACTIVE',
        displayName: await this.displayNameOf(tx, userId),
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'trip', tripId, input.familyId, tripId, 'INSERT', now);

      await this.audit(tx, {
        actorId: userId,
        action: 'wish.to_trip_draft',
        reason: 'WISH_PROMOTED_TO_TRIP',
        severity: 'INFO',
        targetId: tripId,
        detail: { wishCount: picked.length, wishIds: picked.map((w) => String(w['id'])) },
        at: now,
      });

      const trip = await tx.db.findUnique('trip', { id: tripId });
      return {
        trip: serializeRow(trip ?? {}, TRIP_BIGINT_FIELDS),
        promotedWishIds: picked.map((w) => String(w['id'])),
      };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async countVotes(tx: TxHandle, wishId: bigint): Promise<number> {
    const votes = await tx.db.findMany('wishVote', { where: { wishId, deletedAt: null } });
    return votes.length;
  }

  private async visibleFamilyIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('familyMember', { where: { userId, deletedAt: null } });
    const managed = await this.o.ctx.read.findMany('familyMember', { where: { managedBy: userId, deletedAt: null } });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['familyId'] as bigint);
    for (const m of managed) s.add(m['familyId'] as bigint);
    return s;
  }

  private async assertFamilyMember(tx: TxHandle | DomainContext, familyId: bigint, userId: bigint): Promise<void> {
    const db = 'db' in tx ? tx.db : tx.read;
    const m = await db.findUnique('familyMember', { familyId, userId, deletedAt: null });
    if (m) return;
    const managed = await db.findMany('familyMember', { where: { familyId, managedBy: userId, deletedAt: null } });
    if (managed.length === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async assertFamilyOwner(tx: TxHandle, familyId: bigint, userId: bigint): Promise<void> {
    const o = await tx.db.findUnique('familyMember', { familyId, userId, role: 'OWNER', deletedAt: null });
    if (!o) throw new AppError(ErrorCode.FORBIDDEN, '仅户主可执行该操作');
  }

  private async displayNameOf(tx: TxHandle, userId: bigint): Promise<string> {
    const u = await tx.db.findUnique('user', { id: userId, deletedAt: null });
    return (u?.['nickname'] as string | undefined) ?? '成员';
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

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
      targetId: bigint;
      detail?: Record<string, unknown>;
      at: Date;
    },
  ): Promise<void> {
    await tx.db.insert('auditLog', {
      id: tx.write.nextId(),
      actorId: e.actorId,
      action: e.action,
      reason: e.reason,
      severity: e.severity,
      retainUntil: new Date(e.at.getTime() + this.retentionDays * 86_400_000),
      targetType: 'trip',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 出行标题：取前 2 个心愿拼「XX之旅」 */
function deriveTripTitle(wishes: Row[]): string {
  const names = wishes.slice(0, 2).map((w) => stringCell(w, 'title') ?? '').filter(Boolean);
  return names.length > 0 ? `${names.join('·')} 之旅` : '新的出行';
}
