/**
 * checklist 域 · service
 * ============================================================================
 * 清单是**双语义**表。本文件的核心复杂度都来自这一点。
 *
 * 🔴 双语义（chk_tci_scope_owner 约束）
 *   ```
 *   scope = SHARED   → owner_id IS NULL   （全员共用）
 *   scope = PERSONAL → owner_id IS NOT NULL（个人专属）
 *   ```
 *   写路径强制该不变式；读路径按 `resolveChecklistDomain` 分流：
 *   PERSONAL 走 PRIVATE 短路（仅 owner/代管可见），SHARED 走出行维度。
 *
 * 🔴 E7 · 勾选必须 CAS
 *   「出行前夫妻俩同时勾清单」是最高频的并发场景。
 *   朴素实现 `UPDATE ... SET checked = true` 会**静默覆盖**
 *   「另一个端刚勾的、你还没看到的结果」。
 *   CAS 把静默覆盖变成显式 409，客户端可提示「有人刚改过，已为你刷新」。
 *
 * 🔴 D5 · 私有项折叠
 *   共享清单视图里，别人有 PERSONAL 项时：
 *   · 不逐条返回 —— 每人最多 1 条占位
 *   · 不返回数量、不返回 name、不返回 owner_id 之外的任何字段
 *   · ownerDisplayName 仅取家庭成员公开昵称
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row, TableDriver } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import {
  buildLockedPlaceholders,
  resolveChecklistDomain,
  AccessDomain,
} from '../../common/auth/access-policy.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface ChecklistServiceOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
}

const ITEM_BIGINT_FIELDS = ['id', 'tripId', 'templateId', 'ownerId', 'createdBy', 'checkedBy'];
const TEMPLATE_BIGINT_FIELDS = ['id', 'familyId', 'ownerId'];

/**
 * 从「读上下文」或「事务句柄」中取出表驱动。
 *
 * `DomainContext` 暴露 `read`，`TxHandle` 暴露 `db` —— 名字不同但都是 `TableDriver`。
 * 收敛成一个函数，避免每个断言各写一次类型强转（强转写错就是运行时 500）。
 */
function driverOf(src: TxHandle | DomainContext): TableDriver {
  return 'db' in src ? src.db : src.read;
}

/**
 * 读双语义表的 `scope` 列并归一化成 `string | undefined`。
 *
 * `Row` 的值是 `unknown`，直接 `String(...)` 会把非 string 值变成 `"[object Object]"`
 * 并当作合法 scope 传给 `resolveChecklistDomain` —— 那会导致域判定错乱
 * （私有项被当共享项放行）。这里只接受真正的 string。
 */
function scopeOf(row: Row): string | undefined {
  const raw = row['scope'];
  return typeof raw === 'string' ? raw : undefined;
}

/** 读行里某个应当为字符串的单元格；非 string 一律当缺失（避免 `"[object Object]"`）。 */
function stringCell(row: Row, field: string): string | undefined {
  const raw = row[field];
  return typeof raw === 'string' ? raw : undefined;
}

export class ChecklistService {
  private readonly retentionDays: number;

