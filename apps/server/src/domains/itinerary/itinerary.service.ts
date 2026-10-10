/**
 * itinerary 域 · service
 * ============================================================================
 * 职责：日程/行程明细（时间轴）。
 *
 * 设计要点：
 *   · 时间是**本地时间**（`YYYY-MM-DDTHH:mm` + trip 时区），不是 UTC 绝对时间。
 *     为什么：用户说「早上 9 点出发」指的是当地时间；存 UTC 后跨时区显示会错。
 *     存储层用 `datetime`（无时区）+ trip.timezone 解释。
 *   · 排序：(startAt, sort, id) —— 同时间多条时 sort 决定先后。
 *   · 编辑走 CAS（version），与 trip 一致。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { toMinorUnits } from '../../common/fx/amount.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface ItineraryServiceOptions {
  ctx: DomainContext;
}

const ITEM_BIGINT_FIELDS = ['id', 'tripId', 'createdBy', 'amount', 'amountBase'];

export class ItineraryService {
  constructor(private readonly o: ItineraryServiceOptions) {}

  async create(userId: bigint, input: {
    tripId: bigint;
    familyId: bigint;
    title: string;
    startAt: string;
    endAt?: string;
    location?: string;
    note?: string;
    sort: number;
    amount?: string;
    currency?: string;
    rateSource: 'AUTO' | 'MANUAL';
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);
      this.assertTimeOrder(input.startAt, input.endAt);

      const now = await tx.db.dbNow();
      const amountMinor =
        input.amount !== undefined && input.currency !== undefined
          ? toMinorUnits(input.amount, input.currency)
          : null;

      const id = tx.write.nextId();
      await tx.db.insert('itineraryItem', {
        id,
        tripId: input.tripId,
        createdBy: userId,
        title: input.title,
        startAt: parseLocal(input.startAt),
        endAt: input.endAt !== undefined ? parseLocal(input.endAt) : null,
        location: input.location ?? null,
        note: input.note ?? null,
        sort: input.sort,
        amount: amountMinor,
        currency: input.currency?.toUpperCase() ?? null,
        amountBase: null, // 由 expense 域汇总时统一折算；日程层不做汇率依赖
        rateSource: input.rateSource,
        rateBy: input.rateSource === 'MANUAL' ? userId : null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'itinerary_item', id, input.familyId, input.tripId, 'INSERT', now);
      const row = await tx.db.findUnique('itineraryItem', { id });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  async list(userId: bigint, q: {
    tripId: bigint;
    date?: string;
    from?: string;
    to?: string;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: Record<string, unknown>[]; days: { date: string; items: Record<string, unknown>[]; }[]; meta: Record<string, unknown>; }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const t = await this.o.ctx.read.findUnique('trip', { id: q.tripId, deletedAt: null });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertTripVisible(this.o.ctx, t, userId);

    const all = await this.o.ctx.read.findMany('itineraryItem', { where: { tripId: q.tripId, deletedAt: null } });
    let rows = all;
    if (q.date !== undefined) rows = rows.filter((r) => localYmd(r['startAt']) === q.date);
    if (q.from !== undefined) rows = rows.filter((r) => localYmd(r['startAt']) >= q.from!);
    if (q.to !== undefined) rows = rows.filter((r) => localYmd(r['startAt']) <= q.to!);

    rows = [...rows].sort((a, b) => {
      const ta = timeOf(a['startAt']);
      const tb = timeOf(b['startAt']);
      if (ta !== tb) return ta - tb;
      const sa = Number(a['sort'] ?? 0);
      const sb = Number(b['sort'] ?? 0);
      if (sa !== sb) return sa - sb;
      return Number(a['id']) - Number(b['id']);
    });

    const slice = rows.slice(page.skip, page.skip + page.take);

    // 按天分组（客户端时间轴渲染直接可用）
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const r of slice) {
      const day = localYmd(r['startAt']);
      const arr = grouped.get(day) ?? [];
      arr.push(serializeRow(r, ITEM_BIGINT_FIELDS));
      grouped.set(day, arr);
    }

    return {
      items: slice.map((r) => serializeRow(r, ITEM_BIGINT_FIELDS)),
      days: [...grouped.entries()].map(([date, items]) => ({ date, items })),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  async detail(userId: bigint, itemId: bigint): Promise<Record<string, unknown>> {
    const r = await this.o.ctx.read.findUnique('itineraryItem', { id: itemId, deletedAt: null });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    const t = await this.o.ctx.read.findUnique('trip', { id: r['tripId'], deletedAt: null });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertTripVisible(this.o.ctx, t, userId);
    return serializeRow(r, ITEM_BIGINT_FIELDS);
  }

  async update(userId: bigint, itemId: bigint, patch: {
    version: number;
    title?: string;
    startAt?: string;
    endAt?: string | null;
    location?: string | null;
    note?: string | null;
    sort?: number;
    rateSource?: 'AUTO' | 'MANUAL';
  }): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('itineraryItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: r['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);
      this.assertTimeOrder(patch.startAt ?? localStr(r['startAt']), patch.endAt ?? undefined);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.startAt !== undefined) data['startAt'] = parseLocal(patch.startAt);
      if (patch.endAt !== undefined) data['endAt'] = patch.endAt === null ? null : parseLocal(patch.endAt);
      if (patch.location !== undefined) data['location'] = patch.location;
      if (patch.note !== undefined) data['note'] = patch.note;
      if (patch.sort !== undefined) data['sort'] = patch.sort;
      if (patch.rateSource !== undefined) {
        data['rateSource'] = patch.rateSource;
        data['rateBy'] = patch.rateSource === 'MANUAL' ? userId : null;
      }

      const affected = await tx.db.update(
        'itineraryItem',
        { id: itemId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该日程已被他人修改，请刷新后重试');
      }

      await this.change(tx, 'itinerary_item', itemId, t['familyId'] as bigint, t['id'] as bigint, 'UPDATE', now);
      const row = await tx.db.findUnique('itineraryItem', { id: itemId });
      return serializeRow(row ?? {}, ITEM_BIGINT_FIELDS);
    });
  }

  async remove(userId: bigint, itemId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('itineraryItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: r['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('itineraryItem', { id: itemId }, { deletedAt: now, updatedAt: now });
      await this.change(tx, 'itinerary_item', itemId, t['familyId'] as bigint, t['id'] as bigint, 'DELETE', now);
      return now;
    });
  }

  /** 拖动排序 —— 批量更新 sort，不触发 CAS（排序是幂等的最终态） */
  async reorder(userId: bigint, input: { tripId: bigint; orders: Array<{ id: string; sort: number }> }): Promise<{ updated: number; updatedAt: string; }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      let updated = 0;
      for (const o of input.orders) {
        const id = BigInt(o.id);
        const r = await tx.db.findUnique('itineraryItem', { id, tripId: input.tripId, deletedAt: null });
        if (!r) continue;
        await tx.db.update('itineraryItem', { id }, { sort: o.sort, updatedAt: now });
        await this.change(tx, 'itinerary_item', id, t['familyId'] as bigint, input.tripId, 'UPDATE', now);
        updated += 1;
      }
      return { updated, updatedAt: now.toISOString() };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async assertTripVisible(src: TxHandle | DomainContext, t: Row, userId: bigint): Promise<void> {
    const db = 'db' in src ? src.db : src.read;
    const m = await db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (m) return;
    const fm = await db.findUnique('familyMember', { familyId: t['familyId'], userId, deletedAt: null });
    if (fm) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
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

  private assertTimeOrder(start?: string, end?: string | null): void {
    if (start !== undefined && end !== undefined && end !== null && start > end) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '结束时间不能早于开始时间');
    }
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

/** `YYYY-MM-DDTHH:mm` → Date（按 UTC 解释，展示时用 trip.timezone 换算） */
function parseLocal(s: string): Date {
  return new Date(`${s}:00.000Z`);
}

function localStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 16);
  return String(v).slice(0, 16);
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
