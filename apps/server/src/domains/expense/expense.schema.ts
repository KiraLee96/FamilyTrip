/**
 * expense 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

/**
 * 金额入参：**字符串传递**，避免 JS number 的浮点误差。
 *
 * 🔴 单位是**主单位**（元），不是分。
 *    `"8600.00"` 表示 8600.00 元 → 落库 `amount = 860000`（分）。
 *    换算由 `toMinorUnits(amount, currency)` 按币种精度完成
 *    （JPY 精度 0、KWD 精度 3，不是全局写死 2）。
 *
 * ⛔ 不要传 `"860000"` —— 那会被当作 860000 元 = 86000000 分。
 */
const amountInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+(\.\d+)?$/.test(s), { message: '金额必须为非负数字字符串（主单位，如 "8600.00"）' });

export const createExpenseSchema = z.object({
  tripId: idInput,
  familyId: idInput,
  title: z.string().min(1, '花费名称不能为空').max(128),
  /** 最小货币单位整数（分） */
  amount: amountInput,
  currency: z.string().length(3).default('CNY'),
  /** 记账归属成员（可为虚拟成员）；缺省 = 操作者 */
  ownerMemberId: idInput.optional(),
  category: z.string().max(32).optional(),
  spentAt: dateInput.optional(),
  note: z.string().max(512).optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;

export const updateExpenseSchema = z
  .object({
    version: z.coerce.number().int().min(0).optional(),
    title: z.string().min(1).max(128).optional(),
    amount: amountInput.optional(),
    currency: z.string().length(3).optional(),
    category: z.string().max(32).nullable().optional(),
    spentAt: dateInput.nullable().optional(),
    note: z.string().max(512).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

export const listExpenseQuerySchema = z.object({
  tripId: idInput.optional(),
  familyId: idInput.optional(),
  ownerMemberId: idInput.optional(),
  category: z.string().max(32).optional(),
  from: dateInput.optional(),
  to: dateInput.optional(),
  /** 目标币种 —— 结果里同时返回按此币种折算的金额 */
  displayCurrency: z.string().length(3).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListExpenseQueryInput = z.infer<typeof listExpenseQuerySchema>;

/** 账目汇总（按成员/分类/币种分组） */
export const expenseSummaryQuerySchema = z.object({
  tripId: idInput.optional(),
  familyId: idInput.optional(),
  displayCurrency: z.string().length(3).default('CNY'),
});

export type ExpenseSummaryQueryInput = z.infer<typeof expenseSummaryQuerySchema>;
