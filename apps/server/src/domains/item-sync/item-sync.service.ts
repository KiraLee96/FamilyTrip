/**
 * item-sync 域 · service（B1 多端同步 / E1–E6）
 * ============================================================================
 * 这是「多端一致」的核心。设计约束：
 *
 * 🔴 E2 · 服务端时间为唯一刻度
 *   游标基于 `change_log.changed_at`（DB 写入时间），**不是**客户端时间。
 *   客户端时钟不可信 —— 一台错了整条同步链就断。
 *
 * 🔴 E3 · 复合游标
 *   纯时间游标在「同毫秒并发写」时会漏单（`> t` 会跳过同毫秒的其他行）。
 *   故用 `(changed_at, id)` 复合游标：同毫秒靠 id 递进。
 *   `buildCursorPredicate` 生成 `WHERE changed_at > t OR (changed_at = t AND id > id0)`。
 *
 * 🔴 E4 · 严格 `>` 比较
 *   游标推进语义是「我已收到 <= (t, id0) 的全部变更」，故下次取 `>`。
 *   用 `>=` 会重复推送（幂等但浪费流量），用 `>` 才是正确语义。
 *
 * 🔴 E5 · 合并可折叠
 *   同一实体在一个批次里的多次写入应收敛成最终态（coalesce），
 *   避免客户端做 N 次无意义重放。但 INSERT→DELETE 折叠后要暴露
 *   `needsBackfill`，否则客户端会以为「从没见过这条」。
 *
 * 🔴 E6 · 漏单检测（backfill）
 *   客户端上报本地游标 < 服务端已知水位 → 触发全量回灌提示。
 *   单靠增量拉取无法自愈「客户端长时间离线导致 change_log 被清理」的场景。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { bigIntCellOrNull, stringCell } from '../../common/db/row-key.js';
import type { DomainContext } from '../domain-context.js';
import {
  buildCursorPredicate,
  decodeCursor,
  encodeCursor,
  coalesceChanges,
  mergeChanges,
  paginateChanges,
  type ChangeOp,
  type ChangeRecord,
  type SyncCursor,
} from '../../common/sync/change-log.js';
import { MAX_PAGE_SIZE } from '../../common/pagination/pagination.js';

export interface ItemSyncServiceOptions {
  ctx: DomainContext;
  /** 游标泄漏阈值：单批变更数超过它则提示客户端需要 backfill */
  leakThreshold?: number;
}

const DEFAULT_LEAK_THRESHOLD = 200;

export interface PullResult {
  changes: Array<{
    entityType: string;
    entityId: string;
    familyId: string | null;
    tripId: string | null;
    op: ChangeOp;
    changedAt: string;
  }>;
  /** 下一页游标（无更多则为 null） */
  nextCursor: string | null;
  hasMore: boolean;
  /** 是否建议客户端做一次全量回灌（漏单自愈） */
  needsBackfill: boolean;
  /** 服务端当前水位，便于客户端对账 */
  serverWatermark: string | null;
}

export class ItemSyncService {
  private readonly leakThreshold: number;

  constructor(private readonly o: ItemSyncServiceOptions) {
    this.leakThreshold = o.leakThreshold ?? DEFAULT_LEAK_THRESHOLD;
  }

