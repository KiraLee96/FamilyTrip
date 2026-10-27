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
  /**
   * 头像可访问 URL（媒体池 upload 后由 asset.url 给出）。
   *
   * 🔴 此前本 schema 缺这个字段：Zod 默认 strip 未知键 → 客户端
   *    `PATCH /auth/me {avatarUrl}` 被静默丢弃、接口仍回 `code:0`，
   *    前端据此弹「头像已更新」，但库里 avatar_url 一直是 NULL，
   *    表现为「提示更新成功、头像处仍空白」（派发单 D-2026-10-26-05）。
   *
   * 不锁死 https：本地回读基址是 `http://<内网IP>:3000/media-files`，
   * 锁 https 会让本地联调永远存不进去；生产前端传的是 https CDN 地址。
   */
  avatarUrl: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^https?:\/\//, '头像地址必须是 http(s) 绝对 URL')
    .optional(),
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
