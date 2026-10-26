/**
 * trip 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { TripService } from './trip.service.js';
import type { TripServiceOptions } from './trip.service.js';
import {
  addTripMemberSchema,
  createTripSchema,
  finishTripSchema,
  joinTripSchema,
  leaveTripSchema,
  listTripQuerySchema,
  setLeaderSchema,
  updateTripMemberSchema,
  updateTripSchema,
  type CreateTripInput,
  type FinishTripInput,
  type JoinTripInput,
  type LeaveTripInput,
  type ListTripQueryInput,
  type SetLeaderInput,
} from './trip.schema.js';

export interface TripDomainOptions {
  ctx: DomainContext;
  /** D-2026-10-26-02 P0-1：自动完结开关（组合根从环境变量解析后注入） */
  autoFinish?: TripServiceOptions['autoFinish'];
}

export interface TripDomain {
  routes: RouteSpec<never, unknown>[];
  service: TripService;
}

export function createTripDomain(o: TripDomainOptions): TripDomain {
  const service = new TripService({
    ctx: o.ctx,
    ...(o.autoFinish !== undefined ? { autoFinish: o.autoFinish } : {}),
  });

  const tripRef = (id: bigint): { type: 'trip'; id: bigint; familyId: null; tripId: bigint } => ({
    type: 'trip',
    id,
    familyId: null,
    tripId: id,
  });

  const routes: RouteSpec<never, unknown>[] = [
    // ── 创建 / 列表 ────────────────────────────────────────
    {
      method: 'POST',
      path: '/trips',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE' },
      idParam: '__none__',
      schema: createTripSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateTripInput;
        const trip = await service.create(ctx.userId!, {
          familyId: BigInt(b.familyId),
          title: b.title,
          startDate: b.startDate,
          endDate: b.endDate,
          timezone: b.timezone,
          destinations: b.destinations,
        });
        return { data: { trip } };
      },
    },

    {
      method: 'GET',
      path: '/trips',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listTripQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListTripQueryInput;
        const r = await service.list(ctx.userId!, {
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          status: q.status,
          mineOnly: q.mineOnly,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    // ── 详情 ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/trips/:id',
      auth: { public: false, resourceType: 'trip', mode: 'READ', ref: tripRef },
      handler: async (ctx) => {
        const r = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: r };
      },
    },

    // ── 更新（CAS）─────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/trips/:id',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE', ref: tripRef },
      schema: updateTripSchema as never,
      handler: async (ctx, input) => {
        const r = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },

    // ── 删除 ───────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/trips/:id',
      auth: { public: false, resourceType: 'trip', mode: 'DELETE', ref: tripRef },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 结束（B6 归档）─────────────────────────────────────
    //
    // 🔴 D-2026-10-26-02 P2-1：网关模式声明为 **READ**，而不是 WRITE。
    //
    //    原因：归档后成员 `access_level` 已转 HISTORICAL_READONLY，网关
    //    （`checkShared`）对「历史只读 + WRITE」直接 Deny → 转 404 同形拒，
    //    请求根本到不了 service 的幂等出口 —— 表现就是「已完成的行程再点一次
    //    标记完成 → 404」，而派发单要的是「已经完成了，正常返回」。
    //
    //    这样做**没有降低鉴权强度**，因为真正的写权限判定在 service 里：
    //      · `assertLeaderOrCreator` —— 仅主导者/创建者，其余 403；
    //      · CAS —— 版本不符 409；
    //      · 网关仍拦「非行程成员」（trip 维度不放行 → 404）。
    //    放宽的只是「已是成员的归档行程成员能否到达这个幂等确认」这一步，
    //    而他们对这趟行程本来就有读权限，不构成信息增量。
    //
    //    ⛔ 若将来把这个路由改回 WRITE，必须同时想清楚 P2-1 怎么满足
    //       （否则前端「已完成后点一下」会退回 404）。
    {
      method: 'POST',
      path: '/trips/:id/finish',
      auth: { public: false, resourceType: 'trip', mode: 'READ', ref: tripRef },
      schema: finishTripSchema as never,
      handler: async (ctx, input) => {
        const b = input as FinishTripInput;
        const r = await service.finish(ctx.userId!, ctx.resourceId!, {
          version: b.version,
          actual: b.actual,
        });
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },

    // ── 成员：加 ───────────────────────────────────────────
    {
      method: 'POST',
      path: '/trips/:id/members',
      auth: { public: false, resourceType: 'trip_member', mode: 'WRITE', ref: tripRef },
      schema: addTripMemberSchema as never,
      handler: async (ctx, input) => {
        const member = await service.addMember(ctx.userId!, ctx.resourceId!, input);
        return { data: { member } };
      },
    },

    // ── 成员：改 ───────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/trips/members/:id',
      auth: {
        public: false,
        resourceType: 'trip_member',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'trip_member', id, familyId: r.familyId, tripId: r.tripId }),
      },
      schema: updateTripMemberSchema as never,
      handler: async (ctx, input) => {
        const member = await service.updateMember(ctx.userId!, ctx.resourceId!, input);
        return { data: { member } };
      },
    },

    // ── 成员：移除 ─────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/trips/members/:id',
      auth: {
        public: false,
        resourceType: 'trip_member',
        mode: 'DELETE',
        ref: (id, _req, r) => ({ type: 'trip_member', id, familyId: r.familyId, tripId: r.tripId }),
      },
      handler: async (ctx) => {
        const at = await service.removeMember(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 设主导者（E8）───────────────────────────────────────
    {
      method: 'POST',
      path: '/trips/:id/leader',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE', ref: tripRef },
      schema: setLeaderSchema as never,
      handler: async (ctx, input) => {
        const b = input as SetLeaderInput;
        const trip = await service.setLeader(ctx.userId!, ctx.resourceId!, {
          leaderMemberId: BigInt(b.leaderMemberId),
          // 显式判 undefined / null：`expectLeaderId` 是 nullable().optional()，
          // 两者含义不同（未提供 vs 显式清空），不能用 `!= null` 混同。
          expectLeaderId:
            b.expectLeaderId === undefined || b.expectLeaderId === null
              ? undefined
              : BigInt(b.expectLeaderId),
        });
        return { data: { trip } };
      },
    },

    // ── 离队（E8 退位判定）─────────────────────────────────
    {
      method: 'POST',
      path: '/trips/:id/leave',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE', ref: tripRef },
      schema: leaveTripSchema as never,
      handler: async (ctx, input) => {
        const b = input as LeaveTripInput;
        const r = await service.leave(ctx.userId!, ctx.resourceId!, {
          successorMemberId:
            b.successorMemberId !== undefined ? BigInt(b.successorMemberId) : undefined,
        });
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },

    // ── 邀请码：取（成员可读）──────────────────────────────
    {
      method: 'GET',
      path: '/trips/:id/invite',
      auth: { public: false, resourceType: 'trip', mode: 'READ', ref: tripRef },
      handler: async (ctx) => ({ data: await service.getInvite(ctx.userId!, ctx.resourceId!) }),
    },

    // ── 邀请码：重置（旧码作废）────────────────────────────
    {
      method: 'POST',
      path: '/trips/:id/invite/reset',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE', ref: tripRef },
      handler: async (ctx) => ({ data: await service.resetInvite(ctx.userId!, ctx.resourceId!) }),
    },

    // ── 凭码加入（外部同行者；GRP-02）──────────────────────
    // 与 POST /families/join 完全同构：需登录，但不要求已是该行程成员
    // （加入后才成为成员）。`idParam: '__none__'` 让链条第 5 段跳过资源归属解析。
    {
      method: 'POST',
      path: '/trips/join',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE' },
      idParam: '__none__',
      schema: joinTripSchema as never,
      handler: async (ctx, input) => {
        const b = input as JoinTripInput;
        return { data: await service.joinByInvite(ctx.userId!, b) };
      },
    },
  ];

  return { routes, service };
}
