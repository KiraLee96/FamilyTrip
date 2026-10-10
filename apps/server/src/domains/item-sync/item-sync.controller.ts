/**
 * item-sync 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { ItemSyncService } from './item-sync.service.js';
import {
  pullChangesSchema,
  pushChangesSchema,
  reportMergeSchema,
  type PullChangesInput,
  type PushChangesInput,
  type ReportMergeInput,
} from './item-sync.schema.js';

export interface ItemSyncDomainOptions {
  ctx: DomainContext;
  leakThreshold?: number;
}

export interface ItemSyncDomain {
  routes: RouteSpec<never, unknown>[];
  service: ItemSyncService;
}

export function createItemSyncDomain(o: ItemSyncDomainOptions): ItemSyncDomain {
  const service = new ItemSyncService({ ctx: o.ctx, leakThreshold: o.leakThreshold });
  const authed: { public: false; resourceType: 'user'; mode: 'READ' } = {
    public: false,
    resourceType: 'user',
    mode: 'READ',
  };

  const routes: RouteSpec<never, unknown>[] = [
    // ── 首次同步：拿初始游标 ───────────────────────────────
    {
      method: 'GET',
      path: '/sync/cursor',
      auth: authed,
      idParam: '__none__',
      handler: async (ctx) => {
        const r = await service.initialCursor(ctx.userId!);
        return { data: r };
      },
    },

    // ── 增量拉取 ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/sync/changes',
      auth: authed,
      idParam: '__none__',
      schema: pullChangesSchema as never,
      handler: async (ctx, input) => {
        const q = input as PullChangesInput;
        const r = await service.pull(ctx.userId!, {
          cursor: q.cursor,
          limit: q.limit,
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          entityTypes: q.entityTypes,
        });
        return { data: r };
      },
    },

    // ── 本地变更推送（离线回灌去重）────────────────────────
    {
      method: 'POST',
      path: '/sync/changes',
      auth: authed,
      idParam: '__none__',
      schema: pushChangesSchema as never,
      handler: async (ctx, input) => {
        const b = input as PushChangesInput;
        const r = await service.push(ctx.userId!, {
          batchId: b.batchId,
          changes: b.changes.map((c) => ({ entityType: c.entityType, entityId: c.entityId, op: c.op })),
        });
        return { data: r };
      },
    },

    // ── 合并结果回报（E6 漏单自愈）─────────────────────────
    {
      method: 'POST',
      path: '/sync/merge-report',
      auth: authed,
      idParam: '__none__',
      schema: reportMergeSchema as never,
      handler: async (ctx, input) => {
        const b = input as ReportMergeInput;
        const r = await service.reportMerge(ctx.userId!, {
          batchId: b.batchId,
          needsBackfill: b.needsBackfill,
          clientCursor: b.clientCursor,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
