/**
 * wish 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createWishSchema = z.object({
  familyId: idInput,
  /** 可选：直接挂到某次出行下（否则为「未规划的愿望」） */
  tripId: idInput.optional(),
  title: z.string().min(1, '心愿标题不能为空').max(128),
  description: z.string().max(2000).optional(),
  /** 优先级：数值越大越优先 */
  priority: z.number().int().min(0).max(100).default(0),
});

export type CreateWishInput = z.infer<typeof createWishSchema>;

export const updateWishSchema = z
  .object({
    title: z.string().min(1).max(128).optional(),
    description: z.string().max(2000).nullable().optional(),
    status: z.enum(['WANT', 'PLANNED', 'DONE', 'DROPPED']).optional(),
    priority: z.number().int().min(0).max(100).optional(),
    tripId: idInput.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type UpdateWishInput = z.infer<typeof updateWishSchema>;

/** 投票 —— 幂等：同一用户对同一心愿重复投票只计一次 */
export const voteWishSchema = z.object({
  /** true=投赞成（默认）；false=取消投票 */
  vote: z.boolean().default(true),
});

export type VoteWishInput = z.infer<typeof voteWishSchema>;

export const listWishQuerySchema = z.object({
  familyId: idInput.optional(),
  tripId: idInput.optional(),
  status: z.enum(['WANT', 'PLANNED', 'DONE', 'DROPPED']).optional(),
  /** 仅看未规划的（tripId 为空） */
  unplannedOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListWishQueryInput = z.infer<typeof listWishQuerySchema>;

/**
 * 心愿 → 出行草稿（v0.1 验收路径第 6 步「心愿转出行草稿」）。
 *
 * 语义：把选中的心愿集合**固化**成一次 DRAFT 状态的出行，
 * 心愿状态批量转 PLANNED 并挂到该 tripId 上。
 */
export const wishToTripSchema = z.object({
  familyId: idInput,
  /** 选中的心愿 ID 列表；为空则取该家庭所有 WANT 状态心愿 */
  wishIds: z.array(idInput).min(1).max(200).optional(),
  title: z.string().min(1).max(128).optional(),
  /** 目标出行日期（可选，草稿阶段可缺省） */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD')
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD')
    .optional(),
  timezone: z.string().max(64).optional(),
});

export type WishToTripInput = z.infer<typeof wishToTripSchema>;
