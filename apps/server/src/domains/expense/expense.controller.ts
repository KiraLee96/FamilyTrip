/**
 * expense 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { MinIntervalLimiter } from '../../common/security/rate-limit.js';
import type { IdempotencyStore } from '../../common/idempotency/idempotency.js';
import { ExpenseService, type ExpenseServiceOptions } from './expense.service.js';
import {
  createExpenseBatchSchema,
  createExpenseSchema,
  expenseSummaryQuerySchema,
  listExpenseQuerySchema,
  updateExpenseSchema,
  type CreateExpenseBatchInput,
  type CreateExpenseInput,
  type ExpenseSummaryQueryInput,
  type ListExpenseQueryInput,
} from './expense.schema.js';

export interface ExpenseDomainOptions {
  ctx: DomainContext;
  resolveRate: ExpenseServiceOptions['resolveRate'];
  /** 批量记账的幂等仓储（缺省进程内实现，见 service 注释） */
  idempotencyStore?: IdempotencyStore;
  /**
   * 批量记账限流器（可注入以便单测控制时钟/间隔）。
   * 缺省 `1 次/秒`、进程内计数 —— 见 `common/security/rate-limit.ts` 的边界说明。
   */
  batchLimiter?: MinIntervalLimiter;
  /**
   * 毫秒时钟（与 `BuildAppOptions.now` 同源，但收窄成毫秒数）。
   *
   * 🔴 名字不能叫 `now`：各域公共选项里的 `now` 是 `() => Date`，
   *    重名会让组合根展开 `...common` 时类型打架（Date 不是 number）。
   *
   * 注入它是为了让「1 次/秒」这条规则**可测**：单测不可能真的 sleep 1 秒，
   * 而把间隔写死成 0 又等于没测限流。生产不传 → `Date.now`。
   */
  clockMs?: () => number;
}

export interface ExpenseDomain {
  routes: RouteSpec<never, unknown>[];
  service: ExpenseService;
}

export function createExpenseDomain(o: ExpenseDomainOptions): ExpenseDomain {
  /**
   * 批量记账限流（派发单 P1-1 口径：单用户 1 次/秒）。
   *
   * ⚠️ 进程内计数，pm2 fork 单实例有效；多实例时实际额度 = 实例数 × 1/秒。
   *    这不是完整限流方案（见 `common/security/rate-limit.ts` 的边界说明）。
   *
   * 🔴 施力点在 service 的幂等占位之后（不在 handler 入口）：同 requestId 的
   *    重放是零副作用回放，不该被 429 拦住。见 `ExpenseServiceOptions.batchLimiter`。
   */
  const batchLimiter =
    o.batchLimiter ??
    new MinIntervalLimiter({
      intervalMs: 1_000,
      ...(o.clockMs !== undefined ? { now: o.clockMs } : {}),
    });

  const service = new ExpenseService({
    ctx: o.ctx,
    resolveRate: o.resolveRate,
    ...(o.idempotencyStore !== undefined ? { idempotencyStore: o.idempotencyStore } : {}),
    batchLimiter,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/expenses',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE' },
      idParam: '__none__',
      schema: createExpenseSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateExpenseInput;
        const expense = await service.create(ctx.userId!, {
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
          title: b.title,
          amount: b.amount,
          currency: b.currency,
          ownerMemberId: b.ownerMemberId !== undefined ? BigInt(b.ownerMemberId) : undefined,
          category: b.category,
          spentAt: b.spentAt,
          note: b.note,
        });
        return { data: { expense } };
      },
    },

    // ── 批量记账（导入账单；D-2026-10-26-01 P1-1）──────────────
    // 前端 `createExpensesBatch` 签名不变，只换实现层：由逐行串行改一次提交。
    {
      method: 'POST',
      path: '/expenses/batch',
      auth: { public: false, resourceType: 'trip', mode: 'WRITE' },
      idParam: '__none__',
      schema: createExpenseBatchSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateExpenseBatchInput;
        const r = await service.createBatch(ctx.userId!, {
          tripId: BigInt(b.tripId),
          familyId: BigInt(b.familyId),
          ...(b.requestId !== undefined ? { requestId: b.requestId } : {}),
          rows: b.rows.map((row) => ({
            title: row.title,
            amount: row.amount,
            currency: row.currency,
            ...(row.ownerMemberId !== undefined
              ? { ownerMemberId: BigInt(row.ownerMemberId) }
              : {}),
            ...(row.category !== undefined ? { category: row.category } : {}),
            ...(row.spentAt !== undefined ? { spentAt: row.spentAt } : {}),
            ...(row.note !== undefined ? { note: row.note } : {}),
          })),
        });
        return { data: r };
      },
    },

    {
      method: 'GET',
      path: '/expenses',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: listExpenseQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListExpenseQueryInput;
        const r = await service.list(ctx.userId!, {
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          ownerMemberId: q.ownerMemberId !== undefined ? BigInt(q.ownerMemberId) : undefined,
          category: q.category,
          from: q.from,
          to: q.to,
          displayCurrency: q.displayCurrency,
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'GET',
      path: '/expenses/summary',
      auth: { public: false, resourceType: 'user', mode: 'READ' },
      idParam: '__none__',
      schema: expenseSummaryQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ExpenseSummaryQueryInput;
        const r = await service.summary(ctx.userId!, {
          tripId: q.tripId !== undefined ? BigInt(q.tripId) : undefined,
          familyId: q.familyId !== undefined ? BigInt(q.familyId) : undefined,
          displayCurrency: q.displayCurrency,
        });
        return { data: r };
      },
    },

    {
      method: 'PATCH',
      path: '/expenses/:id',
      auth: {
        public: false,
        resourceType: 'trip',
        mode: 'WRITE',
        // 归属取资源行上的 familyId / tripId（不信请求体）
        ref: (id, _req, r) => ({ type: 'trip', id, familyId: r.familyId, tripId: r.tripId }),
      },
      schema: updateExpenseSchema as never,
      handler: async (ctx, input) => {
        const expense = await service.update(ctx.userId!, ctx.resourceId!, input);
        return { data: { expense } };
      },
    },

    {
      method: 'DELETE',
      path: '/expenses/:id',
      auth: {
        public: false,
        resourceType: 'trip',
        mode: 'DELETE',
        // 归属取资源行上的 familyId / tripId（不信请求体）
        ref: (id, _req, r) => ({ type: 'trip', id, familyId: r.familyId, tripId: r.tripId }),
      },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
