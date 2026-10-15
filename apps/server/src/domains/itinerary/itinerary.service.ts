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
import type { Row, TableDriver } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import type { ItineraryBlock } from './itinerary.schema.js';
import { toMinorUnits } from '../../common/fx/amount.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface ItineraryServiceOptions {
  ctx: DomainContext;
  /**
   * D-2026-10-15-01：媒体公网访问基址（方案 A）。
   * image 块读接口把 assetId 解析为 `base + '/' + fileKey` 回填 url。
   * 与 media 域 list/confirm **同一口径**（组合根传入同一取值）。
   * 为空串（本地开发）→ url 回填空串，前端降级占位卡。
   */
  mediaPublicBaseUrl?: string;
}

const ITEM_BIGINT_FIELDS = ['id', 'tripId', 'createdBy', 'amount', 'amountBase'];

/**
 * 出参块形态 —— 对齐前端 `ItineraryBlock`：
 * 与入参（`itineraryBlockSchema`）的唯一差异是 image 块多出**服务端派生**的 `url`
 * （= MEDIA_PUBLIC_BASE_URL + fileKey，方案 A，前端零拼接）。
 */
type ItineraryBlockOut =
  | { type: 'text'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; text: string; url: string }
  | { type: 'image'; assetId: string; url: string; caption?: string };

/** D-2026-10-15-01：blocks 序列化后整体体积上限（16KB），防单行撑爆行/带宽 */
const BLOCKS_MAX_BYTES = 16 * 1024;

export class ItineraryService {
  /** 媒体公网基址（末尾斜杠已剥离）；空串 = 本地开发，url 回填空串 */
  private readonly mediaBase: string;

  constructor(private readonly o: ItineraryServiceOptions) {
    this.mediaBase = (o.mediaPublicBaseUrl ?? 'https://media.local').replace(/\/+$/, '');
  }

