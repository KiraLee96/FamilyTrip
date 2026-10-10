/**
 * family 域 · Zod schema
 */

import { z } from 'zod';

/**
 * bigint ID 入参：JSON 里可能是 number（JS 精度上限 2^53，雪花 ID 会溢出！）
 * 或 string。**统一归一化成 string**，由 service 再转 BigInt。
 *
 * ⚠️ 雪花 ID 超出 `Number.MAX_SAFE_INTEGER`，所以客户端**必须**传字符串。
 *    这里接受 number 只是为兼容老客户端，超范围的值会在规范化时被拒。
 */
const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createFamilySchema = z.object({
  name: z.string().min(1, '家庭名称不能为空').max(64),
  timezone: z
    .string()
    .max(64)
    .regex(/^[A-Za-z]+\/[A-Za-z_+-]+$/)
    .optional(),
});

export type CreateFamilyInput = z.infer<typeof createFamilySchema>;

export const updateFamilySchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    timezone: z.string().max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type UpdateFamilyInput = z.infer<typeof updateFamilySchema>;

/** 邀请码加入 */
export const joinFamilySchema = z.object({
  inviteCode: z.string().min(4).max(16),
  /** 可选：以虚拟成员身份加入（无微信账号的家人，如幼儿/老人） */
  displayName: z.string().max(32).optional(),
});

export type JoinFamilyInput = z.infer<typeof joinFamilySchema>;

/** 新增家庭成员 */
export const addMemberSchema = z.object({
  /** 已有用户：直接给 userId；虚拟成员：给 displayName + isVirtual */
  userId: idInput.optional(),
  displayName: z.string().min(1).max(32).optional(),
  isVirtual: z.boolean().default(false),
  role: z.enum(['OWNER', 'MEMBER']).default('MEMBER'),
  /** 虚拟成员的代管人（缺省 = 操作者） */
  managedBy: idInput.optional(),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z
  .object({
    role: z.enum(['OWNER', 'MEMBER']).optional(),
    displayName: z.string().min(1).max(32).optional(),
    managedBy: idInput.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

/** 转让户主 */
export const transferOwnershipSchema = z.object({
  newOwnerMemberId: idInput,
});

export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

/** 分页 */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListQueryInput = z.infer<typeof listQuerySchema>;
