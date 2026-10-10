/**
 * checklist 域 · Zod schema
 * ============================================================================
 * 清单是**双语义**表：`scope` 决定域（SHARED 共享 / PERSONAL 私有）。
 * 因此：
 *   · SHARED 项 —— 出行成员可见，勾选走 CAS
 *   · PERSONAL 项 —— 仅 owner / 代管人可见（PRIVATE 短路）
 * 同一张表两种权限语义，是所有越权 bug 的高发区。
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createChecklistItemSchema = z
  .object({
    tripId: idInput,
    familyId: idInput,
    name: z.string().min(1, '物品名不能为空').max(64),
    quantity: z.coerce.number().int().min(1).max(9999).default(1),
    sort: z.coerce.number().int().default(0),
    /** SHARED = 全员共用；PERSONAL = 个人专属 */
    scope: z.enum(['SHARED', 'PERSONAL']).default('SHARED'),
    /** PERSONAL 时必填（或取操作者） */
    ownerId: idInput.optional(),
    /** 从模板生成（可选） */
    templateId: idInput.optional(),
  })
  .refine((v) => v.scope !== 'PERSONAL' || v.ownerId !== undefined, {
    message: 'PERSONAL 清单项必须指定 ownerId',
  });

export type CreateChecklistItemInput = z.infer<typeof createChecklistItemSchema>;

/**
 * 勾选（E7 CAS 乐观锁）。
 *
 * 🔴 `version` **必传** —— 这是 CAS 的唯一依据。
 *    两人同时勾同一项，后写者会拿到 409 而非静默覆盖。
 *    缺 version 直接拒（不「降级为无锁」）—— 那会让并发保护形同虚设。
 */
export const toggleChecklistItemSchema = z.object({
  version: z.coerce.number().int().min(0),
  checked: z.boolean(),
});

export type ToggleChecklistItemInput = z.infer<typeof toggleChecklistItemSchema>;

export const updateChecklistItemSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    name: z.string().min(1).max(64).optional(),
    quantity: z.coerce.number().int().min(1).max(9999).optional(),
    sort: z.coerce.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateChecklistItemInput = z.infer<typeof updateChecklistItemSchema>;

export const listChecklistQuerySchema = z.object({
  tripId: idInput.optional(),
  familyId: idInput.optional(),
  /** 不传则返回「共享 + 我自己可见的私有」（其余私有折叠成占位） */
  scope: z.enum(['SHARED', 'PERSONAL']).optional(),
  checked: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListChecklistQueryInput = z.infer<typeof listChecklistQuerySchema>;

/** 批量勾选（多端同步场景：用户连勾多项） */
export const batchToggleSchema = z.object({
  items: z
    .array(z.object({ id: idInput, version: z.coerce.number().int().min(0), checked: z.boolean() }))
    .min(1)
    .max(100),
});

export type BatchToggleInput = z.infer<typeof batchToggleSchema>;

/** 模板 */
export const createTemplateSchema = z
  .object({
    familyId: idInput.optional(),
    name: z.string().min(1).max(64),
    scope: z.enum(['SHARED', 'PERSONAL']).default('SHARED'),
    ownerId: idInput.optional(),
    items: z
      .array(z.object({ name: z.string().min(1).max(64), quantity: z.coerce.number().int().min(1).default(1) }))
      .max(200)
      .default([]),
  })
  .refine((v) => v.scope !== 'PERSONAL' || v.ownerId !== undefined, {
    message: 'PERSONAL 模板必须指定 ownerId',
  });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/** 从模板套用到出行 */
export const applyTemplateSchema = z.object({
  templateId: idInput,
  tripId: idInput,
  familyId: idInput,
});

export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
