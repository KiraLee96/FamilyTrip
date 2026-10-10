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

/** 管理侧：导入/覆盖节假日（内部运营接口） */
export const upsertHolidaySchema = z.object({
  familyId: idInput.optional(),
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
