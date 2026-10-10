/**
 * wish 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { WishService } from './wish.service.js';
import {
  createWishSchema,
  listWishQuerySchema,
  updateWishSchema,
  voteWishSchema,
  wishToTripSchema,
  type CreateWishInput,
  type ListWishQueryInput,
  type VoteWishInput,
  type WishToTripInput,
} from './wish.schema.js';

export interface WishDomainOptions {
  ctx: DomainContext;
}

export interface WishDomain {
  routes: RouteSpec<never, unknown>[];
  service: WishService;
}

export function createWishDomain(o: WishDomainOptions): WishDomain {
  const service = new WishService({ ctx: o.ctx });

  const routes: RouteSpec<never, unknown>[] = [
    // ── 创建 ───────────────────────────────────────────────
    {
      method: 'POST',
      path: '/wishes',
      auth: { public: false, resourceType: 'wish', mode: 'WRITE' },
      idParam: '__none__',
      schema: createWishSchema as never,
      handler: async (ctx, input) => {
        const body = input as CreateWishInput;
        const wish = await service.create(ctx.userId!, {
          familyId: BigInt(body.familyId),
          tripId: body.tripId !== undefined ? BigInt(body.tripId) : undefined,
          title: body.title,
          description: body.description,
          priority: body.priority,
        });
        return { data: { wish } };
      },
    },

    // ── 列表 ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/wishes',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listWishQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListWishQueryInput;
        const r = await service.list(ctx.userId!, {
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          status: q.status,
          unplannedOnly: q.unplannedOnly,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    // ── 详情 ───────────────────────────────────────────────
    {
      method: 'GET',
      path: '/wishes/:id',
      auth: {
        public: false,
        resourceType: 'wish',
        mode: 'READ',
        ref: (id, _req, r) => ({ type: 'wish', id, familyId: r.familyId, tripId: r.tripId }),
      },
      handler: async (ctx) => {
        const r = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: r };
      },
    },

    // ── 更新 ───────────────────────────────────────────────
    {
      method: 'PATCH',
      path: '/wishes/:id',
      auth: {
        public: false,
        resourceType: 'wish',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'wish', id, familyId: r.familyId, tripId: r.tripId }),
      },
      schema: updateWishSchema as never,
      handler: async (ctx, input) => {
        const wish = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { wish } };
      },
    },

    // ── 删除 ───────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/wishes/:id',
      auth: {
        public: false,
        resourceType: 'wish',
        mode: 'DELETE',
        ref: (id, _req, r) => ({ type: 'wish', id, familyId: r.familyId, tripId: r.tripId }),
      },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 投票 ───────────────────────────────────────────────
    {
      method: 'POST',
      path: '/wishes/:id/vote',
      auth: {
        public: false,
        resourceType: 'wish',
        mode: 'WRITE',
        ref: (id, _req, r) => ({ type: 'wish', id, familyId: r.familyId, tripId: r.tripId }),
      },
      schema: voteWishSchema as never,
      handler: async (ctx, input) => {
        const r = await service.vote(ctx.userId!, ctx.resourceId!, (input as VoteWishInput).vote);
        return { data: r };
      },
    },

    // ── 心愿 → 出行草稿 ────────────────────────────────────
    {
      method: 'POST',
      path: '/wishes/to-trip-draft',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE' },
      idParam: '__none__',
      schema: wishToTripSchema as never,
      handler: async (ctx, input) => {
        const body = input as WishToTripInput;
        const r = await service.toTripDraft(ctx.userId!, {
          familyId: BigInt(body.familyId),
          wishIds: body.wishIds?.map((s) => BigInt(s)),
          title: body.title,
          startDate: body.startDate,
          endDate: body.endDate,
          timezone: body.timezone,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
