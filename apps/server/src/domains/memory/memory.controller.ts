/**
 * memory 域 · controller（薄层）
 *
 * 路由（4 条）：
 *   GET  /memories                      回忆列表
 *   GET  /memories/:id                  回忆详情（含完整快照）
 *   POST /memories/generate-trip        生成出行回忆
 *   POST /memories/generate-annual      生成年度回忆
 *
 * ⛔ 无 PATCH / DELETE —— 快照不可变（权限矩阵中 memory_archive 仅 1 个 READ cell）。
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { DomainContext } from '../domain-context.js';
import { MemoryService } from './memory.service.js';
import {
  generateAnnualMemorySchema,
  generateTripMemorySchema,
  listMemoryQuerySchema,
  type GenerateAnnualMemoryInput,
  type GenerateTripMemoryInput,
  type ListMemoryQueryInput,
} from './memory.schema.js';

export interface MemoryDomainOptions {
  ctx: DomainContext;
  auditRetentionDays?: number;
  now?: () => Date;
}

export interface MemoryDomain {
  routes: RouteSpec<never, unknown>[];
  service: MemoryService;
}

export function createMemoryDomain(o: MemoryDomainOptions): MemoryDomain {
  const service = new MemoryService({
    ctx: o.ctx,
    ...(o.auditRetentionDays !== undefined ? { auditRetentionDays: o.auditRetentionDays } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
  });

  /**
   * 🔴 归属维度必须透传链在 withOwner 段读到的 `resolved`。
   *    写死 `familyId: null` 会让 SHARED_FAMILY 判定永远失败——
   *    表现为「自己是成员却被 404」，是最难查的一类权限 bug。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'memory_archive'; id: bigint; familyId: bigint | null; tripId: bigint | null } => ({
    type: 'memory_archive',
    id,
    familyId: resolved.familyId,
    tripId: resolved.tripId,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'GET',
      path: '/memories',
      auth: { public: false, resourceType: 'memory_archive', mode: 'READ' },
      idParam: '__none__',
      schema: listMemoryQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListMemoryQueryInput;
        const r = await service.list(ctx.userId!, {
          familyId: BigInt(q.familyId),
          ...(q.type !== undefined ? { type: q.type } : {}),
          ...(q.year !== undefined ? { year: q.year } : {}),
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/memories/:id',
      auth: { public: false, resourceType: 'memory_archive', mode: 'READ', ref },
      handler: async (ctx) => {
        const r = await service.detail(ctx.userId!, ctx.resourceId!);
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/memories/generate-trip',
      auth: { public: false, resourceType: 'memory_archive', mode: 'READ' },
      idParam: '__none__',
      schema: generateTripMemorySchema as never,
      handler: async (ctx, input) => {
        const b = input as GenerateTripMemoryInput;
        const r = await service.generateTripMemory(ctx.userId!, {
          tripId: BigInt(b.tripId),
          ...(b.year !== undefined ? { year: b.year } : {}),
          rebuild: b.rebuild,
        });
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/memories/generate-annual',
      auth: { public: false, resourceType: 'memory_archive', mode: 'READ' },
      idParam: '__none__',
      schema: generateAnnualMemorySchema as never,
      handler: async (ctx, input) => {
        const b = input as GenerateAnnualMemoryInput;
        const r = await service.generateAnnualMemory(ctx.userId!, {
          familyId: BigInt(b.familyId),
          year: b.year,
          rebuild: b.rebuild,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
