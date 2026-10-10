/**
 * item 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { ItemService } from './item.service.js';
import {
  createItemSchema,
  listItemQuerySchema,
  updateItemSchema,
  type CreateItemInput,
  type ListItemQueryInput
} from './item.schema.js';

export interface ItemDomainOptions {
  ctx: DomainContext;
}

export interface ItemDomain {
  routes: RouteSpec<never, unknown>[];
  service: ItemService;
}

export function createItemDomain(o: ItemDomainOptions): ItemDomain {
  const service = new ItemService({ ctx: o.ctx });
  // PRIVATE 域：ref 里必须带 ownerId，链条第 5 段已从资源行解析出真实 ownerId
  /**
   * 🔴 PRIVATE 短路只认 `ownerId` / `managedBy`，不参与家庭、出行 OR 合并。
   *    写死 `ownerId: null` 会让本人访问自己的物品也被 404。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'item'; id: bigint; ownerId: bigint | null; managedBy: bigint | null } => ({
    type: 'item',
    id,
    ownerId: resolved.ownerId,
    managedBy: resolved.managedBy,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/items',
      auth: { public: false, resourceType: 'item', mode: 'WRITE' },
      idParam: '__none__',
      schema: createItemSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateItemInput;
        const item = await service.create(ctx.userId!, {
          familyId: BigInt(b.familyId),
          name: b.name,
          category: b.category,
          quantity: b.quantity,
          note: b.note,
          ownerId: b.ownerId !== undefined ? BigInt(b.ownerId) : undefined,
        });
        return { data: { item } };
      },
    },

    {
      method: 'GET',
      path: '/items',
      auth: { public: false, resourceType: 'item', mode: 'READ' },
      idParam: '__none__',
      schema: listItemQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListItemQueryInput;
        const r = await service.list(ctx.userId!, {
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          category: q.category,
          mineOnly: q.mineOnly,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/items/:id',
      auth: { public: false, resourceType: 'item', mode: 'READ', ref },
      handler: async (ctx) => {
        const item = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: { item } };
      },
    },

    {
      method: 'PATCH',
      path: '/items/:id',
      auth: { public: false, resourceType: 'item', mode: 'WRITE', ref },
      schema: updateItemSchema as never,
      handler: async (ctx, input) => {
        const item = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { item } };
      },
    },

    {
      method: 'DELETE',
      path: '/items/:id',
      auth: { public: false, resourceType: 'item', mode: 'DELETE', ref },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
