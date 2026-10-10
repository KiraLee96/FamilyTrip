/**
 * holiday 域 · controller（薄层）
 *
 * 节假日是**公开字典数据** —— 但保留登录要求，避免被当免费 API 刷。
 * 故用 `@Public`-like 的 public:true 会不合适；这里用 `resourceType:'user'`
 * 让登录校验生效，但资源维度为「我」，不触发资源归属解析。
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { DomainContext } from '../domain-context.js';
import { HolidayService } from './holiday.service.js';
import {
  listHolidayQuerySchema,
  upsertHolidaySchema,
  workdayQuerySchema,
  workdaysBetweenSchema,
  type ListHolidayQueryInput,
  type UpsertHolidayInput,
  type WorkdayQueryInput,
  type WorkdaysBetweenInput,
} from './holiday.schema.js';

export interface HolidayDomainOptions {
  ctx: DomainContext;
}

export interface HolidayDomain {
  routes: RouteSpec<never, unknown>[];
  service: HolidayService;
}

export function createHolidayDomain(o: HolidayDomainOptions): HolidayDomain {
  const service = new HolidayService({ ctx: o.ctx });

  const authed: { public: false; resourceType: 'user'; mode: 'READ' } = {
    public: false,
    resourceType: 'user',
    mode: 'READ',
  };

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'GET',
      path: '/holidays',
      auth: authed,
      idParam: '__none__',
      schema: listHolidayQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListHolidayQueryInput;
        const r = await service.list(ctx.userId!, {
          country: q.country,
          year: q.year,
          from: q.from,
          to: q.to,
        });
        return { data: r };
      },
    },

    {
      method: 'GET',
      path: '/holidays/workday',
      auth: authed,
      idParam: '__none__',
      schema: workdayQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as WorkdayQueryInput;
        const r = await service.isWorkday(ctx.userId!, { country: q.country, date: q.date });
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/holidays/workdays-between',
      auth: authed,
      idParam: '__none__',
      schema: workdaysBetweenSchema as never,
      handler: async (ctx, input) => {
        const q = input as WorkdaysBetweenInput;
        const r = await service.workdaysBetween(ctx.userId!, {
          country: q.country,
          start: q.start,
          end: q.end,
        });
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/holidays/import',
      auth: { public: false, resourceType: 'family', mode: 'WRITE' },
      idParam: '__none__',
      schema: upsertHolidaySchema as never,
      handler: async (ctx, input) => {
        const b = input as UpsertHolidayInput;
        const r = await service.upsert(ctx.userId!, {
          familyId: b.familyId !== undefined ? BigInt(b.familyId) : undefined,
          country: 'CN',
          items: b.items,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
