/**
 * booking 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const amountInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: '金额必须为非负整数字符串（最小货币单位）' });

export const createBookingSchema = z.object({
  tripId: idInput,
  familyId: idInput,
  type: z.enum(['FLIGHT', 'TRAIN', 'HOTEL', 'CAR', 'TICKET', 'OTHER']),
  title: z.string().min(1, '预订名称不能为空').max(128),
  provider: z.string().max(128).optional(),
  /** 🔒 敏感：订单号（加密存储 + 盲索引支持等值查询） */
  orderNo: z.string().max(128).optional(),
  /** 🔒 敏感：订单链接（可能含 token） */
  orderLink: z.string().max(1024).optional(),
  /** 🔒 敏感：联系方式（手机号/邮箱） */
  contact: z.string().max(256).optional(),
  startAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  endAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
  amount: amountInput.optional(),
  currency: z.string().length(3).default('CNY'),
  note: z.string().max(2000).optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const updateBookingSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    title: z.string().min(1).max(128).optional(),
    provider: z.string().max(128).nullable().optional(),
    orderNo: z.string().max(128).nullable().optional(),
    orderLink: z.string().max(1024).nullable().optional(),
    contact: z.string().max(256).nullable().optional(),
    startAt: z.string().nullable().optional(),
    endAt: z.string().nullable().optional(),
    amount: amountInput.optional(),
    currency: z.string().length(3).optional(),
    status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED']).optional(),
    note: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

export const listBookingQuerySchema = z.object({
  tripId: idInput.optional(),
  familyId: idInput.optional(),
  type: z.enum(['FLIGHT', 'TRAIN', 'HOTEL', 'CAR', 'TICKET', 'OTHER']).optional(),
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'REFUNDED']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
  /** 是否在响应中返回解密后的敏感字段（默认 true；审计场景可关） */
  includeSecrets: z.coerce.boolean().default(true),
});

export type ListBookingQueryInput = z.infer<typeof listBookingQuerySchema>;

/**
 * 按订单号精确查找 —— 走**盲索引**（R3）。
 *
 * 🔴 为什么不能直接 `WHERE order_no = ?`：
 *    密文列带随机 IV，同一明文每次加密结果不同，等值比较永远不命中。
 *    盲索引 = sha256(低基数字段 + 被索引值)，确定性输出，可建索引。
 *
 * 🔴 低基数字段必须**全部**给出（规则 2）：当前是 `familyId` + `tripId`。
 *    少传任一个，算出的摘要就与写入时不一致 → 恒不命中（表现为「查不到自己的单」）。
 *    盐的作用是防止跨家庭/跨出行的彩虹表反查与碰撞枚举。
 */
export const findByOrderNoSchema = z.object({
  orderNo: z.string().min(1).max(128),
  familyId: idInput,
  tripId: idInput,
});

export type FindByOrderNoInput = z.infer<typeof findByOrderNoSchema>;
