/**
 * expense 域 · controller（薄层）
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { ExpenseService, type ExpenseServiceOptions } from './expense.service.js';
import {
  createExpenseSchema,
  expenseSummaryQuerySchema,
  listExpenseQuerySchema,
  updateExpenseSchema,
  type CreateExpenseInput,
  type ExpenseSummaryQueryInput,
  type ListExpenseQueryInput
} from './expense.schema.js';

export interface ExpenseDomainOptions {
  ctx: DomainContext;
  resolveRate: ExpenseServiceOptions['resolveRate'];
}

export interface ExpenseDomain {
  routes: RouteSpec<never, unknown>[];
  service: ExpenseService;
}

export function createExpenseDomain(o: ExpenseDomainOptions): ExpenseDomain {
  const service = new ExpenseService({ ctx: o.ctx, resolveRate: o.resolveRate });

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
