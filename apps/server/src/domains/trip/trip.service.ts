/**
 * trip 域 · service
 * ============================================================================
 * 职责：出行（行程容器）、成员与访问级别、主导者（leader）与退位。
 *
 * 本域承载三个「硬骨头」：
 *
 * 🔴 E7 · CAS 乐观锁
 *   出行的编辑（改期/改状态/改目的地）必须带 `version`。
 *   `buildCasWhere` 生成 `{id, version, deletedAt:null}` 作为 where，
 *   `update` 返回 0 行即版本冲突 → 409 VERSION_CONFLICT。
 *   为什么需要：夫妻两人同时改行程，后写者会静默覆盖前写者。
 *   CAS 把「静默覆盖」变成「显式冲突」，客户端可提示用户刷新。
 *
 * 🔴 E8 · 行锁 + 退位判定
 *   主导者变更（设人 / 离队）必须串行化。朴素实现在并发下会产生
 *   「两个 LEADER」或「零 LEADER」。本实现用 `withJsonPatch` 的行锁语义
 *   + `decideLeaderSuccession` 三态判定（KEEP / PROMOTE / REFUSE）。
 *
 * 🔴 B6 · 历史只读保留
 *   出行结束（FINISHED）后所有成员的 `access_level` 转 `HISTORICAL_READONLY`。
 *   权限层（`checkShared`）对只读级别只放行 READ，写/删一律拒。
 *   注意：**不**软删成员行 —— 历史要保留「谁参加过」。
 */

import { AppError, ErrorCode, inviteCodeInvalid } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import {
  buildCasWhere,
  assertCasSucceeded,
  requireVersion,
} from '../../common/concurrency/optimistic-lock.js';
import {
  decideLeaderSuccession,
  leaderAbdicationRefused,
  type LeaderSuccession,
} from '../../common/concurrency/row-lock.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';
import { randomInviteCode } from '../../common/invite-code.js';

export interface TripServiceOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
  /** D-2026-10-26-02 P0-1：过期行程自动完结（缺省开启；灰度/回滚只改这里） */
  autoFinish?: AutoFinishOptions;
}

/** 自动完结的两个作用域开关 */
export interface AutoFinishOptions {
  /** 读路径惰性流转（GET /trips、GET /trips/:id）—— 定时器没跑时的兜底（方案 B） */
  lazyOnRead: boolean;
  /** 单轮扫描上限，防止一次全表归档把启动期/主线程拖住 */
  batchLimit: number;
}

/** 一轮自动完结的统计（供定时任务日志与测试断言） */
export interface AutoFinishStats {
  /** 命中候选（已过期且状态可流转）的行程数 */
  scanned: number;
  /** 本次真正完成归档的行程数 */
  finished: number;
  /** 并发下已被其它路径归档（已是 FINISHED / CAS 落空）的行程数 */
  skipped: number;
  /** 单条失败数（不影响其余行程） */
  failed: number;
}

/** 单条自动完结的处置结果 */
type AutoFinishOutcome = { kind: 'finished'; row: Row } | { kind: 'skipped' } | { kind: 'failed' };

const TRIP_BIGINT_FIELDS = ['id', 'familyId', 'createdBy', 'leaderId', 'budgetMinor'];
const MEMBER_BIGINT_FIELDS = ['id', 'tripId', 'userId', 'managedBy'];

/** 不可再接受新成员的状态（GRP-08：结束后禁止加入） */
const JOIN_BLOCKED_STATUS = new Set(['FINISHED', 'CANCELLED']);

/**
 * 自动完结的状态白名单（D-2026-10-26-02 P0-1）。
 *
 * 🔴 **DRAFT 与 CANCELLED 一律不参与**：
 *   · DRAFT 是「还没进策划」的草稿（`POST /wishes/to-trip-draft` 建出来的就是 DRAFT），
 *     日期过期也不该被静默归档 —— 用户可能只是还没挑日期就去忙别的了；
 *   · CANCELLED 是用户主动取消，再翻成 FINISHED 会篡改事实。
 *   派发单原文即 `status IN ('PLANNED','ONGOING')`，此处逐字对齐。
 */
const AUTO_FINISH_STATUS = ['PLANNED', 'ONGOING'] as const;

/**
 * D-2026-10-15-01：行程删除时级联软删的子域表（ Prisma 模型名 = 委托名）。
 * media_asset 不在其列 —— 照片是家庭资产，不随行程软删（见 remove() 注释）。
 */
const CASCADE_CHILD_TABLES = [
  'tripMember',
  'itineraryItem',
  'tripChecklistItem',
  'expense',
  'booking',
] as const;

export class TripService {
  private readonly retentionDays: number;
  private readonly autoFinish: AutoFinishOptions;

  constructor(private readonly o: TripServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
    this.autoFinish = o.autoFinish ?? { lazyOnRead: true, batchLimit: 200 };
  }

