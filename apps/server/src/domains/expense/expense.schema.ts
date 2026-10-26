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
  .refine((s) => /^\d+(\.\d+)?$/.test(s), {
    message: '金额必须为非负数字字符串（主单位，如 "8600.00"）',
  });

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

/**
 * 批量记账的单行（D-2026-10-26-01 P1-1）。
 *
 * 字段与 `createExpenseSchema` **同源**（去掉批次级的 tripId / familyId）：
 * 两处若各写一份，"导入"与"手记"就会在字段长度、金额格式上悄悄分叉。
 */
export const createExpenseBatchRowSchema = z.object({
  title: z.string().min(1, '花费名称不能为空').max(128),
  amount: amountInput,
  currency: z.string().length(3).default('CNY'),
  ownerMemberId: idInput.optional(),
  category: z.string().max(32).optional(),
  spentAt: dateInput.optional(),
  note: z.string().max(512).optional(),
});

export type CreateExpenseBatchRowInput = z.infer<typeof createExpenseBatchRowSchema>;

/**
 * 批量记账（POST /expenses/batch）。
 *
 * 🔴 `rows` 上限 200：超过直接整批拒（让客户端分批），不做"截断但静默成功"——
 *    截断会让用户以为全部导入成功，账单少了几笔却无人察觉。
 *
 * 🔴 `requestId` 可选：带了才启用幂等（同 id 重放返回首次结果）。
 *    不隐式生成 —— 那会让客户端误以为有保护，实际每次重试都是新 id。
 */
export const createExpenseBatchSchema = z.object({
  tripId: idInput,
  familyId: idInput,
  requestId: z.string().min(1).max(128).optional(),
  rows: z
    .array(createExpenseBatchRowSchema)
    .min(1, '至少一行')
    .max(200, '单批最多 200 行，请分批导入'),
});

export type CreateExpenseBatchInput = z.infer<typeof createExpenseBatchSchema>;

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
