/**
 * auth 域 · Zod schema
 */

import { z } from 'zod';

/** 微信 code2session 登录入参 */
export const loginSchema = z.object({
  /** 微信登录 code（wx.login 得到） */
  code: z.string().min(1, '缺少 code').max(128),
  /** 可选：设备标识，用于多端会话区分（B1） */
  deviceId: z.string().max(64).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** 刷新令牌（无状态令牌下等同于重新签发，需携带旧 token 校验） */
export const refreshSchema = z.object({
  deviceId: z.string().max(64).optional(),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

/** 更新本人资料 */
export const updateProfileSchema = z.object({
  nickname: z.string().min(1).max(64).optional(),
  /** IANA 时区，如 Asia/Shanghai —— 用于提醒本地化（N 组） */
  homeTimezone: z
    .string()
    .max(64)
    .regex(/^[A-Za-z]+\/[A-Za-z_+-]+$/, '时区格式须为 Area/Location')
    .optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

/** 注销（软删） */
export const deactivateSchema = z.object({
  reason: z.string().max(256).optional(),
});

export type DeactivateInput = z.infer<typeof deactivateSchema>;
