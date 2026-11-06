/**
 * holiday 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

/** 查节假日日历 —— 字典数据，弱依赖 */
export const listHolidayQuerySchema = z.object({
  country: z.string().length(2).default('CN'),
  year: z.coerce.number().int().min(2000).max(2100),
  /** 起点日期（用于「接下来 N 天」查询） */
  from: dateInput.optional(),
  to: dateInput.optional(),
});

export type ListHolidayQueryInput = z.infer<typeof listHolidayQuerySchema>;

/** 判断某天是否工作日（含调休） */
export const workdayQuerySchema = z.object({
  country: z.string().length(2).default('CN'),
  date: dateInput,
});

export type WorkdayQueryInput = z.infer<typeof workdayQuerySchema>;

/** 两个日期之间有多少个工作日（行程天数估算用） */
export const workdaysBetweenSchema = z.object({
  country: z.string().length(2).default('CN'),
  start: dateInput,
  end: dateInput,
});

export type WorkdaysBetweenInput = z.infer<typeof workdaysBetweenSchema>;

/**
 * 家庭自定义假期导入（原名「内部运营接口」，2026-11-06 收窄语义）。
 *
 * 🔴 `familyId` 由**可选改为必填** —— 这是一次安全修复。
 *    原先缺省时写的是 `family_id = NULL` 的**全国法定字典**，而该路由的
 *    `idParam` 是 `'__none__'`，链路第 5 段是 `if (rawId !== undefined)` 才做归属解析，
 *    id 取不到 → **权限判定整段被跳过，只剩登录校验**。实测任意登录用户
 *    都能 POST 一条 `{date:'2027-02-05', isWorkday:true}` 改写全国假期，
 *    全体家庭的工作日口径随之被污染。
 *
 * 现在本接口只能写「自家」的覆盖项（如公司假 / 园所假）。
 * 全国法定字典**只能**走数据库运维导入，不再有任何 HTTP 写入口。
 */
export const upsertHolidaySchema = z.object({
  familyId: idInput,
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(32),
        date: dateInput,
        isWorkday: z.boolean(),
      }),
    )
    .min(1)
    .max(400),
});

export type UpsertHolidayInput = z.infer<typeof upsertHolidaySchema>;
