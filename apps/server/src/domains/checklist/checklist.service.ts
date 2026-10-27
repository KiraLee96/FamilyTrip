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

/** 模板条目（落库形态：`items_json` 里的数组元素） */
export interface TemplateItem {
  name: string;
  quantity: number;
}

/**
 * 「模板条目变更 → 同步到未成行行程」的结果（2026-10-27）。
 * 界面用它给用户一句话反馈，例如「已同步 2 场行程：新增 3 项、删除 1 项」。
 */
export interface TemplateSyncResult {
  /** 实际处理的行程数（只算未归档的） */
  trips: number;
  /** 补进行程的新条目数 */
  created: number;
  /** 数量被同步的条目数 */
  updated: number;
  /** 因模板删掉而同步软删的条目数 */
  removed: number;
  /** 模板删了但行程里已勾选、因此保留下来的条目数 */
  keptChecked: number;
}

/**
 * 把 `items_json` 归一化成条目数组（D-2026-10-26-01 P1-2）。
 *
 * 🔴 为什么读路径必须容三种形态：
 *   1. **数组** —— 本单之后写入的新形态（Prisma Json 列直接存数组）；
 *   2. **JSON 字符串** —— 本单之前 `createTemplate` 写的是 `JSON.stringify(items)`，
 *      而 `items_json` 是 MySQL **JSON 列**，于是落库成了「JSON 字符串」而不是数组，
 *      读回是 `"[{\"name\":...}]"`。存量行全是这个形态，不能当脏数据丢弃；
 *   3. **二次编码字符串** —— 历史数据若经手过两层序列化，`JSON.parse` 一次后
 *      仍是字符串，再解一次。
 *   任何解析失败一律回 `[]`：**一条脏数据不该让整页清单打不开**。
 */
