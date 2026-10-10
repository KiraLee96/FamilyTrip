/**
 * memory 域 · service
 * ============================================================================
 * 职责：回忆归档的**生成**（写快照）与**读取**。
 *
 * 🔴 快照不可变
 *   `snapshot_json` 是生成时刻的完整副本。之后底层 trip / expense / itinerary
 *   再怎么改，回忆内容都不变 —— 这正是「防历史漂移」的目的。
 *   故：
 *     · 默认幂等：已存在即返回既有快照，不覆盖
 *     · 只有显式 `rebuild: true` 才重建
 *     · **不提供编辑 / 删除接口**（唯一键 uk_family_year_type 保证一篇一份）
 *
 * 🔴 隐私（D4）
 *   快照**只含共享域数据**（出行 / 日程 / 花销汇总 / 照片计数）。
 *   ⛔ 绝不把 PERSONAL 清单项、私有衣物、私有物品写进家庭回忆 ——
 *      否则「我的私人清单」会随回忆泄露给全家人。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { bigIntCell, stringCell } from '../../common/db/row-key.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow, DEFAULT_AUDIT_RETENTION_DAYS } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

const MEMORY_BIGINT_FIELDS = ['id', 'familyId', 'refId'];

/** 回忆快照的 JSON 形状（版本化，便于将来迁移） */
export interface MemorySnapshot {
  /** 快照结构版本 */
  schemaVersion: 1;
  type: 'TRIP' | 'ANNUAL';
  year: number;
  familyId: string;
  trip?: {
    id: string;
    title: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    timezone: string;
    destinations: unknown;
    memberCount: number;
    /** 参与成员显示名（去重后） */
    memberNames: string[];
  };
  itinerary?: Array<{ date: string | null; title: string; location: string | null }>;
  expenseSummary?: {
    currency: string;
    totalMinor: string;
    /** 待补汇率条数 —— 不计入 total 的兜底提示 */
    pendingRateCount: number;
    byCategory: Record<string, string>;
  };
  mediaCount?: number;
  generatedAt: string;
}

export interface MemoryServiceOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
  now?: () => Date;
}

/** 时间值 → 毫秒 */
function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** 时间值 → YYYY-MM-DD */
function ymd(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }
  // 只有 string 才可能已是 yyyy-MM-dd；其他类型（对象/数值时间戳）在这里无意义，
  // 直接判为无日期，避免 `"[object Object]"` 被正则之外的路径带出去。
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  return m ? m[1]! : null;
}

export class MemoryService {
  private readonly retentionDays: number;
  private readonly now: () => Date;

  constructor(private readonly o: MemoryServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
    this.now = o.now ?? (() => new Date());
  }

  // ══════════════════════════════════════════════════════════════════════
  // 列表 / 详情
  // ══════════════════════════════════════════════════════════════════════

