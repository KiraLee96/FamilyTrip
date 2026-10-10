/**
 * outfit 域 · Zod schema（个人穿搭 —— PRIVATE 域）
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createOutfitSchema = z.object({
  familyId: idInput,
  name: z.string().min(1, '穿搭名称不能为空').max(64),
  note: z.string().max(512).optional(),
  /** 关联到某次出行（可选，用于「这次带什么衣服」） */
  tripId: idInput.optional(),
  ownerId: idInput.optional(),
  /** 搭配的物品（来自个人物品库，必须同 owner） */
  itemIds: z.array(idInput).max(100).default([]),
});

export type CreateOutfitInput = z.infer<typeof createOutfitSchema>;

export const updateOutfitSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    name: z.string().min(1).max(64).optional(),
    note: z.string().max(512).nullable().optional(),
    tripId: idInput.nullable().optional(),
    /** 传了则整体替换搭配明细（全量覆盖语义） */
    itemIds: z.array(idInput).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateOutfitInput = z.infer<typeof updateOutfitSchema>;

export const listOutfitQuerySchema = z.object({
  familyId: idInput.optional(),
  tripId: idInput.optional(),
  mineOnly: z.coerce.boolean().default(true),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListOutfitQueryInput = z.infer<typeof listOutfitQuerySchema>;