export function parseTemplateItems(raw: unknown): TemplateItem[] {
  let value: unknown = raw;
  // 最多解两层：正常形态（数组）零次、存量形态一次、双重编码两次
  for (let depth = 0; depth < 2; depth += 1) {
    if (typeof value !== 'string') break;
    const text = value.trim();
    if (text === '') return [];
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  const out: TemplateItem[] = [];
  for (const it of value) {
    if (typeof it !== 'object' || it === null) continue;
    const row = it as Record<string, unknown>;
    const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
    if (name === '') continue;
    const qty = Number(row['quantity']);
    // quantity 非法（NaN / 越界）按 1 兜底：宁可少显示数量，不可整条丢失
    out.push({
      name: name.slice(0, 64),
      quantity: Number.isInteger(qty) && qty >= 1 && qty <= 9999 ? qty : 1,
    });
  }
  return out;
}

export class ChecklistService {
  private readonly retentionDays: number;

  constructor(private readonly o: ChecklistServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 新增清单项（强制 scope/owner 不变式） */
  async createItem(
    userId: bigint,
    input: {
      tripId: bigint;
      familyId: bigint;
      name: string;
      quantity: number;
      sort: number;
      scope: 'SHARED' | 'PERSONAL';
      /** TODO = 要做的事 / PACK = 要带的东西（2026-10-27 需求③） */
      kind?: 'TODO' | 'PACK';
      ownerId?: bigint;
      templateId?: bigint;
    },
  ): Promise<Record<string, unknown>> {
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
        kind: input.kind ?? 'PACK',
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
      return this.withChecklistAliases(serializeRow(row ?? {}, ITEM_BIGINT_FIELDS));
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
  async list(
    userId: bigint,
    q: {
      tripId?: bigint;
      familyId?: bigint;
      scope?: 'SHARED' | 'PERSONAL';
      /** 只看某一类：TODO 待办 / PACK 打包（2026-10-27 需求③） */
      kind?: 'TODO' | 'PACK';
      checked?: boolean;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{
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
    // 历史行没有 kind 列（迁移前写入的）→ 按默认值 PACK 处理，避免它们从两个分区里一起消失
    if (q.kind !== undefined)
      rows = rows.filter((r) => ((r['kind'] as string | null) ?? 'PACK') === q.kind);
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

    const items = slice.map((r) => this.withChecklistAliases(serializeRow(r, ITEM_BIGINT_FIELDS)));

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
    const r = await this.o.ctx.read.findUnique('tripChecklistItem', {
      id: itemId,
      deletedAt: null,
    });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertItemVisible(this.o.ctx, r, userId);
    return this.withChecklistAliases(serializeRow(r, ITEM_BIGINT_FIELDS));
  }

  /**
   * 勾选 / 取消勾选 —— **CAS 强制**（E7）。
   *
   * 🔴 0 行受影响 = 有人在你读到之后改过 → 409。
   *    错误信息要明确告知「请刷新」，而不是含糊的「操作失败」。
   */
  async toggle(
    userId: bigint,
    itemId: bigint,
    input: { version: number; checked: boolean },
  ): Promise<Record<string, unknown>> {
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

      await this.change(
        tx,
        'trip_checklist_item',
        itemId,
        null,
        r['tripId'] as bigint,
        'UPDATE',
        now,
      );

      const row = await tx.db.findUnique('tripChecklistItem', { id: itemId });
      return this.withChecklistAliases(serializeRow(row ?? {}, ITEM_BIGINT_FIELDS));
    });
  }

  /**
   * 批量勾选 —— 逐项 CAS。
   *
   * 语义：**部分成功**也提交，返回每项结果。
   * 为什么不做「全有全无」：用户连勾 5 项，其中 1 项被别人先勾了，
   * 不应让另外 4 项也失败 —— 那是惩罚用户。
   */
  async batchToggle(
    userId: bigint,
    input: { items: Array<{ id: string; version: number; checked: boolean }> },
  ): Promise<{
    results: {
      id: string;
      ok: boolean;
      error?: { code: number; message: string };
      item?: Record<string, unknown>;
    }[];
    succeeded: number;
    failed: number;
  }> {
    const results: Array<{
      id: string;
      ok: boolean;
      error?: { code: number; message: string };
      item?: Record<string, unknown>;
    }> = [];

    for (const it of input.items) {
      try {
        const item = await this.toggle(userId, BigInt(it.id), {
          version: it.version,
          checked: it.checked,
        });
        results.push({ id: it.id, ok: true, item: this.withChecklistAliases(item) });
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
  async updateItem(
    userId: bigint,
    itemId: bigint,
    patch: {
      version: number;
      name?: string;
      quantity?: number;
      sort?: number;
    },
  ): Promise<Record<string, unknown>> {
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

      await this.change(
        tx,
        'trip_checklist_item',
        itemId,
        null,
        r['tripId'] as bigint,
        'UPDATE',
        now,
      );
      const row = await tx.db.findUnique('tripChecklistItem', { id: itemId });
      return this.withChecklistAliases(serializeRow(row ?? {}, ITEM_BIGINT_FIELDS));
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
      await this.change(
        tx,
        'trip_checklist_item',
        itemId,
        null,
        r['tripId'] as bigint,
        'DELETE',
        now,
      );
      return now;
    });
  }

  // ── 模板 ────────────────────────────────────────────────

  /** 建模板 */
  async createTemplate(
    userId: bigint,
    input: {
      familyId?: bigint;
      name: string;
      scope: 'SHARED' | 'PERSONAL';
      ownerId?: bigint;
      items: Array<{ name: string; quantity: number }>;
    },
  ): Promise<Record<string, unknown>> {
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
        // 🔴 存**数组本身**，不存 `JSON.stringify(items)` 的结果。
        //    `items_json` 是 MySQL JSON 列：传字符串会落成「JSON 字符串标量」
        //    （读回 `"[{\"name\":...}]"`），前端与 applyTemplate 都要多解一层；
        //    传数组才落成 JSON array。存量行由 `parseTemplateItems` 兼容。
        itemsJson: input.items,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const row = await tx.db.findUnique('checklistTemplate', { id });
      return this.withTemplateItems(serializeRow(row ?? {}, TEMPLATE_BIGINT_FIELDS));
    });
  }

  /**
   * 列模板（共享 + 自己的私有）。
   *
   * 🔴 两处口径（D-2026-10-26-01 P1-2 顺带修复）：
   *   1. 回包补 `items` 数组，同时**保留** `itemsJson` 原始列 —— 纯加法，
   *      老客户端不受影响；否则每个客户端都要自己 `JSON.parse` + 容错一次。
   *   2. 共享模板按**用户所属家庭**过滤。此前用请求里传的 `familyId` 判定，
   *      而该值来自 query 且 handler 从未真正读到（`ctx.familyId` 在链上只对
   *      带 `:id` 的路由赋值）—— 结果是「任何家庭都能看到别人家的共享模板」。
   *      现在以 `familyMember` 关系为准，请求参数只作为附加收窄。
   *      `familyId` 为空的共享模板（未加入家庭时创建的）不携带任何家庭数据，
   *      维持可见，避免这类用户看不到自己刚建的清单。
   */
  async listTemplates(
    userId: bigint,
    familyId?: bigint,
  ): Promise<{ items: Record<string, unknown>[] }> {
    const all = await this.o.ctx.read.findMany('checklistTemplate', { where: { deletedAt: null } });
    const myFamilyIds = await this.familyIdsOf(userId);

    const visible = all.filter((t) => {
      const domain = resolveChecklistDomain({
        scope: scopeOf(t),
        ownerId: (t['ownerId'] ?? null) as bigint | null,
      });
      if (domain === AccessDomain.Private) {
        const owner = (t['ownerId'] ?? null) as bigint | null;
        if (owner !== userId) return false;
        return familyId === undefined || t['familyId'] === familyId || t['familyId'] === null;
      }
      const rowFamilyId = (t['familyId'] ?? null) as bigint | null;
      if (rowFamilyId === null) return true; // 孤儿共享模板：见上方第 2 条
      if (!myFamilyIds.has(rowFamilyId)) return false;
      return familyId === undefined || rowFamilyId === familyId;
    });

    return {
      items: visible.map((t) => this.withTemplateItems(serializeRow(t, TEMPLATE_BIGINT_FIELDS))),
    };
  }

  /**
   * 改模板（D-2026-10-26-01 P0-1）—— CAS 强制。
   *
   * 🔴 `items` 是**整体替换**语义：传什么存什么，少一条就是删一条。
   *    增量合并会让「删掉某条物品」永远无法表达，而用户的诉求恰恰是
   *    「今年不带了，从清单里去掉」。
   *
   * 🔴 `name` 与 `items` 至少一项（schema 层已拦），避免空 PATCH 白涨 version
   *    —— 那会让其它端的 CAS 全部失效（它们手里的 version 全是旧的）。
   */
  async updateTemplate(
    userId: bigint,
    templateId: bigint,
    patch: { version: number; name?: string; items?: TemplateItem[] },
  ): Promise<{
    template: Record<string, unknown>;
    updatedAt: Date;
    /** 条目同步结果（只在本次确实改了 items 时返回） */
    synced?: TemplateSyncResult;
  }> {
    return this.o.ctx.tx(async (tx) => {
      const tpl = await tx.db.findUnique('checklistTemplate', { id: templateId, deletedAt: null });
      if (!tpl) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTemplateWritable(tx, tpl, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.name !== undefined) data['name'] = patch.name;
      if (patch.items !== undefined) data['itemsJson'] = patch.items;

      // CAS：where 带 version，0 行受影响 = 有人在你读到之后改过
      const affected = await tx.db.update(
        'checklistTemplate',
        { id: templateId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(
          ErrorCode.VERSION_CONFLICT,
          '该清单已被他人修改（可能刚加了物品），请刷新后重试',
        );
      }

      /**
       * 🔴 条目变了 → 把变更同步到引用了这套清单、且**尚未成行**的行程。
       *    已完成/已取消的行程是历史快照，一律不回溯（用户口径：已完成的不用改）。
       *    同步在同一事务内，避免「模板改了、行程只同步了一半」。
       */
      const synced =
        patch.items !== undefined
          ? await this.syncTemplateToOpenTrips(tx, templateId, tpl, patch.items, userId, now)
          : null;

      await this.change(
        tx,
        'checklist_template',
        templateId,
        this.templateFamilyId(tpl),
        null,
        'UPDATE',
        now,
      );

      const row = await tx.db.findUnique('checklistTemplate', { id: templateId });
      return {
        template: this.withTemplateItems(serializeRow(row ?? {}, TEMPLATE_BIGINT_FIELDS)),
        updatedAt: now,
        ...(synced !== null ? { synced } : {}),
      };
    });
  }

  /**
   * 模板条目变更 → 同步到引用它的「尚未成行」行程
   * ============================================================================
   * 用户口径（2026-10-27）：「清单中已经修改了，引用过的行程 未成行的要同步改，
   * 已完成的就不用改了」。
   *
   * 同步范围：`trip.status ∈ {DRAFT, PLANNED, ONGOING}`。
   * FINISHED / CANCELLED 一律跳过 —— 那是历史快照，改了会让「已归档的回忆」变动。
   *
   * 逐条规则（模板是权威，但尊重行程里已有的操作）：
   *   ① 模板删掉的条目 → 行程里**未勾选**的软删；**已勾选**的保留（说明已打包，
   *      直接删掉会让人以为「我明明勾好了怎么没了」）；
   *   ② 模板新增的条目 → 行程里补一条未勾选项；
   *   ③ 模板改了数量 → 行程里同步数量，**勾选状态不动**；
   *   ④ 行程里 `templateId` 为空的自定义项 → 完全不动（那是本次出行专属的）；
   *   ⑤ 用户手动删过的项（库里有软删行）→ **不复活**（否则每次改模板都冒出来）。
   *
   * 🔴 为什么按 `name` 对齐而不是 id：模板条目在 `items_json` 里只有
   *    `{name, quantity}`，没有稳定标识。所以「模板里改名」在语义上等于
   *    「删掉旧名 + 新增新名」——旧项若未勾选会被删、新名会被补上，这是可接受的行为。
   */
  private async syncTemplateToOpenTrips(
    tx: TxHandle,
    templateId: bigint,
    tpl: Row,
    items: TemplateItem[],
    userId: bigint,
    now: Date,
  ): Promise<TemplateSyncResult> {
    const result: TemplateSyncResult = {
      trips: 0,
      created: 0,
      updated: 0,
      removed: 0,
      keptChecked: 0,
    };

    // 不带 deletedAt 过滤：需要看到软删行，才能判断「用户主动删过」而不复活它们
    const all = await tx.db.findMany('tripChecklistItem', { where: { templateId } });
    if (all.length === 0) return result;

    const tripIds = [
      ...new Set(all.map((r) => r['tripId']).filter((v): v is bigint => typeof v === 'bigint')),
    ];
    // 模板条目按名字索引（模板没有稳定条目标识，只能按 name 对齐）
    const tplByName = new Map(items.map((it) => [it.name, it]));
    const tplScope = typeof tpl['scope'] === 'string' ? tpl['scope'] : 'SHARED';
    const tplOwnerId = typeof tpl['ownerId'] === 'bigint' ? tpl['ownerId'] : null;

    for (const tripId of tripIds) {
      const trip = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!trip) continue;
      const status = typeof trip['status'] === 'string' ? trip['status'] : '';
      // 已归档不回溯：历史快照
      if (status === 'FINISHED' || status === 'CANCELLED') continue;

      result.trips += 1;

      const live = all.filter((r) => r['tripId'] === tripId && r['deletedAt'] === null);
      const removedNames = new Set(
        all
          .filter((r) => r['tripId'] === tripId && r['deletedAt'] !== null)
          .map((r) => String(r['name'])),
      );
      const liveByName = new Map(live.map((r) => [String(r['name']), r]));

      // ① 模板里已没有的条目
      for (const row of live) {
        const name = String(row['name']);
        if (tplByName.has(name)) continue;
        if (row['checked'] === true) {
          // 已勾选 = 已打包，保留原样，仅在结果里计数供界面说明
          result.keptChecked += 1;
          continue;
        }
        const id = row['id'];
        if (typeof id !== 'bigint') continue;
        await tx.db.update(
          'tripChecklistItem',
          { id },
          { deletedAt: now, updatedAt: now, version: Number(row['version'] ?? 0) + 1 },
        );
        await this.change(tx, 'trip_checklist_item', id, null, tripId, 'DELETE', now);
        result.removed += 1;
      }

      // ②③ 模板里有的：缺的补、数量变了的改
      let sort = live.length;
      for (const it of items) {
        const exist = liveByName.get(it.name);
        const qty = it.quantity ?? 1;

        if (exist !== undefined) {
          if (Number(exist['quantity'] ?? 1) !== qty) {
            const id = exist['id'];
            if (typeof id !== 'bigint') continue;
            await tx.db.update(
              'tripChecklistItem',
              { id },
              { quantity: qty, updatedAt: now, version: Number(exist['version'] ?? 0) + 1 },
            );
            await this.change(tx, 'trip_checklist_item', id, null, tripId, 'UPDATE', now);
            result.updated += 1;
          }
          continue;
        }

        // 用户主动删过 → 不复活
        if (removedNames.has(it.name)) continue;

        const id = tx.write.nextId();
        await tx.db.insert('tripChecklistItem', {
          id,
          tripId,
          templateId,
          scope: tplScope,
          ownerId: tplScope === 'PERSONAL' ? tplOwnerId : null,
          createdBy: userId,
          name: it.name,
          quantity: qty,
          checked: false,
          checkedBy: null,
          checkedAt: null,
          sort: sort++,
          version: 0,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        await this.change(tx, 'trip_checklist_item', id, null, tripId, 'INSERT', now);
        result.created += 1;
      }
    }

    return result;
  }

  /**
   * 删模板（D-2026-10-26-01 P0-2）—— 软删。
   *
   * 🔴 **不级联删行程里已引用它的清单项**：`trip_checklist_item.template_id`
   *    保留原值用于追溯「这项是从哪套清单引用来的」，行程里那一项仍可勾选。
   *    删模板是「以后不再用这套」，不是「把已经带出门的行李箱清空」。
   *
   * 🔴 已删再删 → 404（与「不存在」同形，不暴露「曾经存在」）。
   *    软删行在 `findUnique({ deletedAt: null })` 里天然消失，无需额外判定。
   */
  async removeTemplate(userId: bigint, templateId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const tpl = await tx.db.findUnique('checklistTemplate', { id: templateId, deletedAt: null });
      if (!tpl) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTemplateWritable(tx, tpl, userId);

      const now = await tx.db.dbNow();
      await tx.db.update(
        'checklistTemplate',
        { id: templateId },
        { deletedAt: now, updatedAt: now },
      );
      await this.change(
        tx,
        'checklist_template',
        templateId,
        this.templateFamilyId(tpl),
        null,
        'DELETE',
        now,
      );
      return now;
    });
  }

  /**
   * 从模板套用到出行 —— 批量建清单项。
   *
   * 幂等保护：同一 (templateId, tripId) 已有项时不重复套用，
   * 除非显式允许（避免用户连点两次按钮产生双倍清单）。
   */
  async applyTemplate(
    userId: bigint,
    input: { templateId: bigint; tripId: bigint; familyId: bigint },
  ): Promise<{ created: number; skipped: number; alreadyApplied: boolean }> {
    return this.o.ctx.tx(async (tx) => {
      const tpl = await tx.db.findUnique('checklistTemplate', {
        id: input.templateId,
        deletedAt: null,
      });
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

      // 存量行的 `items_json` 可能是 JSON 字符串（旧代码 JSON.stringify 的残留），
      // 统一走 parseTemplateItems —— 否则这里 `JSON.parse` 一个数组会抛 TypeError。
      const items = parseTemplateItems(tpl['itemsJson']);
      const now = await tx.db.dbNow();

      let sort = 0;
      for (const it of items) {
        const id = tx.write.nextId();
        await tx.db.insert('tripChecklistItem', {
          id,
          tripId: input.tripId,
          templateId: input.templateId,
          scope: tpl['scope'],
          ownerId: tpl['scope'] === 'PERSONAL' ? tpl['ownerId'] : null,
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
        await this.change(
          tx,
          'trip_checklist_item',
          id,
          input.familyId,
          input.tripId,
          'INSERT',
          now,
        );
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

  /**
   * 模板的可写性复核（D-2026-10-26-01 P0-1/P0-2）。
   *
   * 🔴 口径（与 applyTemplate 的「任意成员可引用」保持同源）：
   *    · SHARED  → 该模板所属家庭的**任一成员**可改（长期清单是家庭共用资产，
   *                只允许创建者改会让「另一个人加双鞋」变成不可完成的诉求）；
   *    · PERSONAL→ 仅 owner 本人或代管人可改（私有短路，不回落到家庭维度）。
   *    越权与不存在**逐字节同形**（404），不暴露「这个模板存在但不属于你」。
   *
   * ⚠️ 链第 5 段（checkAccess）已经在 dispatch 层判过一次；这里是
   *    **纵深防御**的第二道 —— 链用的是 `checklist_template` 域声明，
   *    而 service 直接面向行，两者判定依据必须一致，否则改一处漏一处。
   */
  private async assertTemplateWritable(tx: TxHandle, tpl: Row, userId: bigint): Promise<void> {
    const domain = resolveChecklistDomain({
      scope: scopeOf(tpl),
      ownerId: (tpl['ownerId'] ?? null) as bigint | null,
    });

    if (domain === AccessDomain.Private) {
      const owner = (tpl['ownerId'] ?? null) as bigint | null;
      if (owner === userId) return;
      if (owner !== null) {
        const managed =
          (
            await tx.db.findMany('familyMember', {
              where: { id: owner, managedBy: userId, deletedAt: null },
            })
          ).length > 0 ||
          (
            await tx.db.findMany('tripMember', {
              where: { id: owner, managedBy: userId, deletedAt: null },
            })
          ).length > 0;
        if (managed) return;
      }
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }

    // SHARED：必须是该模板所属家庭的成员
    const familyId = (tpl['familyId'] ?? null) as bigint | null;
    if (familyId === null) {
      // 无归属家庭的共享模板（未加入家庭时创建）—— 无成员关系可判，一律按不存在处理
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }
    const member = await tx.db.findUnique('familyMember', { familyId, userId, deletedAt: null });
    if (member) return;
    // 代管人（虚拟成员场景）同样视为家庭成员
    const managedMembers = await tx.db.findMany('familyMember', {
      where: { familyId, managedBy: userId, deletedAt: null },
    });
    if (managedMembers.length > 0) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  /** 模板回包补 `items`（解析后的数组），并保留原始 `itemsJson`（纯加法） */
  private withTemplateItems(row: Record<string, unknown>): Record<string, unknown> {
    return { ...row, items: parseTemplateItems(row['itemsJson']) };
  }

  /** 模板所属家庭（change_log 的 familyId 维度；无归属时为 null） */
  private templateFamilyId(tpl: Row): bigint | null {
    return (tpl['familyId'] ?? null) as bigint | null;
  }

  /** 用户作为成员或代管人所属的家庭集合 */
  private async familyIdsOf(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('familyMember', {
      where: { userId, deletedAt: null },
    });
    const managed = await this.o.ctx.read.findMany('familyMember', {
      where: { managedBy: userId, deletedAt: null },
    });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['familyId'] as bigint);
    for (const m of managed) s.add(m['familyId'] as bigint);
    return s;
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
    const mine = await this.o.ctx.read.findMany('tripMember', {
      where: { userId, deletedAt: null },
    });
    const managed = await this.o.ctx.read.findMany('tripMember', {
      where: { managedBy: userId, deletedAt: null },
    });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['tripId'] as bigint);
    for (const m of managed) s.add(m['tripId'] as bigint);
    return s;
  }

  /**
   * 契约对齐（#4）：响应同时携带 `title` / `done`（前端 ApiClient 契约为 title/done），
   * 与存储字段 `name` / `checked` 并存；存储层零改动、零迁移，仅展示层加别名。
   */
  private withChecklistAliases(row: Record<string, unknown>): Record<string, unknown> {
    return {
      ...row,
      title: typeof row['name'] === 'string' ? row['name'] : '',
      done: Boolean(row['checked']),
    };
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
