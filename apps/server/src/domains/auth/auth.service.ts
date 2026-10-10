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
import type { DomainContext } from '../domain-context.js';
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
    patch: { nickname?: string; homeTimezone?: string },
  ): Promise<{ user: Record<string, unknown>; updatedAt: string }> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const affected = await tx.db.update(
        'user',
        { id: userId, deletedAt: null },
        { ...patch, updatedAt: now },
      );
      if (affected === 0) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      await this.audit(tx, {
        actorId: userId,
        action: 'auth.update_profile',
        reason: 'PROFILE_CHANGED',
        severity: 'INFO',
        targetId: userId,
        detail: { fields: Object.keys(patch) },
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
