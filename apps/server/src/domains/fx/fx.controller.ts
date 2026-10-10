/**
 * fx 域 · controller（薄层）
 *
 * 路由（6 条）：
 *   GET  /fx/rate              查汇率（缓存 → 库 → 授权源）
 *   GET  /fx/rates             汇率列表（对账 / 运维）
 *   POST /fx/rates             手工录入汇率
 *   POST /fx/snapshot          录入金额 → 固化 amount_base 快照
 *   POST /fx/convert-batch     批量折算
 *   POST /fx/recompute-history 重算历史（默认拒绝，需三条件齐备）
 *
 * 权限：汇率是**系统级只读配置**，不对家庭域开放写。
 *   读取走 resourceType 'user'（登录即可），
 *   录入 / 重算走 resourceType 'family' + OWNER 语义由 service 内校验。
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import type { MemoryKvCache} from './fx.service.js';
import { FxService, type FxServiceOptions } from './fx.service.js';
import {
  convertBatchSchema,
  getRateQuerySchema,
  listRateQuerySchema,
  recomputeSchema,
  snapshotAmountSchema,
  upsertRateSchema,
  type ConvertBatchInput,
  type GetRateQueryInput,
  type ListRateQueryInput,
  type RecomputeInput,
  type SnapshotAmountInput,
  type UpsertRateInput,
} from './fx.schema.js';
import type { FxRateSource } from '../../common/fx/source-guard.js';

export interface FxDomainOptions {
  ctx: DomainContext;
  source?: FxRateSource;
  cache?: MemoryKvCache;
  auditRetentionDays?: number;
  now?: () => Date;
}

export interface FxDomain {
  routes: RouteSpec<never, unknown>[];
  service: FxService;
}

export function createFxDomain(o: FxDomainOptions): FxDomain {
  const opts: FxServiceOptions = {
    ctx: o.ctx,
    ...(o.source !== undefined ? { source: o.source } : {}),
    ...(o.cache !== undefined ? { cache: o.cache } : {}),
    ...(o.auditRetentionDays !== undefined ? { auditRetentionDays: o.auditRetentionDays } : {}),
    ...(o.now !== undefined ? { now: o.now } : {}),
  };
  const service = new FxService(opts);

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'GET',
      path: '/fx/rate',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: getRateQuerySchema as never,
      handler: async (_ctx, input) => {
        const q = input as GetRateQueryInput;
        const rate = await service.getRate({
          base: q.base,
          quote: q.quote,
          date: q.date,
          ...(q.tier !== undefined ? { tier: q.tier } : {}),
          ...(q.forceRefresh !== undefined ? { forceRefresh: q.forceRefresh } : {}),
        });
        return { data: { rate } };
      },
    },

    {
      method: 'GET',
      path: '/fx/rates',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listRateQuerySchema as never,
      handler: async (_ctx, input) => {
        const q = input as ListRateQueryInput;
        const r = await service.listRates({
          ...(q.base !== undefined ? { base: q.base } : {}),
          ...(q.quote !== undefined ? { quote: q.quote } : {}),
          ...(q.tier !== undefined ? { tier: q.tier } : {}),
          ...(q.from !== undefined ? { from: q.from } : {}),
          ...(q.to !== undefined ? { to: q.to } : {}),
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'POST',
      path: '/fx/rates',
      auth: { public: false, resourceType: 'user', mode: 'WRITE' },
      idParam: '__none__',
      schema: upsertRateSchema as never,
      handler: async (ctx, input) => {
        const b = input as UpsertRateInput;
        const rate = await service.upsertRate(ctx.userId!, {
          base: b.base,
          quote: b.quote,
          rate: b.rate,
          rateDate: b.rateDate,
          tier: b.tier,
          source: b.source,
        });
        return { data: { rate } };
      },
    },

    {
      method: 'POST',
      path: '/fx/snapshot',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: snapshotAmountSchema as never,
      handler: async (ctx, input) => {
        const b = input as SnapshotAmountInput;
        const snapshot = await service.snapshotAmount(ctx.userId!, {
          currency: b.currency,
          baseCurrency: b.baseCurrency,
          amount: b.amount,
          date: b.date,
          ...(b.tier !== undefined ? { tier: b.tier } : {}),
          ...(b.manualRate !== undefined ? { manualRate: b.manualRate } : {}),
        });
        return { data: { snapshot } };
      },
    },

    {
      method: 'POST',
      path: '/fx/convert-batch',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: convertBatchSchema as never,
      handler: async (_ctx, input) => {
        const b = input as ConvertBatchInput;
        const r = await service.convertBatch({
          baseCurrency: b.baseCurrency,
          date: b.date,
          ...(b.tier !== undefined ? { tier: b.tier } : {}),
          items: b.items,
        });
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/fx/recompute-history',
      auth: { public: false, resourceType: 'user', mode: 'WRITE' },
      idParam: '__none__',
      schema: recomputeSchema as never,
      handler: async (ctx, input) => {
        const b = input as RecomputeInput;
        const r = await service.recomputeHistory(ctx.userId!, {
          baseCurrency: b.baseCurrency,
          newTier: b.newTier,
          allowRecomputeHistory: b.allowRecomputeHistory,
          ...(b.versionChannel !== undefined ? { versionChannel: b.versionChannel } : {}),
          ...(b.reconciliationReportId !== undefined
            ? { reconciliationReportId: b.reconciliationReportId }
            : {}),
          recordIds: b.recordIds,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
