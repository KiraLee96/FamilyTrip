/**
 * checklist 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { ChecklistService } from './checklist.service.js';
import {
  applyTemplateSchema,
  batchToggleSchema,
  createChecklistItemSchema,
  createTemplateSchema,
  listChecklistQuerySchema,
  toggleChecklistItemSchema,
  updateChecklistItemSchema,
  type ApplyTemplateInput,
  type CreateChecklistItemInput,
  type CreateTemplateInput,
  type ListChecklistQueryInput
} from './checklist.schema.js';

export interface ChecklistDomainOptions {
  ctx: DomainContext;
}

export interface ChecklistDomain {
  routes: RouteSpec<never, unknown>[];
  service: ChecklistService;
}

export function createChecklistDomain(o: ChecklistDomainOptions): ChecklistDomain {
  const service = new ChecklistService({ ctx: o.ctx });
  /**
   * 🔴 双语义表（`scope` 决定域）的 ref 必须同时透传**两个域**的归属：
   *    · SHARED   → 链在第 3/4 段解析出的 `familyId` / `tripId`
   *    · PERSONAL → 行自身的 `ownerId` / `managedBy`
   *    写死 `null` 会让这两种判定**同时**失去比对依据 ——
   *    表现为「自己在共享清单里勾不了」（误拒），这是最隐蔽的一类权限 bug。
   *    `scope` 同样由链从资源行读出后回填，service 内还会再复核一次。
   */
  const itemRef = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): {
    type: 'trip_checklist_item';
    id: bigint;
    familyId: bigint | null;
    tripId: bigint | null;
    ownerId: bigint | null;
    managedBy: bigint | null;
    scope: string;
  } => ({
    type: 'trip_checklist_item',
    id,
    familyId: resolved.familyId,
    tripId: resolved.tripId,
    ownerId: resolved.ownerId,
    managedBy: resolved.managedBy,
    scope: resolved.scope ?? 'SHARED',
  });

  const routes: RouteSpec<never, unknown>[] = [
    // ── 清单项 ─────────────────────────────────────────────
    {
      method: 'POST',
      path: '/checklists/items',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'WRITE' },
      idParam: '__none__',
      schema: createChecklistItemSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateChecklistItemInput;
        const item = await service.createItem(ctx.userId!, {
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
          name: b.name,
          quantity: b.quantity,
          sort: b.sort,
          scope: b.scope,
          ownerId: b.ownerId !== undefined ? BigInt(b.ownerId) : undefined,
          templateId: b.templateId !== undefined ? BigInt(b.templateId) : undefined,
        });
        return { data: { item } };
      },
    },

    {
      method: 'GET',
      path: '/checklists/items',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listChecklistQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListChecklistQueryInput;
        const r = await service.list(ctx.userId!, {
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          scope: q.scope,
          checked: q.checked,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/checklists/items/:id',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'READ', ref: itemRef },
      handler: async (ctx) => {
        const item = await service.detailItem(ctx.userId!, ctx.resourceId!);
        return { data: { item } };
      },
    },

    // ── 勾选（E7 CAS）──────────────────────────────────────
    {
      method: 'POST',
      path: '/checklists/items/:id/toggle',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'WRITE', ref: itemRef },
      schema: toggleChecklistItemSchema as never,
      handler: async (ctx, input) => {
        const item = await service.toggle(ctx.userId!, ctx.resourceId!, input);
        return { data: { item } };
      },
    },

    // ── 批量勾选（部分成功）────────────────────────────────
    {
      method: 'POST',
      path: '/checklists/items/batch-toggle',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'WRITE' },
      idParam: '__none__',
      schema: batchToggleSchema as never,
      handler: async (ctx, input) => {
        const r = await service.batchToggle(ctx.userId!, input);
        return { data: r };
      },
    },

    {
      method: 'PATCH',
      path: '/checklists/items/:id',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'WRITE', ref: itemRef },
      schema: updateChecklistItemSchema as never,
      handler: async (ctx, input) => {
        const item = await service.updateItem(ctx.userId!, ctx.resourceId!, input);
        return { data: { item } };
      },
    },

    {
      method: 'DELETE',
      path: '/checklists/items/:id',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'DELETE', ref: itemRef },
      handler: async (ctx) => {
        const at = await service.removeItem(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },

    // ── 模板 ───────────────────────────────────────────────
    {
      method: 'POST',
      path: '/checklists/templates',
      auth: { public: false, resourceType: 'checklist_template', mode: 'WRITE' },
      idParam: '__none__',
      schema: createTemplateSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateTemplateInput;
        const template = await service.createTemplate(ctx.userId!, {
          familyId: b.familyId !== undefined ? BigInt(b.familyId) : undefined,
          name: b.name,
          scope: b.scope,
          ownerId: b.ownerId !== undefined ? BigInt(b.ownerId) : undefined,
          items: b.items,
        });
        return { data: { template } };
      },
    },

    {
      method: 'GET',
      path: '/checklists/templates',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      handler: async (ctx) => {
        const familyId = (ctx as unknown as { familyId?: bigint }).familyId;
        const r = await service.listTemplates(ctx.userId!, familyId);
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/checklists/templates/apply',
      auth: { public: false, resourceType: 'trip_checklist_item', mode: 'WRITE' },
      idParam: '__none__',
      schema: applyTemplateSchema as never,
      handler: async (ctx, input) => {
        const b = input as ApplyTemplateInput;
        const r = await service.applyTemplate(ctx.userId!, {
          templateId: BigInt(b.templateId),
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
