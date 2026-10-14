/**
 * item 域 · service（个人物品库 —— **PRIVATE 短路域**）
 * ============================================================================
 * 🔴 本域是「PRIVATE 短路」的典型受害面：
 *   物品库是**个人隐私**，即使同住一个家庭也不该互见。
 *
 *   错误实现：`WHERE family_id = ?` —— 这是**越权**（家庭维度泄漏）。
 *   正确实现：`WHERE owner_id = U OR managed_by = U`，且**不回落**家庭维度。
 *
 *   本文件所有读路径都强制 owner 过滤，写路径先校验 owner 归属。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface ItemServiceOptions {
  ctx: DomainContext;
}

const ITEM_BIGINT_FIELDS = ['id', 'familyId', 'ownerId'];

export class ItemService {
  constructor(private readonly o: ItemServiceOptions) {}

  /** 新增个人物品 */
  async create(
    userId: bigint,
    input: {
      familyId: bigint;
      name: string;
      category?: string;
      quantity: number;
      note?: string;
      ownerId?: bigint;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const ownerId = input.ownerId ?? userId;
      if (ownerId !== userId) {
        await this.assertCanActForOwner(tx, input.familyId, userId, ownerId);
      }
      const now = await tx.db.dbNow();
      const id = tx.write.nextId();

      await tx.db.insert('item', {
        id,
        familyId: input.familyId,
        ownerId,
        name: input.name,
        category: input.category ?? null,
        quantity: input.quantity,
        note: input.note ?? null,
        // M-Client-2：CAS 版本起值 1（与 mock / checklist A19 口径一致）
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'item', id, input.familyId, null, 'INSERT', now);
      const row = await tx.db.findUnique('item', { id });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  /**
   * 列表 —— **私有短路**。
   *
   * `mineOnly = true`（默认）：只返回 owner = 我 的
   * `mineOnly = false`：返回 owner = 我 **或** 我代管的（虚拟成员）
   *
   * ⛔ 任何情况下都**不**返回其他家庭成员的个人物品。
   */
  async list(
    userId: bigint,
    q: {
      familyId?: bigint;
      category?: string;
      mineOnly: boolean;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const page = normalizePageQuery(q.page, q.pageSize);

    // 我可见的 owner 集合（PRIVATE 短路口径）
    const myOwnerIds = new Set<bigint>([userId]);
    if (!q.mineOnly) {
      const managed = await this.o.ctx.read.findMany('familyMember', {
        where: { managedBy: userId, deletedAt: null },
      });
      for (const m of managed) myOwnerIds.add(m['id'] as bigint);
      const tripManaged = await this.o.ctx.read.findMany('tripMember', {
        where: { managedBy: userId, deletedAt: null },
      });
      for (const m of tripManaged) myOwnerIds.add(m['id'] as bigint);
    }

    const all = await this.o.ctx.read.findMany('item', { where: { deletedAt: null } });
    let rows = all.filter((r) => myOwnerIds.has(r['ownerId'] as bigint));
    if (q.familyId !== undefined) rows = rows.filter((r) => r['familyId'] === q.familyId);
    if (q.category !== undefined) rows = rows.filter((r) => r['category'] === q.category);

    rows = [...rows].sort((a, b) => timeOf(b['createdAt']) - timeOf(a['createdAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    return {
      items: slice.map((r) => serializeRow(r, ITEM_BIGINT_FIELDS)),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  async detail(userId: bigint, itemId: bigint): Promise<Record<string, unknown>> {
    const r = await this.o.ctx.read.findUnique('item', { id: itemId, deletedAt: null });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertOwnerAccess(this.o.ctx, r, userId);
    return serializeRow(r, ITEM_BIGINT_FIELDS);
  }

  async update(
    userId: bigint,
    itemId: bigint,
    patch: {
      version: number;
      name?: string;
      category?: string | null;
      quantity?: number;
      note?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('item', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertOwnerAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.name !== undefined) data['name'] = patch.name;
      if (patch.category !== undefined) data['category'] = patch.category;
      if (patch.quantity !== undefined) data['quantity'] = patch.quantity;
      if (patch.note !== undefined) data['note'] = patch.note;

      const affected = await tx.db.update(
        'item',
        { id: itemId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该物品已被修改，请刷新后重试');
      }

      await this.change(tx, 'item', itemId, r['familyId'] as bigint, null, 'UPDATE', now);
      const row = await tx.db.findUnique('item', { id: itemId });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  async remove(userId: bigint, itemId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('item', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertOwnerAccess(tx, r, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('item', { id: itemId }, { deletedAt: now, updatedAt: now });
      await this.change(tx, 'item', itemId, r['familyId'] as bigint, null, 'DELETE', now);
      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * PRIVATE 短路口径的访问校验。
   * ⛔ 不回落到家庭维度 —— 这是本域的存在意义。
   */
  private async assertOwnerAccess(
    src: TxHandle | DomainContext,
    r: Row,
    userId: bigint,
  ): Promise<void> {
    const ownerId = (r['ownerId'] ?? null) as bigint | null;
    if (ownerId === userId) return;

    const db = 'db' in src ? src.db : src.read;
    if (ownerId !== null) {
      const managed = await db.findMany('familyMember', {
        where: { id: ownerId, managedBy: userId, deletedAt: null },
      });
      if (managed.length > 0) return;
      const tripManaged = await db.findMany('tripMember', {
        where: { id: ownerId, managedBy: userId, deletedAt: null },
      });
      if (tripManaged.length > 0) return;
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
    throw new AppError(ErrorCode.FORBIDDEN, '只能为自己或代管成员维护个人物品');
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
