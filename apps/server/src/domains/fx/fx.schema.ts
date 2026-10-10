/**
 * fx 域 · Zod schema（汇率）
 *
 * 🔴 R5：唯一口径 `SPOT_SELL` —— 入参**必须显式传档位**（不允许隐式省略）。
 * 🔴 R6：切档位默认不重算历史。
 * 🔴 R7：禁止抓取；录入只能走 MANUAL（人工授权源录入）。
 */

import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { message: '日期须为 YYYY-MM-DD' });

/** 货币代码：ISO 4217，3 位大写字母 */
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, { message: '货币代码须为 3 位大写字母（ISO 4217）' });

/** 汇率字符串：正数、最多 8 位小数 */
const rateString = z
  .string()
  .regex(/^\d+(\.\d{1,8})?$/, { message: '汇率须为正数（最多 8 位小数）' })
  .refine((s) => Number(s) > 0, { message: '汇率必须大于 0' });

const tierEnum = z.enum(['SPOT_SELL', 'MIDDLE', 'CASH_BUY']);

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

/**
 * 查询汇率。
 *
 * ⛔ 不传 `tier` 时服务端填本期唯一口径，但**响应会回显实际档位**，
 *    调用方不得假设档位。
 */
export const getRateQuerySchema = z.object({
  base: currency,
  quote: currency,
  date: isoDate,
  tier: tierEnum.optional(),
  /** 跳过缓存强制回源 */
  forceRefresh: z.coerce.boolean().optional(),
});

export type GetRateQueryInput = z.infer<typeof getRateQuerySchema>;

/**
 * 手工录入汇率（人工授权源路径）。
 *
 * 🔴 手工录入必须带 `source`（授权源标识）+ 操作人（由登录态取）
 *    —— 否则审计断链。
 * 🔴 唯一键 `(base, quote, tier, rate_date, source)`：重复录入 → 新版本，
 *    旧行软删（保留审计链）。
 */
export const upsertRateSchema = z.object({
  base: currency,
  quote: currency,
  rate: rateString,
  rateDate: isoDate,
  tier: tierEnum.default('SPOT_SELL'),
  /** 合规授权源标识；⛔ 不得为爬虫来源 */
  source: z.string().min(1).max(64),
});

export type UpsertRateInput = z.infer<typeof upsertRateSchema>;

/** 汇率列表（对账 / 运维查用） */
export const listRateQuerySchema = z.object({
  base: currency.optional(),
  quote: currency.optional(),
  tier: tierEnum.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListRateQueryInput = z.infer<typeof listRateQuerySchema>;

/** 汇率快照（录入金额 → 固化 amount_base） */
export const snapshotAmountSchema = z.object({
  currency,
  baseCurrency: currency.default('CNY'),
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((s) => /^-?\d+(\.\d+)?$/.test(s), { message: '金额格式非法' }),
  date: isoDate,
  tier: tierEnum.optional(),
  /** 手动覆盖汇率；给了即成新快照，后续不重算 */
  manualRate: rateString.optional(),
});

export type SnapshotAmountInput = z.infer<typeof snapshotAmountSchema>;

/** 批量折算（列表页展示用） */
export const convertBatchSchema = z.object({
  baseCurrency: currency.default('CNY'),
  date: isoDate,
  tier: tierEnum.optional(),
  items: z
    .array(
      z.object({
        currency,
        amount: z
          .union([z.string(), z.number()])
          .transform((v) => String(v))
          .refine((s) => /^-?\d+(\.\d+)?$/.test(s), { message: '金额格式非法' }),
      }),
    )
    .min(1)
    .max(200),
});

export type ConvertBatchInput = z.infer<typeof convertBatchSchema>;

/** 人工重算历史（默认拒绝，需显式声明 + 版本通道 + 对账报告） */
export const recomputeSchema = z.object({
  baseCurrency: currency.default('CNY'),
  newTier: tierEnum,
  allowRecomputeHistory: z.boolean().default(false),
  versionChannel: z.coerce.number().int().positive().optional(),
  reconciliationReportId: z.string().max(128).optional(),
  /** 待重算的快照记录 id 列表 */
  recordIds: z.array(idInput).min(1).max(500),
});

export type RecomputeInput = z.infer<typeof recomputeSchema>;
