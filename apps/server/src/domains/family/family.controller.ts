/**
 * family 域 · controller（薄层）
 * ============================================================================
 * Controller 只做三件事：声明路由元数据、取原始入参、调用 service。
 * **不出现业务判断** —— 这是 CI 门禁可机械校验的约束。
 *
 * 关于「谁提供 familyId」：
 *   有 `:id` 的路径 → 链条第 5 段已解析出 `ctx.resourceId`，直接用。
 *   无 `:id` 的写接口（create/join）→ 资源尚不存在，body 里的 familyId
 *   只作**候选**；service 内用 `assertOwner/assertMember` 复核，双重保险。
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { FamilyService } from './family.service.js';
import {
  addMemberSchema,
  createFamilySchema,
  joinFamilySchema,
  listQuerySchema,
  transferOwnershipSchema,
  updateFamilySchema,
  updateMemberSchema,
  type TransferOwnershipInput
} from './family.schema.js';

export interface FamilyDomainOptions {
  ctx: DomainContext;
  generateInviteCode?: () => string;
}

export interface FamilyDomain {
  routes: RouteSpec<never, unknown>[];
  service: FamilyService;
}

export function createFamilyDomain(o: FamilyDomainOptions): FamilyDomain {
  const service = new FamilyService({ ctx: o.ctx, generateInviteCode: o.generateInviteCode });

  const routes: RouteSpec<never, unknown>[] = [
    // ── 列表（本人维度）────────────────────────────────────
    {
      method: 'GET',
      path: '/families',
      // 资源是「我」，链上不解析 :id；登录校验仍生效
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listQuerySchema as never,
      handler: async (ctx, input) => {
        const r = await service.listMine(ctx.userId!, input);
        return { data: r, meta: r.meta };
      },
    },

    // ── 创建 ───────────────────────────────────────────────
    {
      method: 'POST',
      path: '/families',
      auth: { public: false, resourceType: 'family', mode: 'WRITE' },
      idParam: '__none__',
      schema: createFamilySchema as never,
      handler: async (ctx, input) => {
        const family = await service.create(ctx.userId!, input);
        return { data: { family } };
      },
    },

    // ── 加入 ───────────────────────────────────────────────
    {
      method: 'POST',
      path: '/families/join',
      auth: { public: false, resourceType: 'family', mode: 'WRITE' },
      idParam: '__none__',
      schema: joinFamilySchema as never,
      handler: async (ctx, input) => {
        const r = await service.join(ctx.userId!, input);
        return { data: r };
      },
    },

    // ── 详情 ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/families/:id',
      auth: {
        public: false,
        resourceType: 'family',
        mode: 'READ',
        ref: (id, _req, r) => ({ type: 'family', id, familyId: r.familyId ?? id, tripId: null }),
      },
      handler: async (ctx) => {
        const r = await service.detail(ctx.resourceId!);
        return { data: r };
      },
    },

    // ── 改名 ───────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/families/:id',
      auth: {
        public: false,
        resourceType: 'family',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'family', id, familyId: r.familyId ?? id, tripId: null }),
      },
      schema: updateFamilySchema as never,
      handler: async (ctx, input) => {
        const family = await service.update(ctx.resourceId!, ctx.userId!, input);
        return { data: { family } };
      },
    },

    // ── 解散 ───────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/families/:id',
      auth: {
        public: false,
        resourceType: 'family',
        mode: 'DELETE',
        ref: (id, _req, r) => ({ type: 'family', id, familyId: r.familyId ?? id, tripId: null }),
      },
      handler: async (ctx) => {
        const at = await service.dissolve(ctx.resourceId!, ctx.userId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 转让户主 ───────────────────────────────────────────
    {
      method: 'POST',
      path: '/families/:id/transfer-ownership',
      auth: {
        public: false,
        resourceType: 'family',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'family', id, familyId: r.familyId ?? id, tripId: null }),
      },
      schema: transferOwnershipSchema as never,
      handler: async (ctx, input) => {
        const familyId = ctx.resourceId!;
        const body = input as TransferOwnershipInput;
        const family = await service.transferOwnership(
          familyId,
          ctx.userId!,
          BigInt(body.newOwnerMemberId),
        );
        return { data: { family } };
      },
    },

    // ── 成员：新增 ─────────────────────────────────────────
    {
      method: 'POST',
      path: '/families/:id/members',
      auth: {
        public: false,
        resourceType: 'family_member',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'family_member', id, familyId: r.familyId, tripId: null }),
      },
      schema: addMemberSchema as never,
      handler: async (ctx, input) => {
        const member = await service.addMember(ctx.resourceId!, ctx.userId!, input);
        return { data: { member } };
      },
    },

    // ── 成员：改 ───────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/families/members/:id',
      auth: {
        public: false,
        resourceType: 'family_member',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'family_member', id, familyId: r.familyId, tripId: null }),
      },
      schema: updateMemberSchema as never,
      handler: async (ctx, input) => {
        const member = await service.updateMember(ctx.resourceId!, ctx.userId!, input);
        return { data: { member } };
      },
    },

    // ── 成员：移除/退出 ────────────────────────────────────
    {
      method: 'DELETE',
      path: '/families/members/:id',
      auth: {
        public: false,
        resourceType: 'family_member',
        mode: 'DELETE',
        ref: (id, _req, r) => ({ type: 'family_member', id, familyId: r.familyId, tripId: null }),
      },
      handler: async (ctx) => {
        const at = await service.removeMember(ctx.resourceId!, ctx.userId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