  constructor(private readonly o: ChecklistServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 新增清单项（强制 scope/owner 不变式） */
  async createItem(userId: bigint, input: {
    tripId: bigint;
    familyId: bigint;
    name: string;
    quantity: number;
    sort: number;
    scope: 'SHARED' | 'PERSONAL';
    ownerId?: bigint;
    templateId?: bigint;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      // 不变式：SHARED ⇒ owner_id 必须为空；PERSONAL ⇒ 必须有 owner
      const ownerId = input.scope === 'PERSONAL' ? (input.ownerId ?? userId) : null;
      if (input.scope === 'PERSONAL' && ownerId === null) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'PERSONAL 清单项必须指定 ownerId');
      }
      // PERSONAL 项只能给自己或自己代管的虚拟成员建
      if (input.scope === 'PERSONAL' && ownerId !== userId) {
        await this.assertCanActForOwner(tx, input.familyId, userId, ownerId!);
      }

      const now = await tx.db.dbNow();
      const id = tx.write.nextId();
      await tx.db.insert('tripChecklistItem', {
        id,
        tripId: input.tripId,
        templateId: input.templateId ?? null,
        scope: input.scope,
        ownerId,
        createdBy: userId,
        name: input.name,
        quantity: input.quantity,
        checked: false,
        checkedBy: null,
        checkedAt: null,
        sort: input.sort,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'trip_checklist_item', id, input.familyId, input.tripId, 'INSERT', now);

      const row = await tx.db.findUnique('tripChecklistItem', { id });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  /**
   * 清单列表。
   *
   * 🔴 私有项处理：
   *   · 自己的 PERSONAL 项 → 正常返回
   *   · 别人的 PERSONAL 项 → **不返回内容**，折叠成 per-owner 占位
   *   · 空闲 owner 不足 1 条占位的也产出（表示「他确实有私有项」但不泄露数量）
   */
  async list(userId: bigint, q: {
    tripId?: bigint;
    familyId?: bigint;
    scope?: 'SHARED' | 'PERSONAL';
    checked?: boolean;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{
    items: unknown[];
    meta: Record<string, unknown>;
    myPrivateCount: number;
    lockedPlaceholderCount: number;
  }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const visibleTrips = await this.visibleTripIds(userId);

    const all = await this.o.ctx.read.findMany('tripChecklistItem', { where: { deletedAt: null } });
    let rows = all.filter((r) => visibleTrips.has(r['tripId'] as bigint));
    if (q.tripId !== undefined) rows = rows.filter((r) => r['tripId'] === q.tripId);
    if (q.familyId !== undefined) {
      // 清单项无 familyId，借 trip 关联过滤（trip 数量有限，先建索引再过滤）
      const trips = await this.o.ctx.read.findMany('trip', { where: { deletedAt: null } });
      const tripIdsOfFamily = new Set(
        trips.filter((t) => t['familyId'] === q.familyId).map((t) => t['id'] as bigint),
      );
      rows = rows.filter((r) => tripIdsOfFamily.has(r['tripId'] as bigint));
    }
    if (q.scope !== undefined) rows = rows.filter((r) => r['scope'] === q.scope);
    if (q.checked !== undefined) rows = rows.filter((r) => (r['checked'] === true) === q.checked);

    // 分流可见性
    const visible: Row[] = [];
    const hiddenOwners = new Set<bigint>();
    for (const r of rows) {
      const domain = resolveChecklistDomain({
        scope: scopeOf(r),
        ownerId: (r['ownerId'] ?? null) as bigint | null,
      });
      if (domain === AccessDomain.Private) {
        const owner = (r['ownerId'] ?? null) as bigint | null;
        const managed = owner === null ? false : await this.isManagedBy(userId, owner);
        if (owner !== userId && !managed) {
          if (owner !== null) hiddenOwners.add(owner);
          continue; // 别人的私有项：跳过，稍后折叠成占位
        }
      }
      visible.push(r);
    }

    const sorted = [...visible].sort((a, b) => Number(a['sort'] ?? 0) - Number(b['sort'] ?? 0));
    const slice = sorted.slice(page.skip, page.skip + page.take);

    const items = slice.map((r) => serializeRow(r, ITEM_BIGINT_FIELDS));

    // D5：折叠占位（每人最多 1 条，无任何私有字段）
    // 先把 owner 的公开昵称查出来（buildLockedPlaceholders 是同步函数）
    const nameCache = new Map<bigint, string | null>();
    for (const oid of hiddenOwners) {
      const m = await this.o.ctx.read.findUnique('familyMember', { userId: oid, deletedAt: null });
      nameCache.set(oid, (m?.['displayName'] as string | undefined) ?? null);
    }
    const lockedPlaceholders = buildLockedPlaceholders(
      hiddenOwners,
      (oid) => nameCache.get(oid) ?? null,
      userId,
    );

    return {
      items: [...items, ...lockedPlaceholders],
      meta: buildPageMeta(page, sorted.length) as unknown as Record<string, unknown>,
      /** 私有项统计 —— 仅本人可见的数量，不暴露他人 */
      myPrivateCount: visible.filter((r) => r['ownerId'] === userId).length,
      /** ⚠️ 占位数量（不含任何私有内容），对齐 D5 口径 */
      lockedPlaceholderCount: lockedPlaceholders.length,
    };
  }

  /** 单项详情 */
  async detailItem(userId: bigint, itemId: bigint): Promise<Record<string, unknown>> {
    const r = await this.o.ctx.read.findUnique('tripChecklistItem', { id: itemId, deletedAt: null });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertItemVisible(this.o.ctx, r, userId);
    return serializeRow(r, ITEM_BIGINT_FIELDS);
  }

  /**
   * 勾选 / 取消勾选 —— **CAS 强制**（E7）。
   *
   * 🔴 0 行受影响 = 有人在你读到之后改过 → 409。
   *    错误信息要明确告知「请刷新」，而不是含糊的「操作失败」。
   */
  async toggle(userId: bigint, itemId: bigint, input: { version: number; checked: boolean }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('tripChecklistItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertItemWritable(tx.db, r, userId);

      const expectedVersion = input.version;
      const now = await tx.db.dbNow();

      const affected = await tx.db.update(
        'tripChecklistItem',
        { id: itemId, version: expectedVersion, deletedAt: null },
        {
          checked: input.checked,
          checkedBy: input.checked ? userId : null,
          checkedAt: input.checked ? now : null,
          version: expectedVersion + 1,
          updatedAt: now,
        },
      );

      if (affected === 0) {
        throw new AppError(
          ErrorCode.VERSION_CONFLICT,
          '该清单项已被他人修改（可能刚被勾选），请刷新后重试',
        );
      }

      await this.change(tx, 'trip_checklist_item', itemId, null, r['tripId'] as bigint, 'UPDATE', now);

      const row = await tx.db.findUnique('tripChecklistItem', { id: itemId });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  /**
   * 批量勾选 —— 逐项 CAS。
   *
   * 语义：**部分成功**也提交，返回每项结果。
   * 为什么不做「全有全无」：用户连勾 5 项，其中 1 项被别人先勾了，
   * 不应让另外 4 项也失败 —— 那是惩罚用户。
   */
  async batchToggle(userId: bigint, input: { items: Array<{ id: string; version: number; checked: boolean }> }): Promise<{ results: { id: string; ok: boolean; error?: { code: number; message: string; }; item?: Record<string, unknown>; }[]; succeeded: number; failed: number; }> {
    const results: Array<{
      id: string;
      ok: boolean;
      error?: { code: number; message: string };
      item?: Record<string, unknown>;
    }> = [];

    for (const it of input.items) {
      try {
        const item = await this.toggle(userId, BigInt(it.id), { version: it.version, checked: it.checked });
        results.push({ id: it.id, ok: true, item });
      } catch (e) {
        const err = e as { code?: number; message?: string };
        results.push({
          id: it.id,
          ok: false,
          error: { code: err.code ?? ErrorCode.INTERNAL_ERROR, message: err.message ?? '操作失败' },
        });
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  /** 改清单项（CAS） */
  async updateItem(userId: bigint, itemId: bigint, patch: {
    version: number;
    name?: string;
    quantity?: number;
    sort?: number;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('tripChecklistItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertItemWritable(tx.db, r, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.name !== undefined) data['name'] = patch.name;
      if (patch.quantity !== undefined) data['quantity'] = patch.quantity;
      if (patch.sort !== undefined) data['sort'] = patch.sort;

      const affected = await tx.db.update(
        'tripChecklistItem',
        { id: itemId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该清单项已被他人修改，请刷新后重试');
      }

      await this.change(tx, 'trip_checklist_item', itemId, null, r['tripId'] as bigint, 'UPDATE', now);
      const row = await tx.db.findUnique('tripChecklistItem', { id: itemId });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  /** 删除清单项 */
  async removeItem(userId: bigint, itemId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('tripChecklistItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertItemWritable(tx.db, r, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('tripChecklistItem', { id: itemId }, { deletedAt: now, updatedAt: now });
      await this.change(tx, 'trip_checklist_item', itemId, null, r['tripId'] as bigint, 'DELETE', now);
      return now;
    });
  }

  // ── 模板 ────────────────────────────────────────────────

  /** 建模板 */
  async createTemplate(userId: bigint, input: {
    familyId?: bigint;
    name: string;
    scope: 'SHARED' | 'PERSONAL';
    ownerId?: bigint;
    items: Array<{ name: string; quantity: number }>;
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();

      if (input.scope === 'PERSONAL') {
        const owner = input.ownerId ?? userId;
        await this.assertCanActForOwner(tx, input.familyId ?? null, userId, owner);
      }

      const id = tx.write.nextId();
      await tx.db.insert('checklistTemplate', {
        id,
        familyId: input.familyId ?? null,
        scope: input.scope,
        ownerId: input.scope === 'PERSONAL' ? (input.ownerId ?? userId) : null,
        name: input.name,
        itemsJson: JSON.stringify(input.items),
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const row = await tx.db.findUnique('checklistTemplate', { id });
      return serializeRow(row ?? {}, TEMPLATE_BIGINT_FIELDS);
    });
  }

  /** 列模板（共享 + 自己的私有） */
  async listTemplates(userId: bigint, familyId?: bigint): Promise<{ items: Record<string, unknown>[]; }> {
    const all = await this.o.ctx.read.findMany('checklistTemplate', { where: { deletedAt: null } });
    const visible = all.filter((t) => {
      const domain = resolveChecklistDomain({
        scope: scopeOf(t),
        ownerId: (t['ownerId'] ?? null) as bigint | null,
      });
      if (domain === AccessDomain.Private) return t['ownerId'] === userId;
      if (familyId !== undefined) return t['familyId'] === familyId || t['familyId'] === null;
      return true;
    });
    return { items: visible.map((t) => serializeRow(t, TEMPLATE_BIGINT_FIELDS)) };
  }

  /**
   * 从模板套用到出行 —— 批量建清单项。
   *
   * 幂等保护：同一 (templateId, tripId) 已有项时不重复套用，
   * 除非显式允许（避免用户连点两次按钮产生双倍清单）。
   */
  async applyTemplate(userId: bigint, input: { templateId: bigint; tripId: bigint; familyId: bigint }): Promise<{ created: number; skipped: number; alreadyApplied: boolean; }> {
    return this.o.ctx.tx(async (tx) => {
      const tpl = await tx.db.findUnique('checklistTemplate', { id: input.templateId, deletedAt: null });
      if (!tpl) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      // PERSONAL 模板只能套给自己
      if (tpl['scope'] === 'PERSONAL' && tpl['ownerId'] !== userId) {
        throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      }

      const existing = await tx.db.findMany('tripChecklistItem', {
        where: { tripId: input.tripId, templateId: input.templateId, deletedAt: null },
      });
      if (existing.length > 0) {
        return { created: 0, skipped: existing.length, alreadyApplied: true };
      }

      const items = JSON.parse(stringCell(tpl, 'itemsJson') ?? '[]') as Array<{ name: string; quantity: number }>;
      const now = await tx.db.dbNow();

      let sort = 0;
      for (const it of items) {
        const id = tx.write.nextId();
        await tx.db.insert('tripChecklistItem', {
          id,
          tripId: input.tripId,
          templateId: input.templateId,
          scope: tpl['scope'],
          ownerId: tpl['scope'] === 'PERSONAL' ? (tpl['ownerId']) : null,
          createdBy: userId,
          name: it.name,
          quantity: it.quantity ?? 1,
          checked: false,
          checkedBy: null,
          checkedAt: null,
          sort: sort++,
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        await this.change(tx, 'trip_checklist_item', id, input.familyId, input.tripId, 'INSERT', now);
      }

      return { created: items.length, skipped: 0, alreadyApplied: false };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 可见性复核（读路径）。
   *
   * 🔴 这里必须做**驱动归一**：`DomainContext` 把驱动叫 `read`，
   *    `TxHandle` 把它叫 `db`。早先的实现直接 `src as TxHandle` 再访问 `tx.db`，
   *    在读路径上传进来的 `DomainContext` 上会取到 `undefined` →
   *    `tx.db.findUnique` 抛 TypeError → 500。
   *    表现为「列表/详情接口偶发 500」，而写接口正常 —— 极难定位。
   */
  private async assertItemVisible(
    src: TxHandle | DomainContext,
    r: Row,
    userId: bigint,
  ): Promise<void> {
    await this.assertItemWritable(driverOf(src), r, userId, true);
  }

  private async assertItemWritable(
    db: TableDriver,
    r: Row,
    userId: bigint,
    readOnly = false,
  ): Promise<void> {
    const domain = resolveChecklistDomain({
      scope: scopeOf(r),
      ownerId: (r['ownerId'] ?? null) as bigint | null,
    });

    if (domain === AccessDomain.Private) {
      const owner = (r['ownerId'] ?? null) as bigint | null;
      if (owner === userId) return;
      if (owner !== null && (await this.isManagedBy(userId, owner))) return;
      // 私有短路：不回落到出行维度
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }

    // SHARED：出行成员可读写
    const m = await db.findUnique('tripMember', { tripId: r['tripId'], userId, deletedAt: null });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    if (!readOnly && m['accessLevel'] === 'HISTORICAL_READONLY') {
      throw new AppError(ErrorCode.FORBIDDEN, '该出行已归档，仅可查看');
    }
  }

  /** 是否由 userId 代管（虚拟成员场景） */
  private async isManagedBy(userId: bigint, ownerId: bigint): Promise<boolean> {
    const rows = await this.o.ctx.read.findMany('familyMember', {
      where: { id: ownerId, managedBy: userId, deletedAt: null },
    });
    if (rows.length > 0) return true;
    const tripRows = await this.o.ctx.read.findMany('tripMember', {
      where: { id: ownerId, managedBy: userId, deletedAt: null },
    });
    return tripRows.length > 0;
  }

  private async assertCanActForOwner(
    tx: TxHandle,
    familyId: bigint | null,
    actorId: bigint,
    ownerId: bigint,
  ): Promise<void> {
    if (ownerId === actorId) return;
    const familyRows = await tx.db.findMany('familyMember', {
      where: { id: ownerId, managedBy: actorId, deletedAt: null },
    });
    if (familyRows.length > 0) return;
    const tripRows = await tx.db.findMany('tripMember', {
      where: { id: ownerId, managedBy: actorId, deletedAt: null },
    });
    if (tripRows.length > 0) return;
    void familyId;
    throw new AppError(ErrorCode.FORBIDDEN, '只能为自己或代管成员创建个人清单');
  }

  private async assertTripWritable(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const m = await tx.db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (m) {
      if (m['accessLevel'] === 'HISTORICAL_READONLY') {
        throw new AppError(ErrorCode.FORBIDDEN, '该出行已归档，仅可查看');
      }
      return;
    }
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async visibleTripIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('tripMember', { where: { userId, deletedAt: null } });
    const managed = await this.o.ctx.read.findMany('tripMember', { where: { managedBy: userId, deletedAt: null } });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['tripId'] as bigint);
    for (const m of managed) s.add(m['tripId'] as bigint);
    return s;
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

/** 家庭过滤：清单项本身无 familyId，借 trip 关联 */
