/**
 * outfit 域 · service（个人穿搭 —— PRIVATE 短路域）
 * ============================================================================
 * 与 item 域同属 PRIVATE：**不回落家庭维度**。
 *
 * 关联完整性约束：
 *   `outfit_item.item_id` 只能指向**同一 owner** 的 item。
 *   否则会出现「A 的穿搭里塞了 B 的物品」—— 既是数据脏乱，
 *   也是私有边界的隐性泄漏（B 的物品名会通过 A 的穿搭暴露）。
 *   本实现于写入时校验 owner 一致。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface OutfitServiceOptions {
  ctx: DomainContext;
}

const OUTFIT_BIGINT_FIELDS = ['id', 'familyId', 'ownerId', 'tripId'];

export class OutfitService {
  constructor(private readonly o: OutfitServiceOptions) {}

  async create(userId: bigint, input: {
    familyId: bigint;
    name: string;
    note?: string;
    tripId?: bigint;
    ownerId?: bigint;
    itemIds: string[];
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const ownerId = input.ownerId ?? userId;
      if (ownerId !== userId) await this.assertCanActForOwner(tx, input.familyId, userId, ownerId);

      const now = await tx.db.dbNow();
      const id = tx.write.nextId();

      await tx.db.insert('outfit', {
        id,
        familyId: input.familyId,
        ownerId,
        tripId: input.tripId ?? null,
        name: input.name,
        note: input.note ?? null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.replaceItems(tx, id, ownerId, input.itemIds);
      await this.change(tx, 'outfit', id, input.familyId, input.tripId ?? null, 'INSERT', now);

      return this.withItems(this.o.ctx, id, ownerId);
    });
  }

  async list(userId: bigint, q: {
    familyId?: bigint;
    tripId?: bigint;
    mineOnly: boolean;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: Array<Record<string, unknown> & { itemCount: number }>; meta: Record<string, unknown> }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const myOwnerIds = new Set<bigint>([userId]);
    if (!q.mineOnly) {
      const managed = await this.o.ctx.read.findMany('familyMember', { where: { managedBy: userId, deletedAt: null } });
      for (const m of managed) myOwnerIds.add(m['id'] as bigint);
    }

    const all = await this.o.ctx.read.findMany('outfit', { where: { deletedAt: null } });
    let rows = all.filter((r) => myOwnerIds.has(r['ownerId'] as bigint));
    if (q.familyId !== undefined) rows = rows.filter((r) => r['familyId'] === q.familyId);
    if (q.tripId !== undefined) rows = rows.filter((r) => r['tripId'] === q.tripId);

    rows = [...rows].sort((a, b) => timeOf(b['createdAt']) - timeOf(a['createdAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    // 附带搭配明细数量（列表页不必返回全部物品，只给 count）
    const links = await this.o.ctx.read.findMany('outfitItem', { where: { deletedAt: null } });
    const items = slice.map((r) => ({
      ...serializeRow(r, OUTFIT_BIGINT_FIELDS),
      itemCount: links.filter((l) => l['outfitId'] === r['id']).length,
    }));

    return { items, meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown> };
  }

  async detail(userId: bigint, outfitId: bigint): Promise<Record<string, unknown>> {
    const r = await this.o.ctx.read.findUnique('outfit', { id: outfitId, deletedAt: null });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertOwnerAccess(this.o.ctx, r, userId);
    return this.withItems(this.o.ctx, outfitId, r['ownerId'] as bigint);
  }

  async update(userId: bigint, outfitId: bigint, patch: {
    version: number;
    name?: string;
    note?: string | null;
    tripId?: string | null;
    itemIds?: string[];
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('outfit', { id: outfitId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertOwnerAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.name !== undefined) data['name'] = patch.name;
      if (patch.note !== undefined) data['note'] = patch.note;
      if (patch.tripId !== undefined) data['tripId'] = patch.tripId === null ? null : BigInt(patch.tripId);

      const affected = await tx.db.update('outfit', { id: outfitId, version: patch.version, deletedAt: null }, data);
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该穿搭已被修改，请刷新后重试');
      }

      if (patch.itemIds !== undefined) {
        await this.replaceItems(tx, outfitId, r['ownerId'] as bigint, patch.itemIds);
      }

      await this.change(tx, 'outfit', outfitId, r['familyId'] as bigint, (r['tripId'] ?? null) as bigint | null, 'UPDATE', now);
      return this.withItems(tx, outfitId, r['ownerId'] as bigint);
    });
  }

  async remove(userId: bigint, outfitId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('outfit', { id: outfitId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertOwnerAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('outfit', { id: outfitId }, { deletedAt: now, updatedAt: now });

      // 连带软删搭配明细（否则残链会在重建时复用旧的 item 关系）
      const links = await tx.db.findMany('outfitItem', { where: { outfitId, deletedAt: null } });
      for (const l of links) {
        await tx.db.update('outfitItem', { id: l['id'] }, { deletedAt: now });
      }

      await this.change(tx, 'outfit', outfitId, r['familyId'] as bigint, (r['tripId'] ?? null) as bigint | null, 'DELETE', now);
      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 全量替换搭配明细。
   *
   * 🔴 校验每个 item 与 outfit **同 owner** —— 防止跨 owner 引用
   *    把别人的私有物品暴露到自己穿搭里。
   */
  private async replaceItems(
    tx: TxHandle,
    outfitId: bigint,
    ownerId: bigint,
    itemIds: string[],
  ): Promise<void> {
    const now = await tx.db.dbNow();

    const old = await tx.db.findMany('outfitItem', { where: { outfitId, deletedAt: null } });
    for (const l of old) {
      await tx.db.update('outfitItem', { id: l['id'] }, { deletedAt: now });
    }

    let sort = 0;
    for (const raw of itemIds) {
      const itemId = BigInt(raw);
      const item = await tx.db.findUnique('item', { id: itemId, deletedAt: null });
      if (!item) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      if (item['ownerId'] !== ownerId) {
        // 跨 owner 引用 —— 一律当「不存在」处理，不透露该 item 属于谁
        throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      }
      await tx.db.insert('outfitItem', {
        id: tx.write.nextId(),
        outfitId,
        itemId,
        sort: sort++,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }
  }

  /** 组装 outfit + 明细（可接受 tx 或只读 ctx） */
  private async withItems(
    src: TxHandle | DomainContext,
    outfitId: bigint,
    _ownerId: bigint,
  ): Promise<Record<string, unknown>> {
    const db = 'db' in src ? src.db : src.read;
    const r = await db.findUnique('outfit', { id: outfitId });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

    const links = await db.findMany('outfitItem', { where: { outfitId, deletedAt: null } });
    const items: Array<Record<string, unknown>> = [];
    for (const l of links.sort((a, b) => Number(a['sort'] ?? 0) - Number(b['sort'] ?? 0))) {
      const it = await db.findUnique('item', { id: l['itemId'], deletedAt: null });
      if (it) items.push(serializeRow(it, ['id', 'familyId', 'ownerId']));
    }

    return { ...serializeRow(r, OUTFIT_BIGINT_FIELDS), items };
  }

  private async assertOwnerAccess(src: TxHandle | DomainContext, r: Row, userId: bigint): Promise<void> {
    const ownerId = (r['ownerId'] ?? null) as bigint | null;
    if (ownerId === userId) return;

    const db = 'db' in src ? src.db : src.read;
    if (ownerId !== null) {
      const managed = await db.findMany('familyMember', { where: { id: ownerId, managedBy: userId, deletedAt: null } });
      if (managed.length > 0) return;
    }
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async assertCanActForOwner(
    tx: TxHandle,
    familyId: bigint,
    actorId: bigint,
    ownerId: bigint,
  ): Promise<void> {
    const mem = await tx.db.findMany('familyMember', {
      where: { id: ownerId, familyId, managedBy: actorId, deletedAt: null },
    });
    if (mem.length > 0) return;
    throw new AppError(ErrorCode.FORBIDDEN, '只能为自己或代管成员维护穿搭');
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

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
