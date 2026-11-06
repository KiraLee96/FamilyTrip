/**
 * auth 域 · service
 * ============================================================================
 * 职责边界：
 *   · 微信 code → openid 的换取（抽象成 `WechatCodeExchanger`：
 *     生产接微信 /sns/jscode2session，测试注入桩）
 *   · 用户首次登录的**幂等注册**（openid 唯一键 + 软删语义）
 *   · 令牌签发 / 注销（软删 + 退家庭）
 *
 * 🔴 幂等注册的坑：
 *   `uk_openid` 是 `(openid, deleted_at)` 复合唯一键。用户注销后
 *   （deleted_at 非空）再次登录，会**插入新行**而非复用旧行 —— 这是有意为之：
 *   注销意味着「数据保留但账号作废」，重新登录应是全新账号。
 *   因此注册前必须先查 `deletedAt: null` 的行，查不到才插。
 *
 * 🔴 时间来源：全部取 `tx.db.dbNow()`。此处**不用** `new Date()`
 *   作为写路径时间，否则多实例时钟漂移会撕裂 change_log 游标（E2）。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row, TableDriver } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';

/** 微信 code2session 抽象 —— 便于测试注入 */
export interface WechatCodeExchanger {
  exchange(code: string): Promise<{ openid: string; unionid?: string } | null>;
}

export interface AuthServiceOptions {
  ctx: DomainContext;
  wechat: WechatCodeExchanger;
  signToken: (payload: { userId: string; iat: number }) => string;
  /** 令牌有效期（秒）—— 用于返回 expiresIn */
  tokenTtlSeconds: number;
  defaultTimezone?: string;
  /** 审计保留天数（M5） */
  auditRetentionDays?: number;
}

const USER_BIGINT_FIELDS = ['id'];

export interface AuthSession {
  token: string;
  expiresIn: number;
  user: Record<string, unknown>;
  /** 是否新注册 —— 客户端据此决定是否走 onboarding */
  isNewUser: boolean;
}

export class AuthService {
  private readonly retentionDays: number;

  constructor(private readonly o: AuthServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /**
   * 登录（含首登注册）。
   *
   *   1. code → openid（换取失败 → 4010，不暴露微信侧错误细节）
   *   2. 查活跃用户（openid + deletedAt:null）
   *   3. 不存在 → 注册；存在 → 补 unionid
   *   4. 签发令牌
   */
  async login(code: string): Promise<AuthSession> {
    const exchanged = await this.o.wechat.exchange(code);
    if (!exchanged) throw new AppError(ErrorCode.UNAUTHORIZED, '登录凭证无效');
    const { openid, unionid } = exchanged;

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const existing = await tx.db.findUnique('user', { openid, deletedAt: null });

      if (existing) {
        const patch: Row = {};
        if (unionid && existing['unionid'] !== unionid) patch['unionid'] = unionid;
        let row = existing;
        if (Object.keys(patch).length > 0) {
          await tx.db.update('user', { id: existing['id'] }, { ...patch, updatedAt: now });
          row = { ...existing, ...patch };
        }
        return this.session(row['id'] as bigint, row, false);
      }

      const id = tx.write.nextId();
      const row: Row = {
        id,
        openid,
        unionid: unionid ?? null,
        phone: null,
        nickname: defaultNickname(openid),
        homeTimezone: this.o.defaultTimezone ?? 'Asia/Shanghai',
        dekVersion: 1,
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      await tx.db.insert('user', row);

      // 注册是合规关注事件（M5），必须留审计
      await this.audit(tx, {
        actorId: id,
        action: 'auth.register',
        reason: 'FIRST_LOGIN',
        severity: 'INFO',
        targetId: id,
        at: now,
      });

      return this.session(id, row, true);
    });
  }

  /** 读本人资料 */
  async me(userId: bigint): Promise<Record<string, unknown>> {
    const row = await this.o.ctx.read.findUnique('user', { id: userId, deletedAt: null });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    return serializeRow(row, USER_BIGINT_FIELDS);
  }

