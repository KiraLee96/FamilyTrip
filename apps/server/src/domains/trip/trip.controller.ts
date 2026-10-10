/**
 * trip 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { TripService } from './trip.service.js';
import {
  addTripMemberSchema,
  createTripSchema,
  finishTripSchema,
  leaveTripSchema,
  listTripQuerySchema,
  setLeaderSchema,
  updateTripMemberSchema,
  updateTripSchema,
  type CreateTripInput,
  type FinishTripInput,
  type LeaveTripInput,
  type ListTripQueryInput,
  type SetLeaderInput
} from './trip.schema.js';

export interface TripDomainOptions {
  ctx: DomainContext;
}

export interface TripDomain {
  routes: RouteSpec<never, unknown>[];
  service: TripService;
}

export function createTripDomain(o: TripDomainOptions): TripDomain {
  const service = new TripService({ ctx: o.ctx });

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
    {
      method: 'POST',
      path: '/trips/:id/finish',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE', ref: tripRef },
      schema: finishTripSchema as never,
      handler: async (ctx, input) => {
        const b = input as FinishTripInput;
        const r = await service.finish(ctx.userId!, ctx.resourceId!, { version: b.version, actual: b.actual });
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
          successorMemberId: b.successorMemberId !== undefined ? BigInt(b.successorMemberId) : undefined,
        });
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },
  ];

  return { routes, service };
}