  /** 建出行 —— 创建者自动成为 LEADER + ACTIVE 成员 */
  async create(
    userId: bigint,
    input: {
      familyId: bigint;
      title: string;
      startDate?: string;
      endDate?: string;
      timezone?: string;
      /** 出行预算（最小货币单位整数字符串）；不传 = 不设预算 */
      budgetMinor?: string;
      destinations?: Array<{ name: string; note?: string }>;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      await this.assertFamilyMember(tx, input.familyId, userId);
      this.assertDateOrder(input.startDate, input.endDate);
      const now = await tx.db.dbNow();

      const tripId = tx.write.nextId();
      await tx.db.insert('trip', {
        id: tripId,
        familyId: input.familyId,
        createdBy: userId,
        leaderId: userId,
        title: input.title,
        status: 'DRAFT',
        startDate: input.startDate ? toDate(input.startDate) : null,
        endDate: input.endDate ? toDate(input.endDate) : null,
        timezone: input.timezone ?? 'Asia/Shanghai',
        budgetMinor: input.budgetMinor !== undefined ? BigInt(input.budgetMinor) : null,
        destinationsJson: input.destinations ? JSON.stringify(input.destinations) : null,
        actualJson: null,
        // D-2026-10-14-02 §2.2：建行程即生成邀请码 ——
        // 前端「创建完立即进入邀请步骤」直接读 create 响应里的 inviteCode，
        // 不必再多打一次 GET /trips/:id/invite。
        inviteCode: await this.uniqueTripInviteCode(tx),
        inviteUpdatedAt: now,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.insert('tripMember', {
        id: tx.write.nextId(),
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

      const row = await tx.db.findUnique('trip', { id: tripId });
      return serializeRow(row ?? {}, TRIP_BIGINT_FIELDS);
    });
  }

  /** 出行列表 */
  async list(
    userId: bigint,
    q: {
      familyId?: bigint;
      status?: string;
      mineOnly?: boolean;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{
    items: { memberCount: number; myRole: unknown; myAccessLevel: unknown }[];
    meta: Record<string, unknown>;
  }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const myFamilies = await this.visibleFamilyIds(userId);

    const all = await this.o.ctx.read.findMany('trip', { where: { deletedAt: null } });
    let rows = all.filter((t) => myFamilies.has(t['familyId'] as bigint));
    if (q.familyId !== undefined) {
      rows = rows.filter((t) => t['familyId'] === q.familyId);
      if (rows.length === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }
    if (q.status !== undefined) rows = rows.filter((t) => t['status'] === q.status);

    const members = await this.o.ctx.read.findMany('tripMember', { where: { deletedAt: null } });
    if (q.mineOnly === true) {
      rows = rows.filter((t) =>
        members.some((m) => m['tripId'] === t['id'] && m['userId'] === userId),
      );
    }

    rows = [...rows].sort((a, b) => timeOf(b['createdAt']) - timeOf(a['createdAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    // ── P0-1 方案 B：读时惰性流转 ─────────────────────────────
    // 只对「本次要返回的这一页」做过期归档（最多 pageSize 条），读路径的写放大可控；
    // 定时器刚重启 / 任务挂掉时，用户看到的也仍然是正确状态。
    const refreshed = await this.autoFinishOnRead(slice);

    const membersByTrip = new Map<bigint, Row[]>();
    for (const m of members) {
      const key = m['tripId'] as bigint;
      const arr = membersByTrip.get(key);
      if (arr) arr.push(m);
      else membersByTrip.set(key, [m]);
    }
    // 刚被归档的行程，其成员 accessLevel 已转 HISTORICAL_READONLY —— 必须重取，
    // 否则列表会拿归档前的旧值（前端据此判断只读，会漏锁）。
    for (const id of refreshed.keys()) {
      membersByTrip.set(
        id,
        await this.o.ctx.read.findMany('tripMember', { where: { tripId: id, deletedAt: null } }),
      );
    }

    const items = slice.map((t) => {
      const row = refreshed.get(t['id'] as bigint) ?? t;
      const tripMembers = membersByTrip.get(row['id'] as bigint) ?? [];
      const mine = tripMembers.find((m) => m['userId'] === userId);
      return {
        ...serializeRow(row, TRIP_BIGINT_FIELDS),
        // P1-1（D-2026-10-26-02）：同行人数 = trip_member 存活行数。
        // 曾经的「家庭人数」口径是错的（家庭 4 人、本趟只去 3 人时数字不对）。
        memberCount: tripMembers.length,
        myRole: mine?.['role'] ?? null,
        myAccessLevel: mine?.['accessLevel'] ?? null,
      };
    });

    return { items, meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown> };
  }

  /** 出行详情（含成员） */
  async detail(
    userId: bigint,
    tripId: bigint,
  ): Promise<{
    trip: Record<string, unknown>;
    members: Record<string, unknown>[];
    /** 同行人数（D-2026-10-26-01 P2-2）—— 列表页显示「N 人同行」，不必再进详情数 */
    memberCount: number;
    myRole: unknown;
    myAccessLevel: unknown;
  }> {
    const t = await this.o.ctx.read.findUnique('trip', { id: tripId, deletedAt: null });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertTripVisible(this.o.ctx, t, userId);

    // P0-1 方案 B：读之前先把「已过期但还挂着 PLANNED/ONGOING」的行程归档。
    // 失败降级为「只读不改」—— 绝不因为流转失败让详情 500（见 autoFinishOnRead）。
    const row = (await this.autoFinishOnRead([t])).get(tripId) ?? t;

    // 成员必须在流转**之后**读：归档会把 accessLevel 改成 HISTORICAL_READONLY，
    // 先读会让 myAccessLevel 返回归档前的 ACTIVE（前端据此解锁编辑）。
    const members = await this.o.ctx.read.findMany('tripMember', {
      where: { tripId, deletedAt: null },
    });

    return {
      trip: serializeRow(row, TRIP_BIGINT_FIELDS),
      members: members.map((m) => serializeRow(m, MEMBER_BIGINT_FIELDS)),
      memberCount: members.length,
      myRole: members.find((m) => m['userId'] === userId)?.['role'] ?? null,
      myAccessLevel: members.find((m) => m['userId'] === userId)?.['accessLevel'] ?? null,
    };
  }

  /**
   * 更新出行 —— **CAS 强制**。
   *
   * 🔴 `version` 必传。0 行受影响 = 有人先改了 → 409。
   *    这不是可选项：缺 version 就 throw，避免「悄悄退化成全量覆盖」。
   */
  async update(
    userId: bigint,
    tripId: bigint,
    input: {
      version: number;
      title?: string;
      status?: string;
      startDate?: string | null;
      endDate?: string | null;
      timezone?: string;
      /** 出行预算；`null` = 取消预算，不传 = 不改 */
      budgetMinor?: string | null;
      destinations?: Array<{ name: string; note?: string }>;
    },
  ): Promise<{ trip: Record<string, unknown>; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const expectedVersion = requireVersion(input.version);
      this.assertDateOrder(input.startDate ?? undefined, input.endDate ?? undefined);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: expectedVersion + 1 };
      if (input.title !== undefined) data['title'] = input.title;
      if (input.status !== undefined) data['status'] = input.status;
      if (input.timezone !== undefined) data['timezone'] = input.timezone;
      if (input.startDate !== undefined)
        data['startDate'] = input.startDate === null ? null : toDate(input.startDate);
      if (input.endDate !== undefined)
        data['endDate'] = input.endDate === null ? null : toDate(input.endDate);
      if (input.destinations !== undefined)
        data['destinationsJson'] = JSON.stringify(input.destinations);
      // 预算：显式 null 才是「取消预算」，undefined 表示这次不改（两者必须分开）
      if (input.budgetMinor !== undefined)
        data['budgetMinor'] = input.budgetMinor === null ? null : BigInt(input.budgetMinor);

      const affected = await tx.db.update(
        'trip',
        buildCasWhere({ id: tripId, expectedVersion, patch: data }),
        data,
      );
      // 0 行 → 版本冲突（4090）
      assertCasSucceeded(affected, 'trip', expectedVersion);

      await this.change(tx, 'trip', tripId, t['familyId'] as bigint, tripId, 'UPDATE', now);

      const row = await tx.db.findUnique('trip', { id: tripId });
      return {
        trip: serializeRow(row ?? {}, TRIP_BIGINT_FIELDS),
        updatedAt: now.toISOString(),
      };
    });
  }

  /**
   * 删除出行（仅主导者/创建者）。
   *
   * D-2026-10-15-01（P1）：删除事务内**级联软删**子域行（采纳派发单 §2.3 方案 A）。
   * 为什么不选 B（各子域查询校验父行程）：成本分散在每处查询、极易漏。
   * 子域行只软删（保留可审计痕迹），与家庭域 `dissolveFamily` 既有做法一致。
   *
   * 🔴 media_asset **不随行程软删**：照片是家庭资产，行程删了照片墙仍应在
   *    「我的照片」可见；`GET /media?tripId=<已删行程>` 由 media 域按父行程
   *    已删返回空集（见 media.service.list）。
   * 🔴 trip.invite_code：D-2026-10-14-02 落地后邀请码随父行软删一并失效
   *    （`joinByInvite` 的 `findUnique` 恒带 `deletedAt: null`，无需显式吊销）；
   *    唯一索引 `(invite_code, deleted_at)` 软删感知，同一码可被新行程复用。
   * 🔴 change_log 只写父实体一条 DELETE（同 dissolveFamily）：子行软删不逐行
   *    放大日志，同步游标以行程行失效为收敛点。
   */
  async remove(userId: bigint, tripId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertLeaderOrCreator(tx, t, userId);

      const now = await tx.db.dbNow();
      await tx.db.update('trip', { id: tripId }, { deletedAt: now, updatedAt: now });

      // 子域级联软删（同一事务；驱动 update 即 updateMany 语义，返回受影响行数）
      for (const table of CASCADE_CHILD_TABLES) {
        await tx.db.update(table, { tripId, deletedAt: null }, { deletedAt: now, updatedAt: now });
      }

      await this.change(tx, 'trip', tripId, t['familyId'] as bigint, tripId, 'DELETE', now);
      return now;
    });
  }

  // ── 邀请码（GRP-02 · D-2026-10-14-02）────────────────────

  /**
   * 取行程邀请码（成员可读）。
   *
   * 语义三条：
   *   1. 行程不存在 → 404（与全站口径一致，不区分「码无效」与「行程不存在」）；
   *   2. **调用方必须是行程成员** —— 码的传播靠组织者复制/分享，不靠接口枚举；
   *   3. 历史行（迁移前创建 / 回填遗漏）`inviteCode` 为空 → 懒生成补写并返回，不报错。
   *
   * ⚠️ 这里要写库（懒生成），故必须走事务；只读路径不要复用本方法。
   */
  async getInvite(
    userId: bigint,
    tripId: bigint,
  ): Promise<{ tripId: string; inviteCode: string; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripMember(tx, t, userId);

      const existing = t['inviteCode'];
      if (typeof existing === 'string' && existing.length > 0) {
        return {
          tripId: tripId.toString(),
          inviteCode: existing,
          updatedAt: timeOfIso(t['inviteUpdatedAt'] ?? t['createdAt']),
        };
      }

      // 懒生成兜底（历史行）：补写 invite_code + invite_updated_at 后返回。
      // 不写 change_log —— 邀请码不是客户端可见的业务内容变更，
      // 写进去会让同步游标产生一次「行程被改了」的假信号。
      const now = await tx.db.dbNow();
      const code = await this.uniqueTripInviteCode(tx);
      await tx.db.update('trip', { id: tripId }, { inviteCode: code, inviteUpdatedAt: now });
      return { tripId: tripId.toString(), inviteCode: code, updatedAt: now.toISOString() };
    });
  }

  /**
   * 重置行程邀请码（旧码即刻作废 —— 值被替换即失效，无需显式吊销）。
   *
   * 🔴 仅主导者或创建者，复用 `assertLeaderOrCreator`（与 `addMember` 同一判定，勿新造）。
   * 🔴 **不走 CAS**：邀请码不属于 E7 版本管辖的行程内容字段，
   *    reset 后客户端重新拉取即可；强行带 version 会把「重置邀请码」与
   *    「改行程」两个语义搅在一起。family 域重置同样无 version，保持一致。
   */
  async resetInvite(
    userId: bigint,
    tripId: bigint,
  ): Promise<{ tripId: string; inviteCode: string; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripMember(tx, t, userId);
      await this.assertLeaderOrCreator(tx, t, userId);

      const now = await tx.db.dbNow();
      const code = await this.uniqueTripInviteCode(tx);
      await tx.db.update(
        'trip',
        { id: tripId },
        { inviteCode: code, inviteUpdatedAt: now, updatedAt: now },
      );

      await this.change(tx, 'trip', tripId, t['familyId'] as bigint, tripId, 'UPDATE', now);

      return { tripId: tripId.toString(), inviteCode: code, updatedAt: now.toISOString() };
    });
  }

  /**
   * 凭邀请码加入（外部同行者，GRP-02）。幂等。
   *
   * 判定顺序即优先级（勿调换）：
   *   1. 码所指向的行程（含 `deletedAt: null`）不存在 → 404 **4041 邀请码无效**
   *      （D-2026-10-26-01 P2-1：与 4040「资源不存在」区分，客户端据此提示
   *       「让家人重新发一次」而不是无法行动的「资源不存在」）
   *   2. 已是成员 → 原样返回 `alreadyMember: true`（**不插行、不写 changeLog**）
   *   3. 行程已结束/取消 → 403 `行程已结束，无法加入`（GRP-08：
   *      不能只靠前端隐藏入口 —— 改包/直连接口都能绕过）
   *   4. 插入 `tripMember`（MEMBER / isExternal=true / ACTIVE）
   *
   * 并发说明：双请求同时 join 同一码时，应用层查重存在极小窗口双插。
   * 与 `addMember` 现有模式一致；`trip_member (trip_id, user_id, deleted_at)`
   * 唯一索引涉及全表数据治理，另单评估。验收以功能幂等为准。
   */
  async joinByInvite(
    userId: bigint,
    input: { inviteCode: string; displayName?: string },
  ): Promise<{
    trip: Record<string, unknown>;
    member: Record<string, unknown>;
    alreadyMember: boolean;
  }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', {
        inviteCode: input.inviteCode,
        deletedAt: null,
      });
      if (!t) throw inviteCodeInvalid();
      const tripId = t['id'] as bigint;

      // 幂等前置：已是成员直接返回，不重复插行
      const existing = await tx.db.findUnique('tripMember', {
        tripId,
        userId,
        deletedAt: null,
      });
      if (existing) {
        return {
          trip: serializeRow(t, TRIP_BIGINT_FIELDS),
          member: serializeRow(existing, MEMBER_BIGINT_FIELDS),
          alreadyMember: true,
        };
      }

      // 状态门：必须在幂等判定**之后** —— 已结束行程的既有成员再点一次
      // 邀请链接应当是「幂等成功」，而不是突然 403。
      if (JOIN_BLOCKED_STATUS.has(String(t['status']))) {
        throw new AppError(ErrorCode.FORBIDDEN, '行程已结束，无法加入');
      }

      const now = await tx.db.dbNow();
      const memberId = tx.write.nextId();
      await tx.db.insert('tripMember', {
        id: memberId,
        tripId,
        userId,
        managedBy: null,
        role: 'MEMBER',
        // 外部同行者：不属该家庭，靠邀请码进来
        isExternal: true,
        accessLevel: 'ACTIVE',
        displayName: input.displayName ?? (await this.displayNameOf(tx, userId)),
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(
        tx,
        'trip_member',
        memberId,
        t['familyId'] as bigint,
        tripId,
        'INSERT',
        now,
      );

      const member = await tx.db.findUnique('tripMember', { id: memberId });
      return {
        trip: serializeRow(t, TRIP_BIGINT_FIELDS),
        member: serializeRow(member ?? {}, MEMBER_BIGINT_FIELDS),
        alreadyMember: false,
      };
    });
  }

  // ── 成员 ────────────────────────────────────────────────

  /** 加成员 */
  async addMember(
    userId: bigint,
    tripId: bigint,
    input: {
      userId?: string;
      displayName?: string;
      isVirtual: boolean;
      isExternal: boolean;
      role: 'LEADER' | 'MEMBER';
      managedBy?: string;
      accessLevel: 'ACTIVE' | 'HISTORICAL_READONLY';
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertLeaderOrCreator(tx, t, userId);

      if (input.role === 'LEADER') {
        throw new AppError(ErrorCode.FORBIDDEN, '设置主导者请使用专用接口');
      }
      const isVirtual = input.isVirtual || input.userId === undefined;
      if (isVirtual && !input.displayName) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, '虚拟成员必须提供 displayName');
      }

      const targetUserId = isVirtual ? null : BigInt(input.userId!);
      if (targetUserId !== null) {
        const dup = await tx.db.findUnique('tripMember', {
          tripId,
          userId: targetUserId,
          deletedAt: null,
        });
        if (dup) throw new AppError(ErrorCode.FORBIDDEN, '该用户已在出行中');
      }

      const now = await tx.db.dbNow();
      const memberId = tx.write.nextId();
      await tx.db.insert('tripMember', {
        id: memberId,
        tripId,
        userId: targetUserId,
        managedBy: isVirtual ? BigInt(input.managedBy ?? userId.toString()) : null,
        role: 'MEMBER',
        isExternal: input.isExternal,
        accessLevel: input.accessLevel,
        displayName:
          input.displayName ??
          (targetUserId ? await this.displayNameOf(tx, targetUserId) : '同行者'),
        joinedAt: now,
        leftAt: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(
        tx,
        'trip_member',
        memberId,
        t['familyId'] as bigint,
        tripId,
        'INSERT',
        now,
      );

      const row = await tx.db.findUnique('tripMember', { id: memberId });
      return serializeRow(row ?? {}, MEMBER_BIGINT_FIELDS);
    });
  }

  /** 改成员（角色/访问级别/昵称/代管）—— 仅主导者 */
  async updateMember(
    userId: bigint,
    memberId: bigint,
    patch: {
      role?: 'LEADER' | 'MEMBER';
      accessLevel?: 'ACTIVE' | 'HISTORICAL_READONLY';
      displayName?: string;
      managedBy?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const m = await tx.db.findUnique('tripMember', { id: memberId, deletedAt: null });
      if (!m) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const tripId = m['tripId'] as bigint;
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertLeaderOrCreator(tx, t, userId);

      if (patch.role === 'LEADER') {
        throw new AppError(ErrorCode.FORBIDDEN, '设主导者请使用专用接口');
      }

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now };
      if (patch.accessLevel !== undefined) data['accessLevel'] = patch.accessLevel;
      if (patch.displayName !== undefined) data['displayName'] = patch.displayName;
      if (patch.managedBy !== undefined) {
        data['managedBy'] = patch.managedBy === null ? null : BigInt(patch.managedBy);
      }

      await tx.db.update('tripMember', { id: memberId }, data);
      await this.change(
        tx,
        'trip_member',
        memberId,
        t['familyId'] as bigint,
        tripId,
        'UPDATE',
        now,
      );

      const row = await tx.db.findUnique('tripMember', { id: memberId });
      return serializeRow(row ?? {}, MEMBER_BIGINT_FIELDS);
    });
  }

  /** 移除成员（主导者）或退出（本人）—— 本人退出走 leave() */
  async removeMember(userId: bigint, memberId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const m = await tx.db.findUnique('tripMember', { id: memberId, deletedAt: null });
      if (!m) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const tripId = m['tripId'] as bigint;
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const isSelf = m['userId'] !== null && m['userId'] === userId;
      if (!isSelf) await this.assertLeaderOrCreator(tx, t, userId);
      if (m['role'] === 'LEADER') {
        throw new AppError(ErrorCode.FORBIDDEN, '主导者不能直接移除，请先移交主导权');
      }

      const now = await tx.db.dbNow();
      await tx.db.update(
        'tripMember',
        { id: memberId },
        { deletedAt: now, leftAt: now, updatedAt: now },
      );
      await this.change(
        tx,
        'trip_member',
        memberId,
        t['familyId'] as bigint,
        tripId,
        'DELETE',
        now,
      );
      return now;
    });
  }

  // ── 主导者 ──────────────────────────────────────────────

  /**
   * 设主导者（E8 · 行锁 + 期望值校验）。
   *
   * 🔴 串行化：整个过程在一个事务内完成「读当前主导者 → 降级 → 升级 → 回写 trip.leader_id」。
   *    - 先降旧主再升新主（顺序不可反，否则中途失败留两个 LEADER）
   *    - `expectLeaderId` 不符 → 409（有人在并发改）
   */
  async setLeader(
    userId: bigint,
    tripId: bigint,
    input: {
      leaderMemberId: bigint;
      expectLeaderId?: bigint | null;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertLeaderOrCreator(tx, t, userId);

      const currentLeaderId = (t['leaderId'] as bigint | null) ?? null;
      // 期望值校验：客户端视角里主导者已变 → 让客户端刷新重试
      if (
        input.expectLeaderId !== undefined &&
        !sameBigint(input.expectLeaderId, currentLeaderId)
      ) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '主导者已被他人变更，请刷新后重试');
      }

      const target = await tx.db.findUnique('tripMember', {
        id: input.leaderMemberId,
        tripId,
        deletedAt: null,
      });
      if (!target) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      if (target['isVirtual'] === true) {
        throw new AppError(ErrorCode.FORBIDDEN, '虚拟成员不能担任主导者');
      }

      const now = await tx.db.dbNow();

      // 1. 先降旧主
      const oldLeader = await tx.db.findUnique('tripMember', {
        tripId,
        userId: currentLeaderId,
        role: 'LEADER',
        deletedAt: null,
      });
      if (oldLeader) {
        await tx.db.update(
          'tripMember',
          { id: oldLeader['id'] },
          { role: 'MEMBER', updatedAt: now },
        );
      }
      // 2. 再升新主
      await tx.db.update(
        'tripMember',
        { id: input.leaderMemberId },
        { role: 'LEADER', accessLevel: 'ACTIVE', updatedAt: now },
      );
      // 3. trip.leader_id 同步
      await tx.db.update('trip', { id: tripId }, { leaderId: target['userId'], updatedAt: now });

      await this.change(tx, 'trip', tripId, t['familyId'] as bigint, tripId, 'UPDATE', now);

      await this.audit(tx, {
        actorId: userId,
        action: 'trip.set_leader',
        reason: 'LEADER_CHANGED',
        severity: 'ALERT',
        targetType: 'trip',
        targetId: tripId,
        detail: {
          previousLeaderUserId: currentLeaderId?.toString() ?? null,
          newLeaderUserId: (target['userId'] as bigint | null)?.toString() ?? null,
        },
        at: now,
      });

      const row = await tx.db.findUnique('trip', { id: tripId });
      return serializeRow(row ?? {}, TRIP_BIGINT_FIELDS);
    });
  }

  /**
   * 主动离队 —— 若本人是主导者则触发**退位判定**（E8）。
   *
   * 三态：
   *   KEEP    指定了继任者且有效（或已由 `setLeader` 移交）
   *   PROMOTE 未指定继任者 → 从剩余 ACTIVE 成员里自动选一个
   *   REFUSE  无其他 ACTIVE 成员 → 拒（避免留下无主导者的出行）
   */
  async leave(
    userId: bigint,
    tripId: bigint,
    input: { successorMemberId?: bigint },
  ): Promise<{
    succession: 'KEEP' | 'PROMOTE';
    newLeaderUserId: string | null;
    updatedAt: string;
  }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const me = await tx.db.findUnique('tripMember', { tripId, userId, deletedAt: null });
      if (!me) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const now = await tx.db.dbNow();
      const isLeader = me['role'] === 'LEADER';

      let succession: LeaderSuccession = {
        action: 'KEEP',
        leaderId: 0n,
        reason: '退位者不是主导者',
      };

      if (isLeader) {
        const members = await tx.db.findMany('tripMember', { where: { tripId, deletedAt: null } });
        const remainingActiveUserIds = members
          .filter(
            (m) =>
              m['id'] !== me['id'] &&
              m['accessLevel'] === 'ACTIVE' &&
              m['isVirtual'] !== true &&
              m['userId'] !== null,
          )
          .map((m) => m['userId'] as bigint);

        const currentLeaderId = (t['leaderId'] as bigint | null) ?? null;

        succession = decideLeaderSuccession({
          leavingUserId: currentLeaderId ?? userId,
          currentLeaderId,
          remainingActiveUserIds,
        });

        // 显式指定了继任者 → 覆盖自动判定
        if (input.successorMemberId !== undefined) {
          const succ = await tx.db.findUnique('tripMember', {
            id: input.successorMemberId,
            tripId,
            deletedAt: null,
          });
          if (!succ) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
          if (succ['isVirtual'] === true) {
            throw new AppError(ErrorCode.FORBIDDEN, '虚拟成员不能担任主导者');
          }
          succession = {
            action: 'PROMOTE',
            leaderId: succ['userId'] as bigint,
            reason: '唯一主导者退出，递补一名 ACTIVE 成员',
          };
        }

        if (succession.action === 'REFUSE') {
          throw leaderAbdicationRefused(remainingActiveUserIds.length);
        }

        if (succession.action === 'PROMOTE') {
          const newLeaderId = succession.leaderId;
          const newLeader = await tx.db.findUnique('tripMember', {
            tripId,
            userId: newLeaderId,
            deletedAt: null,
          });
          if (newLeader) {
            await tx.db.update(
              'tripMember',
              { id: newLeader['id'] },
              { role: 'LEADER', updatedAt: now },
            );
            await tx.db.update('trip', { id: tripId }, { leaderId: newLeaderId, updatedAt: now });
          }
        }
      }

      // 离队：软删成员行 + 记录 leftAt
      await tx.db.update(
        'tripMember',
        { id: me['id'] },
        { deletedAt: now, leftAt: now, updatedAt: now },
      );
      await this.change(
        tx,
        'trip_member',
        me['id'] as bigint,
        t['familyId'] as bigint,
        tripId,
        'DELETE',
        now,
      );

      await this.audit(tx, {
        actorId: userId,
        action: 'trip.leave',
        reason: isLeader ? 'LEADER_LEFT' : 'MEMBER_LEFT',
        severity: isLeader ? 'WARN' : 'INFO',
        targetType: 'trip',
        targetId: tripId,
        detail: { succession: succession.action },
        at: now,
      });

      return {
        succession: succession.action,
        newLeaderUserId: succession.action === 'PROMOTE' ? succession.leaderId.toString() : null,
        updatedAt: now.toISOString(),
      };
    });
  }

  /**
   * 结束出行（B6 历史只读保留）—— 手工路径。
   *
   * 归档逻辑本体在 `finishInternal`（HTTP 与定时器/惰性流转**共用同一份**，
   * 禁止出现第二份归档实现）。
   *
   * 🔴 P2-1（D-2026-10-26-02）：**幂等**。已是 FINISHED 时直接返回当前 trip
   *    （`alreadyFinished: true`），不再 CAS → 不再 409。
   *    权限判定仍在幂等出口**之前** —— 否则非主导者能凭「已经完成了」拿到行程内容。
   */
  async finish(
    userId: bigint,
    tripId: bigint,
    input: { version: number; actual?: Record<string, unknown> },
  ): Promise<{ trip: Record<string, unknown>; updatedAt: string; alreadyFinished: boolean }> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertLeaderOrCreator(tx, t, userId);

      const r = await this.finishInternal(tx, t, {
        actorId: userId,
        reason: 'TRIP_FINISHED',
        action: 'trip.finish',
        expectedVersion: requireVersion(input.version),
        ...(input.actual !== undefined ? { actual: input.actual } : {}),
        onCasMiss: 'conflict',
      });

      return {
        trip: serializeRow(r.row, TRIP_BIGINT_FIELDS),
        updatedAt: timeOfIso(r.row['updatedAt']),
        alreadyFinished: r.alreadyFinished,
      };
    });
  }

  /**
   * 扫描并归档「已过期」的行程（D-2026-10-26-02 P0-1 方案 A）。
   *
   * 由进程内定时器（`common/scheduler/auto-finish.ts`）周期调用，也供单测直接驱动。
   * 每条行程**独立事务**：单条失败不影响其余，失败只记账不抛出。
   */
  async autoFinishExpired(opts: { batchLimit?: number } = {}): Promise<AutoFinishStats> {
    const limit = Math.max(1, opts.batchLimit ?? this.autoFinish.batchLimit);
    const stats: AutoFinishStats = { scanned: 0, finished: 0, skipped: 0, failed: 0 };

    const now = await this.o.ctx.read.dbNow();

    // 粗筛上界：任何时区的「今天 00:00」都不会晚于「UTC 当日 +1 天」，
    // 故用它做驱动层上界（走索引），再按每行自己的 timezone 精确判定。
    const coarseUpper = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const candidates = await this.o.ctx.read.findMany('trip', {
      where: {
        deletedAt: null,
        status: { in: [...AUTO_FINISH_STATUS] },
        // `not: null` 不能省：内存驱动把 null 当 -1 参与 lt 比较（恒真），
        // 而 SQL 的 `NULL < x` 恒假 —— 显式写出来才对得上口径。
        endDate: { not: null, lt: coarseUpper },
      },
    });

    const expired = candidates.filter((t) => isExpiredOn(t['endDate'], now, t['timezone']));
    stats.scanned = expired.length;

    for (const t of expired.slice(0, limit)) {
      const outcome = await this.tryAutoFinish(t['id'] as bigint);
      if (outcome.kind === 'finished') stats.finished += 1;
      else if (outcome.kind === 'failed') stats.failed += 1;
      else stats.skipped += 1;
    }

    return stats;
  }

  /**
   * 读路径惰性流转（方案 B）：只处理「本次即将返回的这几行」。
   *
   * 🔴 读路径写库的全部纪律都在这里：
   *    · 只碰候选行（已过期 + 状态可流转），不扩大范围；
   *    · 任何异常一律吞掉并返回空 Map —— 读接口的成功率优先级高于状态正确性
   *      （定时器会对同一个行程再补一次）；
   *    · 返回「归档后的新行」，调用方用它渲染，避免返回归档前的旧状态。
   */
  private async autoFinishOnRead(rows: readonly Row[]): Promise<Map<bigint, Row>> {
    const out = new Map<bigint, Row>();
    if (!this.autoFinish.lazyOnRead) return out;
    if (!rows.some((r) => isAutoFinishCandidate(r))) return out;

    try {
      const now = await this.o.ctx.read.dbNow();
      for (const row of rows) {
        if (!isAutoFinishCandidate(row)) continue;
        if (!isExpiredOn(row['endDate'], now, row['timezone'])) continue;
        const outcome = await this.tryAutoFinish(row['id'] as bigint);
        if (outcome.kind === 'finished') out.set(outcome.row['id'] as bigint, outcome.row);
      }
    } catch {
      // 降级：本页按「只读不改」返回，下一秒的定时器会补上
      return out;
    }
    return out;
  }

  /**
   * 归档单个过期行程（独立事务 + 幂等）。
   *
   * 事务内重读行程而非沿用入参行：候选集是读路径取的，期间可能已被手工 finish
   * 或被另一个实例归档 —— 以事务内读到的 `version/status` 为准。
   */
  private async tryAutoFinish(tripId: bigint): Promise<AutoFinishOutcome> {
    try {
      return await this.o.ctx.tx(async (tx) => {
        const t = await tx.db.findUnique('trip', { id: tripId, deletedAt: null });
        if (!t) return { kind: 'skipped' };
        if (!isAutoFinishCandidate(t)) return { kind: 'skipped' };

        const now = await tx.db.dbNow();
        if (!isExpiredOn(t['endDate'], now, t['timezone'])) return { kind: 'skipped' };

        const r = await this.finishInternal(tx, t, {
          // 无自然人操作 → 归到创建者名下，保证 audit 有归属（派发单 §P0-1 口径）
          actorId: t['createdBy'] as bigint,
          reason: 'TRIP_AUTO_FINISHED',
          action: 'trip.auto_finish',
          onCasMiss: 'treat-as-finished',
        });
        return r.alreadyFinished ? { kind: 'skipped' } : { kind: 'finished', row: r.row };
      });
    } catch (e) {
      // 单条失败不影响其余候选；进程内没有告警通道，落一条 warn 供运维侧捞
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[family-trip] 行程自动完结失败 trip=${tripId.toString()}：${msg}`);
      return { kind: 'failed' };
    }
  }

  /**
   * 归档实现本体 —— **唯一**一份（手工 / 定时 / 惰性三条入口共用）。
   *
   * 同事务四件事：
   *   1. trip.status = FINISHED（CAS 保护，`expectedVersion` 缺省取事务内读到的版本）
   *   2. trip.actual_json = 回顾快照（仅手工路径会带）
   *   3. **所有**成员 access_level → HISTORICAL_READONLY（不软删！历史要留人）
   *   4. change_log（UPDATE）+ audit_log（reason 区分手工/自动，便于对账）
   */
  private async finishInternal(
    tx: TxHandle,
    t: Row,
    opts: {
      actorId: bigint;
      reason: 'TRIP_FINISHED' | 'TRIP_AUTO_FINISHED';
      action: 'trip.finish' | 'trip.auto_finish';
      expectedVersion?: number;
      actual?: Record<string, unknown>;
      /** CAS 落空怎么处置：手工 → 409；自动 → 视为已完成（幂等，不报错） */
      onCasMiss: 'conflict' | 'treat-as-finished';
    },
  ): Promise<{ row: Row; alreadyFinished: boolean }> {
    const tripId = t['id'] as bigint;

    // 幂等出口：已归档 → 原样返回，不写 change_log / audit_log，不动 version
    if (t['status'] === 'FINISHED') return { row: t, alreadyFinished: true };

    const expectedVersion = opts.expectedVersion ?? requireVersion(t['version']);
    const now = await tx.db.dbNow();

    const affected = await tx.db.update(
      'trip',
      buildCasWhere({ id: tripId, expectedVersion, patch: {} }),
      {
        status: 'FINISHED',
        // 只在真的传了 actual 时才写这一列。
        // 早先是 `actualJson: opts.actual ? ... : (t['actualJson'] ?? null)`：
        // ① 没传 actual 时把一个**读出来的旧快照**原样写回，属于无谓列写；
        // ② 并发下 `t` 可能是旧快照，会把别人刚写进 actual_json 的内容覆盖回 null。
        // 不传该字段 = 保持库内原值，语义一致且没有回写风险。
        //
        // 🔴 直接传对象，**不要** `JSON.stringify`：`actual_json` 是 MySQL JSON 列，
        //    传字符串会被存成「JSON 字符串标量」（`"{\"a\":1}"`），读回来是 string
        //    而不是对象；再写一次就成了双重转义。
        //
        // 排查记录（D-2026-10-26-03）：线上 finish 500 的根因**不是**这里 ——
        //    `trip.service.create` 一直在写 `actualJson: null` 且建行程正常，
        //    说明 Prisma 的 `Json?` 列接受裸 null。真因是
        //    `trip_member.access_level` 列宽 16 < 'HISTORICAL_READONLY'(19)，
        //    见迁移 `20261026160000_enum_column_widths`。
        ...(opts.actual !== undefined ? { actualJson: opts.actual } : {}),
        updatedAt: now,
        version: expectedVersion + 1,
      },
    );

    if (affected === 0) {
      if (opts.onCasMiss === 'treat-as-finished') {
        // 并发下另一条路径已归档 → 视为成功，不重复写日志
        const row = await tx.db.findUnique('trip', { id: tripId });
        return { row: row ?? t, alreadyFinished: true };
      }
      assertCasSucceeded(affected, 'trip', expectedVersion);
    }

    // 成员全部转历史只读 —— 保留行，不删
    const members = await tx.db.findMany('tripMember', { where: { tripId, deletedAt: null } });
    for (const m of members) {
      await tx.db.update(
        'tripMember',
        { id: m['id'] },
        { accessLevel: 'HISTORICAL_READONLY', updatedAt: now },
      );
    }

    await this.change(tx, 'trip', tripId, t['familyId'] as bigint, tripId, 'UPDATE', now);

    await this.audit(tx, {
      actorId: opts.actorId,
      action: opts.action,
      reason: opts.reason,
      severity: 'INFO',
      targetType: 'trip',
      targetId: tripId,
      detail:
        opts.reason === 'TRIP_AUTO_FINISHED'
          ? { memberCount: members.length, trigger: 'AUTO_DATE_EXPIRED' }
          : { memberCount: members.length },
      at: now,
    });

    const row = await tx.db.findUnique('trip', { id: tripId });
    return { row: row ?? t, alreadyFinished: false };
  }

  // ── 内部 ────────────────────────────────────────────────

  private async assertFamilyMember(tx: TxHandle, familyId: bigint, userId: bigint): Promise<void> {
    const m = await tx.db.findUnique('familyMember', { familyId, userId, deletedAt: null });
    if (m) return;
    const managed = await tx.db.findMany('familyMember', {
      where: { familyId, managedBy: userId, deletedAt: null },
    });
    if (managed.length === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  /** 出行可见性：家庭成员 ∨ 出行成员 */
  private async assertTripVisible(
    src: TxHandle | DomainContext,
    t: Row,
    userId: bigint,
  ): Promise<void> {
    const db = 'db' in src ? src.db : src.read;
    const member = await db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (member) return;
    const fm = await db.findUnique('familyMember', {
      familyId: t['familyId'],
      userId,
      deletedAt: null,
    });
    if (fm) return;
    const managed = await db.findMany('tripMember', {
      where: { tripId: t['id'], managedBy: userId, deletedAt: null },
    });
    if (managed.length > 0) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  /** 可写校验：必须是出行 ACTIVE 成员（HISTORICAL_READONLY 拒写） */
  private async assertTripWritable(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const member = await tx.db.findUnique('tripMember', {
      tripId: t['id'],
      userId,
      deletedAt: null,
    });
    if (member) {
      if (member['accessLevel'] === 'HISTORICAL_READONLY') {
        throw new AppError(ErrorCode.FORBIDDEN, '该出行已归档，仅可查看');
      }
      return;
    }
    // 创建者即使成员行异常也放行
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async assertLeaderOrCreator(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const leader = await tx.db.findUnique('tripMember', {
      tripId: t['id'],
      userId,
      role: 'LEADER',
      deletedAt: null,
    });
    if (leader) return;
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.FORBIDDEN, '仅主导者可执行该操作');
  }

  /**
   * 行程成员判定（邀请码专用口径）：成员 ∨ 代管人，否则 403。
   *
   * 与 `assertTripVisible` 的区别：那里把「家庭成员」也算可见（只管看不暴露），
   * 这里**收紧到行程成员** —— 邀请码是「谁的行程、谁能拉人」的凭证，
   * 家庭成员的旁支访问不应拿到码。
   */
  private async assertTripMember(src: TxHandle, t: Row, userId: bigint): Promise<void> {
    const member = await src.db.findUnique('tripMember', {
      tripId: t['id'],
      userId,
      deletedAt: null,
    });
    if (member) return;
    const managed = await src.db.findMany('tripMember', {
      where: { tripId: t['id'], managedBy: userId, deletedAt: null },
    });
    if (managed.length > 0) return;
    throw new AppError(ErrorCode.FORBIDDEN, '仅行程成员可查看邀请码');
  }

  /**
   * 唯一邀请码（8 次重试 + 查重 + 失败抛 INTERNAL_ERROR）。
   *
   * 与 family 的 `uniqueInviteCode` 逐条对齐；查重范围是**活跃行程**
   * （`deletedAt: null`），软删行程持有的码可被复用（索引同样软删感知）。
   */
  private async uniqueTripInviteCode(tx: TxHandle): Promise<string> {
    for (let i = 0; i < 8; i += 1) {
      const code = randomInviteCode();
      const dup = await tx.db.findUnique('trip', { inviteCode: code, deletedAt: null });
      if (!dup) return code;
    }
    throw new AppError(ErrorCode.INTERNAL_ERROR, '邀请码生成失败，请重试');
  }

  private async displayNameOf(tx: TxHandle, userId: bigint): Promise<string> {
    const u = await tx.db.findUnique('user', { id: userId, deletedAt: null });
    return (u?.['nickname'] as string | undefined) ?? '成员';
  }

  private async visibleFamilyIds(userId: bigint): Promise<Set<bigint>> {
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

  private assertDateOrder(start?: string, end?: string): void {
    if (start && end && new Date(start).getTime() > new Date(end).getTime()) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '结束日期不能早于开始日期');
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

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
      targetType: string;
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
      targetType: e.targetType,
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}

function toDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * 是否属于「自动完结」的候选行：未软删 + 状态可流转 + 有结束日期。
 *
 * 三个条件缺一不可 —— 无 `endDate` 的行程没有「到期」这件事，
 * 只能靠手工 `POST /trips/:id/finish`。
 */
function isAutoFinishCandidate(row: Row): boolean {
  if ((row['deletedAt'] ?? null) !== null) return false;
  const status = row['status'];
  if (typeof status !== 'string') return false;
  if (!(AUTO_FINISH_STATUS as readonly string[]).includes(status)) return false;
  return row['endDate'] instanceof Date;
}

/**
 * 行程是否「已经过完最后一天」。
 *
 * 🔴 口径是**行程当地时间**，不是服务器日期：
 *    `end_date` 存的是当地日期（UTC 零点的 Date，见 C13/T-5 的时区解耦约定），
 *    一趟 Asia/Tokyo 的行程在服务器（Asia/Shanghai）眼里会早 1 小时「到期」，
 *    反之 UTC-x 的目的地会晚 —— 所以必须按行上的 `timezone` 算「今天」。
 *
 * 判定：`end_date < 当地今天 00:00` —— 结束日当天仍算「进行中」，
 * 出行回来的当天晚上正是补照片的窗口，不能早上就把行程锁了。
 */
function isExpiredOn(endDate: unknown, now: Date, timezone: unknown): boolean {
  if (!(endDate instanceof Date)) return false;
  const tz = typeof timezone === 'string' && timezone.length > 0 ? timezone : 'Asia/Shanghai';
  return endDate.getTime() < startOfTodayUtc(now, tz);
}

/** 指定时区的「今天 00:00」换算成 UTC 毫秒（用于与 `@db.Date` 列比较） */
function startOfTodayUtc(now: Date, timeZone: string): number {
  const [y, m, d] = ymdInZone(now, timeZone);
  return Date.UTC(y, m - 1, d);
}

/** 取某时刻在指定时区的年月日；非法时区回落 UTC（宁可早归档一天，不可崩读接口） */
function ymdInZone(at: Date, timeZone: string): [number, number, number] {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const pick = (type: string): number =>
      Number(parts.find((p) => p['type'] === type)?.value ?? NaN);
    const y = pick('year');
    const m = pick('month');
    const d = pick('day');
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) return [y, m, d];
  } catch {
    // 非法 timeZone → RangeError，落到下面的 UTC 回落分支
  }
  return [at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate()];
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * 把 Date / ISO 字符串统一成 ISO8601。
 *
 * 无法解析时返回 `''` 而**不是**「当前时刻」—— 邀请卡上的「重置时间」是
 * 给用户看的事实陈述，编一个 now 会让「码刚被谁重置过」的判断失真。
 * 实际数据里 `invite_updated_at ?? created_at` 恒可解析，此分支不可达。
 */
function timeOfIso(v: unknown): string {
  const t = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(t.getTime()) ? t.toISOString() : '';
}

function sameBigint(a: bigint | null, b: bigint | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a === b;
}