  /** 更新本人资料 */
  async updateProfile(
    userId: bigint,
    // avatarUrl 与 nickname/homeTimezone 同为 user 表直写列（见 prisma schema 的 avatar_url）；
    // 本方法只做「通用 patch 透传 + 审计」，字段准入由 updateProfileSchema 把关。
    patch: { nickname?: string; avatarUrl?: string; homeTimezone?: string },
  ): Promise<{ user: Record<string, unknown>; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      // 改名前的昵称：用来判断成员行里的 `display_name` 是否还是「昵称的副本」
      const before = await tx.db.findUnique('user', { id: userId, deletedAt: null });
      const oldNickname = typeof before?.['nickname'] === 'string' ? before['nickname'] : null;

      const affected = await tx.db.update(
        'user',
        { id: userId, deletedAt: null },
        { ...patch, updatedAt: now },
      );
      if (affected === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      /**
       * 🔴 昵称与「家庭称呼」是两个独立字段（2026-11-06 产品口径）：
       *   · `user.nickname`        —— 账号昵称，本人可随时改，**权威源**
       *   · `familyMember.displayName` / `tripMember.displayName`
       *                            —— 家里/行程里的**称呼**（如「爸爸」「二姨」），
       *                               由家人设定，可以长期不动
       * 前端渲染成「昵称（主）+ 称呼（灰色副行）」，所以**不能无脑覆盖**称呼。
       *
       * 唯一要修的是「称呼其实只是昵称的副本、没人动过」这种情况：
       * 若不跟着改，用户改完昵称会看到「小满」下面还挂着一个灰色的「小明」——
       * 那不是称呼，是残留的旧昵称。
       *
       * 判据：`displayName === 旧昵称` 视为「没手改过」，跟着改；
       * 其余（家人设过的称呼）一律保留。不需要新增「是否手改」列。
       */
      const synced =
        patch.nickname !== undefined
          ? await this.syncMemberDisplayNames(tx, userId, oldNickname, patch.nickname, now)
          : undefined;

      await this.audit(tx, {
        actorId: userId,
        action: 'auth.update_profile',
        reason: 'PROFILE_CHANGED',
        severity: 'INFO',
        targetId: userId,
        detail: {
          fields: Object.keys(patch),
          ...(synced !== undefined
            ? {
                // 排查用：synced 是「跟着改的昵称副本」，kept 是「保留的称呼」
                syncedMemberRows: synced.synced,
                keptCustomMemberRows: synced.kept,
              }
            : {}),
        },
        at: now,
      });

      const row = await tx.db.findUnique('user', { id: userId });
      return {
        user: serializeRow(row ?? {}, USER_BIGINT_FIELDS),
        updatedAt: now.toISOString(),
      };
    });
  }

  /**
   * 昵称变更 → 同事务处理成员行里的 `display_name`（称呼）。
   *
   * 🔴 不是「全量覆盖」，而是**只改还没变成称呼的那些行**：
   *   · `displayName === 旧昵称` → 它只是加入时拷贝的昵称副本、没人动过，
   *     跟着改成新昵称（否则界面会出现「小满」+ 灰色「小明」这种幽灵旧名）；
   *   · `displayName !== 旧昵称` → 家人设过的称呼（「爸爸」「二姨」），**保留**。
   *
   * 这样不需要为「是否手改」新增列，也不需要数据迁移：判据是值相等，
   * 而「昵称副本」本来就是这个值。
   *
   * 只动 `user_id = 我` 且 `deleted_at IS NULL` 的行 —— 虚拟成员 / 外部同行者
   * 没有账号，名字是它唯一的标识，一个字都不碰。
   *
   * 逐行写 changeLog 的理由：family / trip 两域对成员的任何写操作都会写 change_log
   * （`family.service.addMember`、`trip.service.updateMember`）。这里不写就等于
   * 「实体变了、同步游标没动」，服务端 sync 域会漏掉这次变化。
   *
   * @param oldNickname 改名前的昵称（null = 之前没有昵称，无从比对，全部保留）
   */
  private async syncMemberDisplayNames(
    tx: TxHandle,
    userId: bigint,
    oldNickname: string | null,
    nickname: string,
    now: Date,
  ): Promise<{ synced: number; kept: number }> {
    const isNicknameCopy = (row: Row): boolean =>
      oldNickname !== null && row['displayName'] === oldNickname;

    const familyMembers = await tx.db.findMany('familyMember', {
      where: { userId, deletedAt: null },
    });
    const tripMembers = await tx.db.findMany('tripMember', { where: { userId, deletedAt: null } });

    // trip_member 没有 family_id 冗余列，change_log 的 family_id 需回查行程；
    // 用一次 IN 批量取，避免逐行 N+1。
    const tripIds = [...new Set(tripMembers.map((m) => m['tripId']))];
    const familyOfTrip = new Map<string, bigint>();
    if (tripIds.length > 0) {
      const trips = await tx.db.findMany('trip', { where: { id: tripIds } });
      for (const t of trips) {
        const familyId = t['familyId'];
        if (typeof familyId === 'bigint') familyOfTrip.set(String(t['id']), familyId);
      }
    }

    let synced = 0;
    let kept = 0;

    for (const m of familyMembers) {
      if (!isNicknameCopy(m)) {
        kept += 1;
        continue;
      }
      await tx.db.update(
        'familyMember',
        { id: m['id'] },
        { displayName: nickname, updatedAt: now },
      );
      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'family_member',
        entityId: m['id'],
        familyId: m['familyId'],
        tripId: null,
        op: 'UPDATE',
        changedAt: now,
        createdAt: now,
      });
      synced += 1;
    }

    for (const m of tripMembers) {
      if (!isNicknameCopy(m)) {
        kept += 1;
        continue;
      }
      await tx.db.update('tripMember', { id: m['id'] }, { displayName: nickname, updatedAt: now });
      await tx.db.insert('changeLog', {
        id: tx.write.nextId(),
        entityType: 'trip_member',
        entityId: m['id'],
        familyId: familyOfTrip.get(String(m['tripId'])) ?? null,
        tripId: m['tripId'],
        op: 'UPDATE',
        changedAt: now,
        createdAt: now,
      });
      synced += 1;
    }

    return { synced, kept };
  }

  /**
   * 注销（软删）。
   *
   * 🔴 两件事必须同事务：
   *   · `user.deleted_at = now`（账号作废，openid 唯一键让位）
   *   · 退出所有家庭（否则家庭里留一个「幽灵成员」）
   */
  async deactivate(userId: bigint, reason: string): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();

      const affected = await tx.db.update(
        'user',
        { id: userId, deletedAt: null },
        { deletedAt: now, status: 'DEACTIVATED', updatedAt: now },
      );
      if (affected === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const memberships = await tx.db.findMany('familyMember', {
        where: { userId, deletedAt: null },
      });
      for (const m of memberships) {
        await tx.db.update('familyMember', { id: m['id'] }, { deletedAt: now });
      }

      await this.audit(tx, {
        actorId: userId,
        action: 'auth.deactivate',
        reason: reason || 'USER_REQUESTED',
        severity: 'WARN',
        targetId: userId,
        detail: { familyCount: memberships.length },
        at: now,
      });

      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private session(userId: bigint, user: Row, isNewUser: boolean): AuthSession {
    const iat = Math.floor(Date.now() / 1000);
    return {
      token: this.o.signToken({ userId: userId.toString(), iat }),
      expiresIn: this.o.tokenTtlSeconds,
      user: serializeRow(user, USER_BIGINT_FIELDS),
      isNewUser,
    };
  }

  private async audit(
    tx: { db: TableDriver; write: { nextId: () => bigint } },
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
      targetType: 'user',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}

function defaultNickname(openid: string): string {
  // 不泄露 openid 全文 —— 只取尾 4 位做默认昵称
  return `用户${openid.slice(-4)}`;
}
