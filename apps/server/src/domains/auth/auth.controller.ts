/**
 * auth 域 · controller（薄层）
 * ============================================================================
 * Controller 只做三件事：声明路由元数据、取原始入参、调用 service。
 * **不出现任何 if/else 业务判断** —— 这是 CI 门禁可机械校验的约束。
 *
 * ⛔ 所有返回的 data 里，bigint 一律已转 string（`serializeRow`），
 *    否则 `JSON.stringify` 会抛 `Do not know how to serialize a BigInt`。
 */

import { ok, type Envelope } from '../../common/envelope/envelope.js';
import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { AuthService, type WechatCodeExchanger } from './auth.service.js';
import {
  deactivateSchema,
  loginSchema,
  updateProfileSchema,
  type DeactivateInput,
  type LoginInput
} from './auth.schema.js';

export interface AuthDomainOptions {
  ctx: DomainContext;
  wechat: WechatCodeExchanger;
  signToken: (payload: { userId: string; iat: number }) => string;
  tokenTtlSeconds: number;
  defaultTimezone?: string;
}

export interface AuthDomain {
  routes: RouteSpec<never, unknown>[];
  service: AuthService;
}

export function createAuthDomain(o: AuthDomainOptions): AuthDomain {
  const service = new AuthService({
    ctx: o.ctx,
    wechat: o.wechat,
    signToken: o.signToken,
    tokenTtlSeconds: o.tokenTtlSeconds,
    defaultTimezone: o.defaultTimezone,
  });

  const routes: RouteSpec<never, unknown>[] = [
    // ── 登录（公开）────────────────────────────────────────
    {
      method: 'POST',
      path: '/auth/login',
      auth: { public: true },
      schema: loginSchema as never,
      handler: async (_ctx, input) => {
        const session = await service.login((input as LoginInput).code);
        return { data: session };
      },
    },

    // ── 本人资料 ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/auth/me',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__', // 无路径参数 → 跳过 withOwner，权限由 userId 自证
      handler: async (ctx) => {
        const user = await service.me(ctx.userId!);
        return { data: { user } };
      },
    },

    {
      method: 'PATCH',
      path: '/auth/me',
      auth: { public: false, resourceType: 'user', mode: 'WRITE' },
      idParam: '__none__',
      schema: updateProfileSchema as never,
      handler: async (ctx, input) => {
        const r = await service.updateProfile(ctx.userId!, input);
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },

    // ── 注销（软删）────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/auth/me',
      auth: { public: false, resourceType: 'user', mode: 'DELETE' },
      idParam: '__none__',
      schema: deactivateSchema as never,
      handler: async (ctx, input) => {
        const at = await service.deactivate(ctx.userId!, (input as DeactivateInput).reason ?? '');
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}

/** 供健康检查与测试使用的信封包装（保持形状一致） */
export function authOk<T>(data: T): Envelope<T> {
  return ok(data);
}