  async list(userId: bigint, q: {
    familyId: bigint;
    type?: 'TRIP' | 'ANNUAL';
    year?: number;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    await this.assertFamilyMember(this.o.ctx, q.familyId, userId);
    const page = normalizePageQuery(q.page, q.pageSize);

    const all = await this.o.ctx.read.findMany('memoryArchive', { where: { familyId: q.familyId } });
    let rows = [...all];
    if (q.type !== undefined) rows = rows.filter((r) => r['type'] === q.type);
    if (q.year !== undefined) rows = rows.filter((r) => Number(r['year']) === q.year);

    // 年 desc，type 稳定排序（TRIP 在前），保证分页稳定
    rows.sort((a, b) => {
      const y = Number(b['year']) - Number(a['year']);
      if (y !== 0) return y;
      const t = String(a['type']).localeCompare(String(b['type']));
      if (t !== 0) return t;
      return Number((b['id'] as bigint) - (a['id'] as bigint));
    });

    const slice = rows.slice(page.skip, page.skip + page.take);
    return {
      items: slice.map((r) => this.toListItem(r)),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  async detail(userId: bigint, memoryId: bigint): Promise<{ memory: Record<string, unknown>; snapshot: unknown }> {
    const row = await this.o.ctx.read.findUnique('memoryArchive', { id: memoryId });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertFamilyMember(this.o.ctx, row['familyId'] as bigint, userId);
    return {
      memory: serializeRow(row, MEMORY_BIGINT_FIELDS),
      snapshot: row['snapshotJson'] ?? null,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 生成
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 生成出行回忆。
   *
   * 幂等：`(familyId, year, 'TRIP')` 已存在且未 rebuild → 返回既有快照。
   * ⚠️ 注意唯一键是 `(familyId, year, type)` —— 一年多次出行只有第一篇会被
   *    固化。多次出行场景由 `ref_id` 记录最后一次生成来源，快照内 `trip.id`
   *    为准。这是本期已知约束，二期引入 `(familyId, year, type, refId)`。
   */
  async generateTripMemory(userId: bigint, input: {
    tripId: bigint;
    year?: number;
    rebuild: boolean;
  }): Promise<{ memory: Record<string, unknown>; snapshot: unknown; created: boolean }> {
    const read = this.o.ctx.read;
    const trip = await read.findUnique('trip', { id: input.tripId, deletedAt: null });
    if (!trip) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

    const familyId = trip['familyId'] as bigint;
    await this.assertFamilyMember(this.o.ctx, familyId, userId);

    const year = input.year ?? Number(String(ymd(trip['endDate']) ?? ymd(trip['startDate']) ?? new Date().toISOString()).slice(0, 4));

    const snapshot = await this.buildTripSnapshot(trip, year);

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const existing = await tx.db.findMany('memoryArchive', {
        where: { familyId, year, type: 'TRIP' },
      });

      if (existing.length > 0 && !input.rebuild) {
        // 快照语义 —— 已固化即返回，不覆盖
        const hit = existing[0]!;
        return {
          memory: serializeRow(hit, MEMORY_BIGINT_FIELDS),
          snapshot: hit['snapshotJson'] ?? null,
          created: false,
        };
      }

      // rebuild：旧行删除（唯一键含 type/year，不软删会撞键），重建
      for (const old of existing) {
        await tx.db.update('memoryArchive', { id: old['id'] }, { refId: old['refId'] });
        // memory_archive 无 deletedAt 列 —— 唯一键也不含 deletedAt，
        // 故 rebuild 走「物理替换」：先删后插（同事务）
        await this.hardDelete(tx, 'memoryArchive', old['id'] as bigint);
      }

      const id = tx.write.nextId();
      await tx.db.insert('memoryArchive', {
        id,
        familyId,
        year,
        type: 'TRIP',
        refId: input.tripId,
        snapshotJson: snapshot,
        createdAt: now,
      });

      await this.change(tx, 'memory_archive', id, familyId, input.tripId, now);
      await this.audit(tx, {
        actorId: userId,
        action: input.rebuild ? 'memory.trip_rebuilt' : 'memory.trip_generated',
        reason: input.rebuild ? 'EXPLICIT_REBUILD' : 'TRIP_FINISHED',
        severity: 'INFO',
        targetId: id,
        detail: { tripId: input.tripId.toString(), year },
        at: now,
      });

      const row = await tx.db.findUnique('memoryArchive', { id });
      return { memory: serializeRow(row ?? {}, MEMORY_BIGINT_FIELDS), snapshot, created: true };
    });
  }

  /** 生成年度回忆（每年 12 月定时任务 / 手动触发） */
  async generateAnnualMemory(userId: bigint, input: {
    familyId: bigint;
    year: number;
    rebuild: boolean;
  }): Promise<{ memory: Record<string, unknown>; snapshot: unknown; created: boolean }> {
    await this.assertFamilyMember(this.o.ctx, input.familyId, userId);
    const snapshot = await this.buildAnnualSnapshot(input.familyId, input.year);

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const existing = await tx.db.findMany('memoryArchive', {
        where: { familyId: input.familyId, year: input.year, type: 'ANNUAL' },
      });

      if (existing.length > 0 && !input.rebuild) {
        const hit = existing[0]!;
        return {
          memory: serializeRow(hit, MEMORY_BIGINT_FIELDS),
          snapshot: hit['snapshotJson'] ?? null,
          created: false,
        };
      }

      for (const old of existing) {
        await this.hardDelete(tx, 'memoryArchive', old['id'] as bigint);
      }

      const id = tx.write.nextId();
      await tx.db.insert('memoryArchive', {
        id,
        familyId: input.familyId,
        year: input.year,
        type: 'ANNUAL',
        refId: null,
        snapshotJson: snapshot,
        createdAt: now,
      });

      await this.change(tx, 'memory_archive', id, input.familyId, null, now);
      await this.audit(tx, {
        actorId: userId,
        action: input.rebuild ? 'memory.annual_rebuilt' : 'memory.annual_generated',
        reason: input.rebuild ? 'EXPLICIT_REBUILD' : 'ANNUAL_SCHEDULE',
        severity: 'INFO',
        targetId: id,
        detail: { familyId: input.familyId.toString(), year: input.year },
        at: now,
      });

      const row = await tx.db.findUnique('memoryArchive', { id });
      return { memory: serializeRow(row ?? {}, MEMORY_BIGINT_FIELDS), snapshot, created: true };
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 快照构建
  // ══════════════════════════════════════════════════════════════════════

  private async buildTripSnapshot(trip: Row, year: number): Promise<MemorySnapshot> {
    const read = this.o.ctx.read;
    const tripId = trip['id'] as bigint;
    const familyId = trip['familyId'] as bigint;

    const members = await read.findMany('tripMember', { where: { tripId, deletedAt: null } });
    const memberNames = [
      ...new Set(members.map((m) => stringCell(m, 'displayName') ?? '').filter(Boolean)),
    ];

    const itinerary = await read.findMany('itineraryItem', { where: { tripId, deletedAt: null } });
    itinerary.sort((a, b) => {
      const d = String(ymd(a['date']) ?? '').localeCompare(String(ymd(b['date']) ?? ''));
      if (d !== 0) return d;
      const s = Number(a['sort'] ?? 0) - Number(b['sort'] ?? 0);
      return s !== 0 ? s : Number((a['id'] as bigint) - (b['id'] as bigint));
    });

    // 花销：只取有 amountBase 的（待补汇率不计入汇总）—— 与 expense 域口径一致
    const expenses = await read.findMany('expense', { where: { tripId, deletedAt: null } });
    let totalMinor = 0n;
    let pendingRateCount = 0;
    const byCategory = new Map<string, bigint>();
    for (const e of expenses) {
      if (e['amountBase'] === null || e['amountBase'] === undefined) {
        pendingRateCount += 1;
        continue;
      }
      const base = bigIntCell(e, 'amountBase');
      totalMinor += base;
      if (base === 0n) continue;
      const cat = stringCell(e, 'category') ?? 'OTHER';
      byCategory.set(cat, (byCategory.get(cat) ?? 0n) + base);
    }

    const media = await read.findMany('mediaAsset', { where: { tripId, deletedAt: null } });
    const currency = expenses[0] !== undefined ? (stringCell(expenses[0], 'currency') ?? 'CNY') : 'CNY';

    return {
      schemaVersion: 1,
      type: 'TRIP',
      year,
      familyId: familyId.toString(),
      trip: {
        id: tripId.toString(),
        title: stringCell(trip, 'title') ?? '',
        status: stringCell(trip, 'status') ?? '',
        startDate: ymd(trip['startDate']),
        endDate: ymd(trip['endDate']),
        timezone: stringCell(trip, 'timezone') ?? 'Asia/Shanghai',
        destinations: trip['destinationsJson'] ?? null,
        memberCount: members.length,
        memberNames,
      },
      itinerary: itinerary.map((r) => ({
        date: ymd(r['date']),
        title: stringCell(r, 'title') ?? '',
        location: r['location'] === null || r['location'] === undefined ? null : stringCell(r, 'location') ?? null,
      })),
      expenseSummary: {
        currency,
        totalMinor: totalMinor.toString(),
        pendingRateCount,
        byCategory: Object.fromEntries([...byCategory].map(([k, v]) => [k, v.toString()])),
      },
      mediaCount: media.length,
      generatedAt: this.now().toISOString(),
    };
  }

  private async buildAnnualSnapshot(familyId: bigint, year: number): Promise<MemorySnapshot> {
    const read = this.o.ctx.read;

    const yearStart = Date.UTC(year, 0, 1);
    const yearEnd = Date.UTC(year + 1, 0, 1);

    const trips = await read.findMany('trip', { where: { familyId, deletedAt: null } });
    const inYear = trips.filter((t) => {
      const ts = timeOf(t['startDate'] ?? t['createdAt']);
      return ts >= yearStart && ts < yearEnd;
    });

    const expenses = await read.findMany('expense', { where: { familyId, deletedAt: null } });
    let totalMinor = 0n;
    let pendingRateCount = 0;
    const byCategory = new Map<string, bigint>();
    for (const e of expenses) {
      const ts = timeOf(e['spentAt'] ?? e['createdAt']);
      if (ts < yearStart || ts >= yearEnd) continue;
      if (e['amountBase'] === null || e['amountBase'] === undefined) {
        pendingRateCount += 1;
        continue;
      }
      const base = bigIntCell(e, 'amountBase');
      totalMinor += base;
      if (base === 0n) continue;
      const cat = stringCell(e, 'category') ?? 'OTHER';
      byCategory.set(cat, (byCategory.get(cat) ?? 0n) + base);
    }

    const media = await read.findMany('mediaAsset', { where: { familyId, deletedAt: null } });

    return {
      schemaVersion: 1,
      type: 'ANNUAL',
      year,
      familyId: familyId.toString(),
      itinerary: inYear.map((t) => ({
        date: ymd(t['startDate']),
        title: stringCell(t, 'title') ?? '',
        location: null,
      })),
      expenseSummary: {
        currency: 'CNY',
        totalMinor: totalMinor.toString(),
        pendingRateCount,
        byCategory: Object.fromEntries([...byCategory].map(([k, v]) => [k, v.toString()])),
      },
      mediaCount: media.length,
      generatedAt: this.now().toISOString(),
    };
  }

  /** 列表项：不返回整个快照（省流量），只返回摘要 */
  private toListItem(row: Row): Record<string, unknown> {
    const snap = (row['snapshotJson'] ?? {}) as Partial<MemorySnapshot>;
    return {
      ...serializeRow(row, MEMORY_BIGINT_FIELDS),
      snapshotJson: undefined,
      summary: {
        tripTitle: snap.trip?.title ?? null,
        memberCount: snap.trip?.memberCount ?? null,
        itineraryCount: snap.itinerary?.length ?? 0,
        totalMinor: snap.expenseSummary?.totalMinor ?? null,
        pendingRateCount: snap.expenseSummary?.pendingRateCount ?? 0,
        mediaCount: snap.mediaCount ?? 0,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════════════════

  /**
   * `memory_archive` 表**没有 deleted_at 列**（快照表，唯一键不含 deletedAt）。
   * 故 rebuild 走物理删除，由 TableDriver 提供真删能力时使用；
   * 无真删能力时退化为「标记覆盖」（依赖唯一键，不撞键）。
   */
  private async hardDelete(tx: TxHandle, model: string, id: bigint): Promise<void> {
    const db = tx.db as unknown as { delete?(m: string, w: { id: bigint }): Promise<number> };
    if (typeof db.delete === 'function') {
      await db.delete(model, { id });
      return;
    }
    // 驱动无 delete 能力 → 用 refId=null 空置（rebuild 场景下随后即被新行覆盖业务语义）
    await tx.db.update(model, { id }, { refId: null });
  }

  private async assertFamilyMember(src: DomainContext | TxHandle, familyId: bigint, userId: bigint): Promise<void> {
    const db = 'db' in src ? src.db : src.read;
    const members = await db.findMany('familyMember', { where: { familyId, deletedAt: null } });
    const ok = members.some((m) => m['userId'] === userId);
    if (!ok) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    familyId: bigint | null,
    tripId: bigint | null,
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId,
      tripId,
      op: 'INSERT',
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
      severity: 'INFO' | 'WARN' | 'ALERT';
      targetId: bigint | null;
      detail: unknown;
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
      targetType: 'memory_archive',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}
