/**
 * item-sync 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

/**
 * 拉取增量变更（B1 多端同步 / E1–E6）。
 *
 * `cursor` 是服务端签发的不透明串，格式 `<epochMillis>:<id>`。
 * 客户端**不得**解析或构造 —— 只做「原样回传」。
 * 首次同步不传 cursor → 服务端返回 `initialCursor` + 全量快照指引。
 */
export const pullChangesSchema = z.object({
  cursor: z.string().max(64).optional(),
  /** 单页上限；服务端会 clamp 到 100 */
  limit: z.coerce.number().int().positive().max(100).optional(),
  /** 限定范围（可选）：只同步某个家庭/出行的变更 */
  familyId: idInput.optional(),
  tripId: idInput.optional(),
  /** 只同步这些实体类型（可选） */
  entityTypes: z.array(z.string().max(32)).max(40).optional(),
});

export type PullChangesInput = z.infer<typeof pullChangesSchema>;

/** 批量推送本地变更（离线编辑回灌） */
export const pushChangesSchema = z.object({
  /** 客户端本地操作批次 ID —— 幂等键 */
  batchId: z.string().min(1).max(64),
  changes: z
    .array(
      z.object({
        entityType: z.string().min(1).max(32),
        entityId: idInput,
        op: z.enum(['INSERT', 'UPDATE', 'DELETE']),
        /** 客户端本地时间（仅审计用，不参与服务端游标） */
        localChangedAt: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(500),
});

export type PushChangesInput = z.infer<typeof pushChangesSchema>;

/**
 * 合并结果回报（E5 coalesce / E6 冲突暴露）。
 * 客户端把服务端返回的 mergeOutcome 回报，服务端据此决定是否需要 backfill。
 */
export const reportMergeSchema = z.object({
  batchId: z.string().min(1).max(64),
  needsBackfill: z.boolean(),
  /** 客户端本地最大游标，用于服务端判断是否漏单 */
  clientCursor: z.string().max(64).optional(),
});

export type ReportMergeInput = z.infer<typeof reportMergeSchema>;
