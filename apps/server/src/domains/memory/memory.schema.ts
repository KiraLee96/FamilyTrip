/**
 * memory 域 · Zod schema（回忆归档）
 *
 * 🔴 只读快照语义
 *   回忆存的是**写入时刻的快照**（`snapshot_json`），不随底层数据漂移。
 *   故本域只提供 READ + 生成（generate），**不提供编辑 / 删除**。
 *   权限矩阵中 `memory_archive` 只有 1 个 cell（READ）。
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const yearInput = z.coerce
  .number()
  .int()
  .min(2000, { message: '年份不得早于 2000' })
  .max(2100, { message: '年份不得晚于 2100' });

/** 回忆类型 */
export const MEMORY_TYPES = ['TRIP', 'ANNUAL'] as const;

/** 列表查询 */
export const listMemoryQuerySchema = z.object({
  familyId: idInput,
  type: z.enum(MEMORY_TYPES).optional(),
  year: yearInput.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListMemoryQueryInput = z.infer<typeof listMemoryQuerySchema>;

/** 详情 */
export const memoryDetailSchema = z.object({
  id: idInput,
});

export type MemoryDetailInput = z.infer<typeof memoryDetailSchema>;

/**
 * 生成出行回忆（出行结束后调用）。
 *
 * 幂等：同 `(familyId, year, type)` 已存在 → 直接返回既有快照，
 * 不覆盖（快照语义 —— 历史不可变）。
 */
export const generateTripMemorySchema = z.object({
  tripId: idInput,
  /** 期望年份；不传则取 trip.endDate 年份 */
  year: yearInput.optional(),
  /** 强制重建快照（会覆盖旧快照）—— 需显式声明 */
  rebuild: z.boolean().default(false),
});

export type GenerateTripMemoryInput = z.infer<typeof generateTripMemorySchema>;

/** 生成年度回忆（每年 12 月定时任务调用；也支持手动触发） */
export const generateAnnualMemorySchema = z.object({
  familyId: idInput,
  year: yearInput,
  rebuild: z.boolean().default(false),
});

export type GenerateAnnualMemoryInput = z.infer<typeof generateAnnualMemorySchema>;
