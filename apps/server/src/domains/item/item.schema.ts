/**
 * item 域 · Zod schema（个人物品库 —— PRIVATE 域）
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createItemSchema = z.object({
  familyId: idInput,
  name: z.string().min(1, '物品名不能为空').max(64),
  category: z.string().max(32).optional(),
  quantity: z.coerce.number().int().min(1).max(9999).default(1),
  note: z.string().max(512).optional(),
  /** 归属：缺省 = 操作者本人；可为代管的虚拟成员 */
  ownerId: idInput.optional(),
});

export type CreateItemInput = z.infer<typeof createItemSchema>;

export const updateItemSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    name: z.string().min(1).max(64).optional(),
    category: z.string().max(32).nullable().optional(),
    quantity: z.coerce.number().int().min(1).max(9999).optional(),
    note: z.string().max(512).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateItemInput = z.infer<typeof updateItemSchema>;

export const listItemQuerySchema = z.object({
  familyId: idInput.optional(),
  category: z.string().max(32).optional(),
  /** 只看自己的（默认 true —— 私有域不该默认暴露自己代管的全部） */
  mineOnly: z.coerce.boolean().default(true),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListItemQueryInput = z.infer<typeof listItemQuerySchema>;
