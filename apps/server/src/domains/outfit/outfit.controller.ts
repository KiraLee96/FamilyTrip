/**
 * outfit 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { OutfitService } from './outfit.service.js';
import {
  createOutfitSchema,
  listOutfitQuerySchema,
  updateOutfitSchema,
  type CreateOutfitInput,
  type ListOutfitQueryInput
} from './outfit.schema.js';

export interface OutfitDomainOptions {
  ctx: DomainContext;
}

export interface OutfitDomain {
  routes: RouteSpec<never, unknown>[];
  service: OutfitService;
}

export function createOutfitDomain(o: OutfitDomainOptions): OutfitDomain {
  const service = new OutfitService({ ctx: o.ctx });
  /**
   * 🔴 PRIVATE 短路只认 `ownerId` / `managedBy`，不参与家庭、出行 OR 合并。
   *    写死 `ownerId: null` 会让本人访问自己的物品也被 404。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'outfit'; id: bigint; ownerId: bigint | null; managedBy: bigint | null } => ({
    type: 'outfit',
    id,
    ownerId: resolved.ownerId,
    managedBy: resolved.managedBy,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/outfits',
      auth: { public: false, resourceType: 'outfit', mode: 'WRITE' },
      idParam: '__none__',
      schema: createOutfitSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateOutfitInput;
        const outfit = await service.create(ctx.userId!, {
          familyId: BigInt(b.familyId),
          name: b.name,
          note: b.note,
          tripId: b.tripId !== undefined ? BigInt(b.tripId) : undefined,
          ownerId: b.ownerId !== undefined ? BigInt(b.ownerId) : undefined,
          itemIds: b.itemIds,
        });
        return { data: { outfit } };
      },
    },

    {
      method: 'GET',
      path: '/outfits',
      auth: { public: false, resourceType: 'outfit', mode: 'READ' },
      idParam: '__none__',
      schema: listOutfitQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListOutfitQueryInput;
        const r = await service.list(ctx.userId!, {
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          mineOnly: q.mineOnly,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/outfits/:id',
      auth: { public: false, resourceType: 'outfit', mode: 'READ', ref },
      handler: async (ctx) => {
        const outfit = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: { outfit } };
      },
    },

    {
      method: 'PATCH',
      path: '/outfits/:id',
      auth: { public: false, resourceType: 'outfit', mode: 'WRITE', ref },
      schema: updateOutfitSchema as never,
      handler: async (ctx, input) => {
        const outfit = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { outfit } };
      },
    },

    {
      method: 'DELETE',
      path: '/outfits/:id',
      auth: { public: false, resourceType: 'outfit', mode: 'DELETE', ref },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
