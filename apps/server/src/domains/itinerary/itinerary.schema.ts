/**
 * itinerary 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

/** 本地时间字符串 `YYYY-MM-DDTHH:mm`（不带时区，按出行时区解释） */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '时间格式须为 YYYY-MM-DDTHH:mm');

export const createItineraryItemSchema = z.object({
  tripId: idInput,
  familyId: idInput,
  title: z.string().min(1, '日程标题不能为空').max(128),
  startAt: localDateTime,
  endAt: localDateTime.optional(),
  location: z.string().max(256).optional(),
  note: z.string().max(2000).optional(),
  /** 排序；同一天内按此升序 */
  sort: z.coerce.number().int().default(0),
  /** 金额相关字段（可选，用于日程内记账） */
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((s) => /^\d+$/.test(s), { message: '金额必须为非负整数字符串' })
    .optional(),
  currency: z.string().length(3).optional(),
  /** 汇率来源：AUTO = 按当日 SPOT_SELL 自动；MANUAL = 用户手填 */
  rateSource: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
});

export type CreateItineraryItemInput = z.infer<typeof createItineraryItemSchema>;

export const updateItineraryItemSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    title: z.string().min(1).max(128).optional(),
    startAt: localDateTime.optional(),
    endAt: localDateTime.nullable().optional(),
    location: z.string().max(256).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    sort: z.coerce.number().int().optional(),
    rateSource: z.enum(['AUTO', 'MANUAL']).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateItineraryItemInput = z.infer<typeof updateItineraryItemSchema>;

export const listItineraryQuerySchema = z.object({
  tripId: idInput,
  /** 只看某天（YYYY-MM-DD） */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListItineraryQueryInput = z.infer<typeof listItineraryQuerySchema>;

/** 拖动排序（批量） */
export const reorderItinerarySchema = z.object({
  tripId: idInput,
  orders: z
    .array(z.object({ id: idInput, sort: z.coerce.number().int() }))
    .min(1)
    .max(200),
});

export type ReorderItineraryInput = z.infer<typeof reorderItinerarySchema>;
