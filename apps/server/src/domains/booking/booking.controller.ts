/**
 * booking 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { BookingService, type BookingServiceOptions } from './booking.service.js';
import {
  createBookingSchema,
  findByOrderNoSchema,
  listBookingQuerySchema,
  updateBookingSchema,
  type CreateBookingInput,
  type FindByOrderNoInput,
  type ListBookingQueryInput
} from './booking.schema.js';

export interface BookingDomainOptions {
  ctx: DomainContext;
  cryptoFor: BookingServiceOptions['cryptoFor'];
}

export interface BookingDomain {
  routes: RouteSpec<never, unknown>[];
  service: BookingService;
}

export function createBookingDomain(o: BookingDomainOptions): BookingDomain {
  const service = new BookingService({ ctx: o.ctx, cryptoFor: o.cryptoFor });
  /**
   * 🔴 归属维度必须透传链在 withOwner 段读到的 `resolved`。
   *    写死 `familyId: null` 会让 SHARED_FAMILY 判定永远失败——
   *    表现为「自己是成员却被 404」，是最难查的一类权限 bug。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'booking'; id: bigint; familyId: bigint | null; tripId: bigint | null } => ({
    type: 'booking',
    id,
    familyId: resolved.familyId,
    tripId: resolved.tripId,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/bookings',
      auth: { public: false, resourceType: 'booking', mode: 'WRITE' },
      idParam: '__none__',
      schema: createBookingSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateBookingInput;
        const booking = await service.create(ctx.userId!, {
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
          type: b.type,
          title: b.title,
          provider: b.provider,
          orderNo: b.orderNo,
          orderLink: b.orderLink,
          contact: b.contact,
          startAt: b.startAt,
          endAt: b.endAt,
          amount: b.amount,
          currency: b.currency,
          note: b.note,
        });
        return { data: { booking } };
      },
    },

    {
      method: 'GET',
      path: '/bookings',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listBookingQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListBookingQueryInput;
        const r = await service.list(ctx.userId!, {
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          type: q.type,
          status: q.status,
          includeSecrets: q.includeSecrets,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'POST',
      path: '/bookings/find-by-order-no',
      auth: { public: false, resourceType: 'booking', mode: 'READ' },
      idParam: '__none__',
      schema: findByOrderNoSchema as never,
      handler: async (ctx, input) => {
        const b = input as FindByOrderNoInput;
        const r = await service.findByOrderNo(ctx.userId!, {
          orderNo: b.orderNo,
          familyId: BigInt(b.familyId),
          tripId: BigInt(b.tripId),
        });
        return { data: r };
      },
    },

    {
      method: 'GET',
      path: '/bookings/:id',
      auth: { public: false, resourceType: 'booking', mode: 'READ', ref },
      handler: async (ctx) => {
        const booking = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: { booking } };
      },
    },

    {
      method: 'PATCH',
      path: '/bookings/:id',
      auth: { public: false, resourceType: 'booking', mode: 'WRITE', ref },
      schema: updateBookingSchema as never,
      handler: async (ctx, input) => {
        const booking = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { booking } };
      },
    },

    {
      method: 'DELETE',
      path: '/bookings/:id',
      auth: { public: false, resourceType: 'booking', mode: 'DELETE', ref },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
