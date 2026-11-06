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

    /**
     * 家庭自定义假期导入（公司假 / 园所假）。
     *
     * 🔴 2026-11-06 安全修复：本路由 `idParam: '__none__'` → 链路第 5 段取不到 id，
     *    `if (rawId !== undefined)` 整段跳过，`checkAccess` **不执行**，只剩登录校验。
     *    原实现允许 `familyId` 缺省（= 写全国字典），实测任意登录用户可把
     *    2027-02-05 改成「上班」，全体家庭的工作日口径被他一个人污染。
     *
     *    现在：schema 强制 `familyId`，service 内 `assertFamilyOwner` 复核。
     *    **全国法定字典不再有任何 HTTP 写入口**，只能走数据库运维导入。
     */
    {
      method: 'POST',
      path: '/holidays/import',
      auth: { public: false, resourceType: 'family', mode: 'WRITE' },
      idParam: '__none__',
      schema: upsertHolidaySchema as never,
      handler: async (ctx, input) => {
        const b = input as UpsertHolidayInput;
        const r = await service.upsert(ctx.userId!, {
          familyId: BigInt(b.familyId),
          country: 'CN',
          items: b.items,
        });
        return { data: r };
      },
    },
  ];

  return { routes, service };
}