  /**
   * 拉取增量变更。
   *
   * 流程：
   *   1. 解码游标（非法 → 400，让客户端重跑首次同步）
   *   2. 按可见范围 + 游标谓词查 change_log
   *   3. 折叠同实体的连续变更（E5）
   *   4. 切分页 + 签发下一页游标（E3/E4）
   */
  async pull(userId: bigint, q: {
    cursor?: string;
    limit?: number;
    familyId?: bigint;
    tripId?: bigint;
    entityTypes?: string[];
  }): Promise<PullResult> {
    const take = Math.min(q.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);

    // 1. 解码游标
    let after: SyncCursor | null = null;
    if (q.cursor !== undefined && q.cursor.length > 0) {
      after = decodeCursor(q.cursor);
      if (after === null) {
        throw new AppError(ErrorCode.BAD_REQUEST, '同步游标非法，请重新执行首次同步');
      }
    }

    // 2. 可见范围
    const visible = await this.visibleScope(userId);
    const rows = await this.o.ctx.read.findMany('changeLog', { where: {} });

    const filtered = rows.filter((r) => {
      // 范围过滤：变更必须落在我的可见家庭/出行内
      const fid = (r['familyId'] ?? null) as bigint | null;
      const tid = (r['tripId'] ?? null) as bigint | null;
      if (fid === null && tid === null) return true; // 全局字典类变更（如 holiday）
      if (fid !== null && visible.familyIds.has(fid)) return true;
      if (tid !== null && visible.tripIds.has(tid)) return true;
      return false;
    });

    // 范围限定（客户端可选）
    let scoped = filtered;
    if (q.familyId !== undefined) scoped = scoped.filter((r) => r['familyId'] === q.familyId);
    if (q.tripId !== undefined) scoped = scoped.filter((r) => r['tripId'] === q.tripId);
    if (q.entityTypes !== undefined && q.entityTypes.length > 0) {
      const set = new Set(q.entityTypes);
      scoped = scoped.filter((r) => set.has(String(r['entityType'])));
    }

    // 游标过滤（E3/E4）
    const predicate = buildCursorPredicate(after);
    const afterCursor = scoped.filter((r) => matchesCursorPredicate(r, predicate));

    // 全局排序：(changedAt, id) 升序
    const sorted = [...afterCursor].sort((a, b) => {
      const ta = timeOf(a['changedAt']);
      const tb = timeOf(b['changedAt']);
      if (ta !== tb) return ta - tb;
      return Number(a['id']) - Number(b['id']);
    });

    const records: ChangeRecord[] = sorted.map((r) => ({
      entityType: String(r['entityType']),
      entityId: r['entityId'] as bigint,
      familyId: (r['familyId'] ?? null) as bigint | null,
      tripId: (r['tripId'] ?? null) as bigint | null,
      op: r['op'] as ChangeOp,
      changedAt: r['changedAt'] as Date,
      id: r['id'] as bigint,
    }));

    // 3. 折叠（E5）—— 只在**同一页内**折叠，跨页折叠会破坏游标语义
    //
    // ⚠️ 折叠是「同实体的连续变更收敛成一条」，必须在分页之后做：
    //    若先折叠再分页，一条折叠记录可能代表多行，游标就少推进了。
    const page = paginateChanges(records, take);
    const coalesced = coalesceChanges(page.items);

    // 客户端本地状态未知（服务端不持有客户端状态），故用空 Map 做
    // 「断链检测」——只关心「出现 UPDATE 但没有对应 INSERT」这一漏单信号。
    const mergeOutcome = await mergeChanges(new Map<string, ChangeRecord>(), coalesced, (c) => c);
    const needsBackfill = mergeOutcome.needsBackfill.length > 0;

    // 服务端水位：可见范围内**全量**最大游标（不受分页影响），供客户端对账
    const watermark = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
    const serverWatermark =
      watermark !== undefined
        ? encodeCursor({ changedAt: watermark['changedAt'] as Date, id: watermark['id'] as bigint })
        : null;

    return {
      changes: coalesced.map((c) => ({
        entityType: c.entityType,
        entityId: c.entityId.toString(),
        familyId: c.familyId !== null ? c.familyId.toString() : null,
        tripId: c.tripId !== null ? c.tripId.toString() : null,
        op: c.op,
        changedAt: c.changedAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      // 漏单检测：折叠出断链 或 本页量超阈值
      needsBackfill: needsBackfill || page.items.length > this.leakThreshold,
      serverWatermark,
    };
  }

  /**
   * 首次同步：给出当前水位作为初始游标。
   *
   * 语义：客户端从这里开始「增量」；历史数据由**业务接口**分页拉取，
   * 不走 change_log（否则首同步等于全表扫描）。
   */
  async initialCursor(userId: bigint): Promise<{ cursor: string | null; serverTime: string }> {
    const visible = await this.visibleScope(userId);
    const rows = await this.o.ctx.read.findMany('changeLog', { where: {} });
    const mine = rows.filter((r) => {
      const fid = (r['familyId'] ?? null) as bigint | null;
      const tid = (r['tripId'] ?? null) as bigint | null;
      if (fid === null && tid === null) return true;
      if (fid !== null && visible.familyIds.has(fid)) return true;
      if (tid !== null && visible.tripIds.has(tid)) return true;
      return false;
    });
    const sorted = [...mine].sort((a, b) => {
      const ta = timeOf(a['changedAt']);
      const tb = timeOf(b['changedAt']);
      if (ta !== tb) return ta - tb;
      return Number(a['id']) - Number(b['id']);
    });
    const last = sorted[sorted.length - 1];
    const now = await this.o.ctx.read.dbNow();
    return {
      cursor: last !== undefined ? encodeCursor({ changedAt: last['changedAt'] as Date, id: last['id'] as bigint }) : null,
      serverTime: now.toISOString(),
    };
  }

  /**
   * 推送本地变更（离线回灌）。**不做实际写入** —— 这里只做
   * 「接收 → 去重 → 返回需要客户端重放的实体清单」。
   *
   * 为什么不在 sync 接口里做业务写：
   *   每个域有自己的业务规则（CAS、权限、余额校验），
   *   统一在这里写会绕过它们。正确做法是客户端拿到变更后
   *   **调用对应域的业务接口**重放。
   *   本接口的价值是：告诉客户端「哪些变更服务端已经知道了」（幂等去重），
   *   避免重复重放。
   */
  async push(userId: bigint, input: {
    batchId: string;
    changes: Array<{ entityType: string; entityId: string; op: ChangeOp }>;
  }): Promise<{
    batchId: string;
    accepted: number;
    /** 需要客户端调用业务接口重放的变更 */
    toReplay: Array<{ entityType: string; entityId: string; op: ChangeOp }>;
    /** 服务端已知、无需重放的（去重命中） */
    alreadyKnown: number;
  }> {
    const visible = await this.visibleScope(userId);
    const all = await this.o.ctx.read.findMany('changeLog', { where: {} });

    // 建立「服务端已知的 (entityType, entityId) → 最大游标」索引
    const known = new Map<string, SyncCursor>();
    for (const r of all) {
      const fid = (r['familyId'] ?? null) as bigint | null;
      const tid = (r['tripId'] ?? null) as bigint | null;
      const inScope =
        (fid === null && tid === null) ||
        (fid !== null && visible.familyIds.has(fid)) ||
        (tid !== null && visible.tripIds.has(tid));
      if (!inScope) continue;
      const key = changeKey(stringCell(r, 'entityType') ?? '', bigIntCellOrNull(r, 'entityId'));
      const cur: SyncCursor = { changedAt: r['changedAt'] as Date, id: r['id'] as bigint };
      const prev = known.get(key);
      if (!prev || cur.changedAt > prev.changedAt || (cur.changedAt.getTime() === prev.changedAt.getTime() && cur.id > prev.id)) {
        known.set(key, cur);
      }
    }

    let alreadyKnown = 0;
    const toReplay: Array<{ entityType: string; entityId: string; op: ChangeOp }> = [];
    for (const c of input.changes) {
      const key = changeKey(c.entityType, BigInt(c.entityId));
      if (known.has(key)) {
        alreadyKnown += 1;
        continue;
      }
      toReplay.push(c);
    }

    return {
      batchId: input.batchId,
      accepted: input.changes.length,
      toReplay,
      alreadyKnown,
    };
  }

  /**
   * 客户端回报合并结果（E6）。
   *
   * 若客户端游标落后于服务端水位过多 → 建议 backfill。
   * 这里的判定不做「精确差值」：只判断「客户端游标是否还在服务端可见范围内」。
   * 由于 change_log 有保留期，客户端游标早于最早一条 = 已被清理 = 必须回灌。
   */
  async reportMerge(userId: bigint, input: {
    batchId: string;
    needsBackfill: boolean;
    clientCursor?: string;
  }): Promise<{ batchId: string; action: 'NONE' | 'BACKFILL'; reason: string | null }> {
    if (input.needsBackfill) {
      return { batchId: input.batchId, action: 'BACKFILL', reason: 'CLIENT_REQUESTED' };
    }
    if (input.clientCursor === undefined) {
      return { batchId: input.batchId, action: 'NONE', reason: null };
    }
    const clientCursor = decodeCursor(input.clientCursor);
    if (clientCursor === null) {
      return { batchId: input.batchId, action: 'BACKFILL', reason: 'CURSOR_MALFORMED' };
    }

    const visible = await this.visibleScope(userId);
    const all = await this.o.ctx.read.findMany('changeLog', { where: {} });
    const mine = all.filter((r) => {
      const fid = (r['familyId'] ?? null) as bigint | null;
      const tid = (r['tripId'] ?? null) as bigint | null;
      if (fid === null && tid === null) return true;
      if (fid !== null && visible.familyIds.has(fid)) return true;
      if (tid !== null && visible.tripIds.has(tid)) return true;
      return false;
    });
    if (mine.length === 0) {
      return { batchId: input.batchId, action: 'NONE', reason: null };
    }

    const earliest = mine.reduce((acc, r) => {
      const t = timeOf(r['changedAt']);
      const at = timeOf(acc['changedAt']);
      if (t < at) return r;
      if (t === at && Number(r['id']) < Number(acc['id'])) return r;
      return acc;
    });

    const earliestCursor: SyncCursor = { changedAt: earliest['changedAt'] as Date, id: earliest['id'] as bigint };
    // 客户端游标早于最早一条 → 中间有被清理的变更 → 必须回灌
    const tooOld =
      clientCursor.changedAt < earliestCursor.changedAt ||
      (clientCursor.changedAt.getTime() === earliestCursor.changedAt.getTime() && clientCursor.id < earliestCursor.id);

    return {
      batchId: input.batchId,
      action: tooOld ? 'BACKFILL' : 'NONE',
      reason: tooOld ? 'CURSOR_BEHIND_RETENTION' : null,
    };
  }

  // ── 内部 ────────────────────────────────────────────────

  private async visibleScope(userId: bigint): Promise<{ familyIds: Set<bigint>; tripIds: Set<bigint> }> {
    const mine = await this.o.ctx.read.findMany('familyMember', { where: { userId, deletedAt: null } });
    const managed = await this.o.ctx.read.findMany('familyMember', { where: { managedBy: userId, deletedAt: null } });
    const familyIds = new Set<bigint>();
    for (const m of mine) familyIds.add(m['familyId'] as bigint);
    for (const m of managed) familyIds.add(m['familyId'] as bigint);

    const tripMine = await this.o.ctx.read.findMany('tripMember', { where: { userId, deletedAt: null } });
    const tripManaged = await this.o.ctx.read.findMany('tripMember', { where: { managedBy: userId, deletedAt: null } });
    const tripIds = new Set<bigint>();
    for (const m of tripMine) tripIds.add(m['tripId'] as bigint);
    for (const m of tripManaged) tripIds.add(m['tripId'] as bigint);

    return { familyIds, tripIds };
  }
}

/**
 * 变更记录的实体身份键：`entityType:entityId`。
 *
 * ⚠️ 必须显式归一大整数，不能靠模板串隐式转换 ——
 * 行读出来的 `entityId` 是 `unknown`，直接进模板串会走
 * `Object.prototype.toString` 得到 `"[object Object]"`，
 * 于是「所有实体的身份键都相同」，去重与水位比较全部失效。
 */
function changeKey(entityType: string, entityId: bigint | null): string {
  return `${entityType}:${entityId === null ? '' : entityId.toString(10)}`;
}

/** 按 `buildCursorPredicate` 的产出做内存过滤 */
function matchesCursorPredicate(row: Row, predicate: Record<string, unknown>): boolean {
  const or = predicate['OR'];
  if (or === undefined) return true;
  if (!Array.isArray(or)) return true;

  for (const clause of or as Array<Record<string, unknown>>) {
    const ct = clause['changedAt'] as { gt?: Date; equals?: Date } | undefined;
    const idc = clause['id'] as { gt?: bigint } | undefined;
    const t = timeOf(row['changedAt']);
    const id = BigInt(String(row['id']));

    if (ct?.gt !== undefined) {
      if (t > ct.gt.getTime()) return true;
    }
    if (ct?.equals !== undefined && idc?.gt !== undefined) {
      if (t === ct.equals.getTime() && id > idc.gt) return true;
    }
  }
  return false;
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
