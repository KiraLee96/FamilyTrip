/**
 * itinerary 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { ItineraryService } from './itinerary.service.js';
import {
  createItineraryItemSchema,
  listItineraryQuerySchema,
  reorderItinerarySchema,
  updateItineraryItemSchema,
  type CreateItineraryItemInput,
  type ListItineraryQueryInput,
  type ReorderItineraryInput
} from './itinerary.schema.js';

export interface ItineraryDomainOptions {
  ctx: DomainContext;
}

export interface ItineraryDomain {
  routes: RouteSpec<never, unknown>[];
  service: ItineraryService;
}

export function createItineraryDomain(o: ItineraryDomainOptions): ItineraryDomain {
  const service = new ItineraryService({ ctx: o.ctx });
  const itemRef = (id: bigint): { type: 'itinerary_item'; id: bigint; familyId: null; tripId: null } => ({
    type: 'itinerary_item',
    id,
    familyId: null,
    tripId: null,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/itineraries',
      auth: { public: false, resourceType: 'itinerary_item', mode: 'WRITE' },
      idParam: '__none__',
      schema: createItineraryItemSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateItineraryItemInput;
        const item = await service.create(ctx.userId!, {
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
          title: b.title,
          startAt: b.startAt,
          endAt: b.endAt,
          location: b.location,
          note: b.note,
          sort: b.sort,
          amount: b.amount,
          currency: b.currency,
          rateSource: b.rateSource,
        });
        return { data: { item } };
      },
    },

    {
      method: 'GET',
      path: '/itineraries',
      auth: { public: false, resourceType: 'trip', mode: 'READ', ref: (id, _req, r) => ({ type: 'trip', id, familyId: r.familyId, tripId: r.tripId ?? id }) },
      idParam: '__none__',
      schema: listItineraryQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListItineraryQueryInput;
        const r = await service.list(ctx.userId!, {
          tripId: BigInt(q.tripId),
          date: q.date,
          from: q.from,
          to: q.to,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/itineraries/:id',
      auth: { public: false, resourceType: 'itinerary_item', mode: 'READ', ref: itemRef },
      handler: async (ctx) => {
        const item = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: { item } };
      },
    },

    {
      method: 'PATCH',
      path: '/itineraries/:id',
      auth: { public: false, resourceType: 'itinerary_item', mode: 'WRITE', ref: itemRef },
      schema: updateItineraryItemSchema as never,
      handler: async (ctx, input) => {
        const item = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { item } };
      },
    },

    {
      method: 'DELETE',
      path: '/itineraries/:id',
      auth: { public: false, resourceType: 'itinerary_item', mode: 'DELETE', ref: itemRef },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    {
      method: 'POST',
      path: '/itineraries/reorder',
      auth: { public: false, resourceType: 'itinerary_item', mode: 'WRITE' },
      idParam: '__none__',
      schema: reorderItinerarySchema as never,
      handler: async (ctx, input) => {
        const b = input as ReorderItineraryInput;
        const r = await service.reorder(ctx.userId!, { tripId: BigInt(b.tripId), orders: b.orders });
        return { data: r, meta: { updatedAt: r.updatedAt } };
      },
    },
  ];

  return { routes, service };
}
