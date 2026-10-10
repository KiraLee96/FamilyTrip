/**
 * notify 域 · Zod schema（提醒 / 订阅消息）
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '时间格式须为 YYYY-MM-DDTHH:mm');

export const createReminderSchema = z.object({
  /** 接收人（成员 id，可为虚拟成员 → 由代管人代收） */
  receiverId: idInput,
  tripId: idInput.optional(),
  subscriptionId: idInput.optional(),
  title: z.string().min(1, '提醒标题不能为空').max(64),
  content: z.string().max(512).optional(),
  remindAt: localDateTime,
  /** 时区（缺省取接收人 home_timezone） */
  tz: z.string().max(64).optional(),
  /** NORMAL = 到点推送；TODO_ONLY = 只进待办列表不推送 */
  delivery: z.enum(['NORMAL', 'TODO_ONLY']).default('NORMAL'),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;

export const updateReminderSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    title: z.string().min(1).max(64).optional(),
    content: z.string().max(512).nullable().optional(),
    remindAt: localDateTime.optional(),
    tz: z.string().max(64).optional(),
    delivery: z.enum(['NORMAL', 'TODO_ONLY']).optional(),
    status: z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateReminderInput = z.infer<typeof updateReminderSchema>;

export const listReminderQuerySchema = z.object({
  receiverId: idInput.optional(),
  tripId: idInput.optional(),
  status: z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']).optional(),
  /** 只看到点未发送的（待办视图） */
  dueOnly: z.coerce.boolean().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListReminderQueryInput = z.infer<typeof listReminderQuerySchema>;

/** 标记已读 */
export const markReadSchema = z.object({
  reminderIds: z.array(idInput).min(1).max(200),
});

export type MarkReadInput = z.infer<typeof markReadSchema>;

/** 订阅消息授权登记（微信 `requestSubscribeMessage` 成功后回传） */
export const registerSubscriptionSchema = z.object({
  templateId: z.string().min(1).max(64),
  status: z.enum(['GRANTED', 'EXPIRED', 'REVOKED']),
  expireAt: z.string().datetime().optional(),
  remainCount: z.coerce.number().int().min(0).optional(),
});

export type RegisterSubscriptionInput = z.infer<typeof registerSubscriptionSchema>;