  async create(
    userId: bigint,
    input: {
      tripId: bigint;
      familyId: bigint;
      title: string;
      startAt: string;
      endAt?: string;
      location?: string;
      note?: string;
      sort: number;
      /** M-Client-2：地图标记坐标（chooseLocation 带回） */
      lat?: number;
      lng?: number;
      /** M-Client-2：交通方式 */
      transport?: 'WALK' | 'BIKE' | 'CAR' | 'BUS' | 'TRAIN' | 'FLIGHT';
      amount?: string;
      currency?: string;
      rateSource: 'AUTO' | 'MANUAL';
      /** D-2026-10-15-01：正文块（有序；undefined = 老数据只有 note） */
      blocks?: ItineraryBlock[];
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);
      this.assertTimeOrder(input.startAt, input.endAt);
      // D-2026-10-15-01：体积闸门 + 图片资产越权校验（§1.4，与行程归属同事务，防 TOCTOU）
      this.assertBlocksPayload(input.blocks);
      await this.assertImageAssets(tx, input.blocks, t['familyId'] as bigint);

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
        // M-Client-2：地图坐标与交通方式（未选点/未选方式 → NULL）
        lat: input.lat ?? null,
        lng: input.lng ?? null,
        transport: input.transport ?? null,
        amount: amountMinor,
        currency: input.currency?.toUpperCase() ?? null,
        amountBase: null, // 由 expense 域汇总时统一折算；日程层不做汇率依赖
        rateSource: input.rateSource,
        rateBy: input.rateSource === 'MANUAL' ? userId : null,
        // D-2026-10-15-01：正文块整体替换语义（undefined = 不写；[] 写 '[]'）
        blocksJson: serializeBlocks(input.blocks),
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'itinerary_item', id, input.familyId, input.tripId, 'INSERT', now);
      const row = await tx.db.findUnique('itineraryItem', { id });
      const [projected] = await this.projectBlocks(tx.db, [row ?? {}], t['familyId'] as bigint);
      return projected ?? {};
    });
  }

  async list(
    userId: bigint,
    q: {
      tripId: bigint;
      date?: string;
      from?: string;
      to?: string;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{
    items: Record<string, unknown>[];
    days: { date: string; items: Record<string, unknown>[] }[];
    meta: Record<string, unknown>;
  }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const t = await this.o.ctx.read.findUnique('trip', { id: q.tripId, deletedAt: null });
    if (!t) {
      // D-2026-10-15-01（C1）：行程**已软删** → 空集（而非幽灵安排，也非 404
      // —— 客户端按 tripId 轮询时据此渲染「行程已删除」空态）；
      // 行程**根本不存在** → 仍 404（资源不存在，既有语义）。
      const softDeleted = await this.o.ctx.read.findUnique('trip', { id: q.tripId });
      if (softDeleted) {
        return {
          items: [],
          days: [],
          meta: buildPageMeta(page, 0) as unknown as Record<string, unknown>,
        };
      }
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }
    await this.assertTripVisible(this.o.ctx, t, userId);

    const all = await this.o.ctx.read.findMany('itineraryItem', {
      where: { tripId: q.tripId, deletedAt: null },
    });
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

    // D-2026-10-15-01：整片一次性投影（一条 IN 查询解析全部 image 块，不要 N+1）
    const projected = await this.projectBlocks(this.o.ctx.read, slice, t['familyId'] as bigint);

    // 按天分组（客户端时间轴渲染直接可用）
    const grouped = new Map<string, Array<Record<string, unknown>>>();
    for (const item of projected) {
      const day = localYmd(item['startAt']);
      const arr = grouped.get(day) ?? [];
      arr.push(item);
      grouped.set(day, arr);
    }

    return {
      items: projected,
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
    const [projected] = await this.projectBlocks(this.o.ctx.read, [r], t['familyId'] as bigint);
    return projected ?? {};
  }

  async update(
    userId: bigint,
    itemId: bigint,
    patch: {
      version: number;
      title?: string;
      startAt?: string;
      endAt?: string | null;
      location?: string | null;
      note?: string | null;
      sort?: number;
      /** M-Client-2：坐标/交通方式；null = 清除标记 */
      lat?: number | null;
      lng?: number | null;
      transport?: 'WALK' | 'BIKE' | 'CAR' | 'BUS' | 'TRAIN' | 'FLIGHT' | null;
      rateSource?: 'AUTO' | 'MANUAL';
      /** D-2026-10-15-01：正文块整体替换（undefined = 不更新；[] = 清空） */
      blocks?: ItineraryBlock[];
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('itineraryItem', { id: itemId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: r['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);
      this.assertTimeOrder(patch.startAt ?? localStr(r['startAt']), patch.endAt ?? undefined);
      // D-2026-10-15-01：体积闸门 + 图片资产越权校验（§1.4）
      this.assertBlocksPayload(patch.blocks);
      await this.assertImageAssets(tx, patch.blocks, t['familyId'] as bigint);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.startAt !== undefined) data['startAt'] = parseLocal(patch.startAt);
      if (patch.endAt !== undefined)
        data['endAt'] = patch.endAt === null ? null : parseLocal(patch.endAt);
      if (patch.location !== undefined) data['location'] = patch.location;
      if (patch.note !== undefined) data['note'] = patch.note;
      if (patch.sort !== undefined) data['sort'] = patch.sort;
      // M-Client-2：坐标/交通方式（null 显式清除标记）
      if (patch.lat !== undefined) data['lat'] = patch.lat;
      if (patch.lng !== undefined) data['lng'] = patch.lng;
      if (patch.transport !== undefined) data['transport'] = patch.transport;
      if (patch.rateSource !== undefined) {
        data['rateSource'] = patch.rateSource;
        data['rateBy'] = patch.rateSource === 'MANUAL' ? userId : null;
      }
      // D-2026-10-15-01：正文块整体替换语义（undefined = 不动；[] 写 '[]' 清空）
      if (patch.blocks !== undefined) {
        data['blocksJson'] = serializeBlocks(patch.blocks);
      }

      const affected = await tx.db.update(
        'itineraryItem',
        { id: itemId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该日程已被他人修改，请刷新后重试');
      }

      await this.change(
        tx,
        'itinerary_item',
        itemId,
        t['familyId'] as bigint,
        t['id'] as bigint,
        'UPDATE',
        now,
      );
      const row = await tx.db.findUnique('itineraryItem', { id: itemId });
      const [projected] = await this.projectBlocks(tx.db, [row ?? {}], t['familyId'] as bigint);
      return projected ?? {};
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
      await this.change(
        tx,
        'itinerary_item',
        itemId,
        t['familyId'] as bigint,
        t['id'] as bigint,
        'DELETE',
        now,
      );
      return now;
    });
  }

  /** 拖动排序 —— 批量更新 sort，不触发 CAS（排序是幂等的最终态） */
  async reorder(
    userId: bigint,
    input: { tripId: bigint; orders: Array<{ id: string; sort: number }> },
  ): Promise<{ updated: number; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      let updated = 0;
      for (const o of input.orders) {
        const id = BigInt(o.id);
        const r = await tx.db.findUnique('itineraryItem', {
          id,
          tripId: input.tripId,
          deletedAt: null,
        });
        if (!r) continue;
        await tx.db.update('itineraryItem', { id }, { sort: o.sort, updatedAt: now });
        await this.change(
          tx,
          'itinerary_item',
          id,
          t['familyId'] as bigint,
          input.tripId,
          'UPDATE',
          now,
        );
        updated += 1;
      }
      return { updated, updatedAt: now.toISOString() };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async assertTripVisible(
    src: TxHandle | DomainContext,
    t: Row,
    userId: bigint,
  ): Promise<void> {
    const db = 'db' in src ? src.db : src.read;
    const m = await db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (m) return;
    const fm = await db.findUnique('familyMember', {
      familyId: t['familyId'],
      userId,
      deletedAt: null,
    });
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

  // ── D-2026-10-15-01 · 正文块（blocks）────────────────────

  /** 整体体积闸门（防单行撑爆行/带宽）；形状校验已由 Zod 完成 */
  private assertBlocksPayload(blocks: ItineraryBlock[] | undefined): void {
    if (blocks !== undefined && JSON.stringify(blocks).length > BLOCKS_MAX_BYTES) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '正文块内容过大');
    }
  }

  /**
   * §1.4 图片块越权校验（安全红线）。
   *
   * 引用的资产必须同时满足：存在、`deletedAt IS NULL`、属于同一家庭。
   * 不满足 → 422（**不静默丢弃后返回 200** —— 客户端会以为写入成功）。
   * 放在写路径事务内、与行程归属查询同事务，避免 TOCTOU。
   */
  private async assertImageAssets(
    tx: TxHandle,
    blocks: ItineraryBlock[] | undefined,
    familyId: bigint,
  ): Promise<void> {
    if (blocks === undefined) return;
    const ids = new Set<string>();
    for (const b of blocks) {
      if (b.type === 'image' && b.assetId !== undefined) ids.add(b.assetId);
    }
    if (ids.size === 0) return;
    const found = await tx.db.findMany('mediaAsset', {
      where: { id: [...ids].map((s) => BigInt(s)), deletedAt: null, familyId },
    });
    if (found.length !== ids.size) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '图片引用的媒体资产不存在或无权访问');
    }
  }

  /**
   * 行 → 出参加载 blocks（列表与详情共用同一个投影函数，避免两处口径漂移）。
   *
   * · `blocks_json` 为 NULL / '[]' / 解析失败 → 出参**不带 blocks 字段**（前端走 note 兜底）
   * · 解析失败的单个块 → 丢弃该块，不影响其余块（不因一块脏数据让整条安排 500）
   * · image 块的 assetId 批量解析为 url（一条 `id IN (...)` 查询，不要 N+1）；
   *   资产不存在 / 已软删 / 不属于同一家庭 → 丢弃该图片块
   */
  private async projectBlocks(
    db: TableDriver,
    rows: Row[],
    familyId: bigint,
  ): Promise<Array<Record<string, unknown>>> {
    const parsed = rows.map((r) => ({ row: r, blocks: parseBlocks(r['blocksJson']) }));

    // 收集全部 image 块 assetId，一次 IN 查询批量取 fileKey
    const assetIds = new Set<string>();
    for (const { blocks } of parsed) {
      if (blocks === undefined) continue;
      for (const b of blocks) {
        if (b.type === 'image' && b.assetId !== undefined) assetIds.add(b.assetId);
      }
    }
    const fileKeys = new Map<string, string>();
    if (assetIds.size > 0) {
      const assets = await db.findMany('mediaAsset', {
        where: { id: [...assetIds].map((s) => BigInt(s)), deletedAt: null, familyId },
      });
      for (const a of assets) {
        fileKeys.set(
          (a['id'] as bigint).toString(),
          typeof a['fileKey'] === 'string' ? a['fileKey'] : '',
        );
      }
    }

    return parsed.map(({ row, blocks }) => {
      const out = serializeRow(row, ITEM_BIGINT_FIELDS);
      if (blocks === undefined) return out;
      const projected: ItineraryBlockOut[] = [];
      for (const b of blocks) {
        if (b.type !== 'image') {
          projected.push(b);
          continue;
        }
        const img = this.projectImageBlock(b, fileKeys);
        if (img !== undefined) projected.push(img);
      }
      out['blocks'] = projected;
      return out;
    });
  }

  /** image 块 → 出参形态（assetId 保留，url 由服务端拼接；解析失败返回 undefined = 丢块） */
  private projectImageBlock(
    b: Extract<ItineraryBlock, { type: 'image' }>,
    fileKeys: Map<string, string>,
  ): Extract<ItineraryBlockOut, { type: 'image' }> | undefined {
    if (b.assetId === undefined) return undefined;
    if (!fileKeys.has(b.assetId)) return undefined;
    return {
      type: 'image',
      assetId: b.assetId,
      url: this.mediaUrlOf(fileKeys.get(b.assetId)!),
      ...(b.caption !== undefined ? { caption: b.caption } : {}),
    };
  }

  /**
   * assetId → 可访问 URL（方案 A，前端零拼接）。
   * 与 media 域 `withUrl` 同一口径（同一环境变量、同一拼接方式）；
   * base 为空串（本地开发）→ 返回空串，前端降级占位卡。
   */
  private mediaUrlOf(fileKey: string): string {
    if (this.mediaBase === '') return '';
    return `${this.mediaBase}/${fileKey}`;
  }
}

/** `YYYY-MM-DDTHH:mm` → Date（按 UTC 解释，展示时用 trip.timezone 换算） */
function parseLocal(s: string): Date {
  return new Date(`${s}:00.000Z`);
}

/** blocks 入参 → 库列值（undefined = 不写 NULL；[] = 写 '[]'） */
function serializeBlocks(blocks: ItineraryBlock[] | undefined): string | null {
  return blocks !== undefined ? JSON.stringify(blocks) : null;
}

/**
 * 库列 → blocks 出参。
 * NULL / 空串 / '[]' / 解析失败 / 非数组 → undefined（出参不带 blocks 字段）。
 */
function parseBlocks(raw: unknown): ItineraryBlock[] | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined; // 脏数据不炸整条安排
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  const out: ItineraryBlock[] = [];
  for (const b of parsed) {
    const norm = normalizeBlock(b);
    if (norm !== undefined) out.push(norm);
  }
  return out.length > 0 ? out : undefined;
}

/** 单块形状归一；形状不符 → undefined（读路径丢弃该块，不 500） */
function normalizeBlock(b: unknown): ItineraryBlock | undefined {
  if (b === null || typeof b !== 'object') return undefined;
  const o = b as Record<string, unknown>;
  const type = o['type'];
  const text = o['text'];
  switch (type) {
    case 'text':
    case 'quote':
    case 'code':
      return typeof text === 'string' && text !== '' ? { type, text } : undefined;
    case 'link':
      return typeof text === 'string' && text !== '' && typeof o['url'] === 'string'
        ? { type: 'link', text, url: o['url'] }
        : undefined;
    case 'image': {
      if (typeof o['assetId'] !== 'string') return undefined;
      return {
        type: 'image',
        assetId: o['assetId'],
        ...(typeof o['caption'] === 'string' ? { caption: o['caption'] } : {}),
      };
    }
    default:
      return undefined;
  }
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
