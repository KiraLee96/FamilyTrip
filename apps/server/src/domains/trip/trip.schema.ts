/**
 * trip 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

const dateInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式须为 YYYY-MM-DD');

export const createTripSchema = z.object({
  familyId: idInput,
  title: z.string().min(1, '出行标题不能为空').max(128),
  startDate: dateInput.optional(),
  endDate: dateInput.optional(),
  timezone: z.string().max(64).optional(),
  /** 目的地（数组，便于多处目的地） */
  destinations: z
    .array(z.object({ name: z.string().min(1).max(64), note: z.string().max(256).optional() }))
    .max(20)
    .optional(),
});

export type CreateTripInput = z.infer<typeof createTripSchema>;

/**
 * 更新出行（E7 CAS 乐观锁）。
 *
 * 🔴 `version` 必传 —— 缺了就直接拒，而不是「不校验」。
 *    客户端列表里拿到的 version 原样回传；不一致 → 409 VERSION_CONFLICT。
 */
export const updateTripSchema = z.object({
  version: z.coerce.number().int().min(0),
  title: z.string().min(1).max(128).optional(),
  status: z.enum(['DRAFT', 'PLANNED', 'ONGOING', 'FINISHED', 'CANCELLED']).optional(),
  startDate: dateInput.nullable().optional(),
  endDate: dateInput.nullable().optional(),
  timezone: z.string().max(64).optional(),
  destinations: z
    .array(z.object({ name: z.string().min(1).max(64), note: z.string().max(256).optional() }))
    .max(20)
    .optional(),
});

export type UpdateTripInput = z.infer<typeof updateTripSchema>;

export const listTripQuerySchema = z.object({
  familyId: idInput.optional(),
  status: z.enum(['DRAFT', 'PLANNED', 'ONGOING', 'FINISHED', 'CANCELLED']).optional(),
  /** 只看我作为成员的 */
  mineOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListTripQueryInput = z.infer<typeof listTripQuerySchema>;

/** 加出行成员 —— 支持虚拟成员（无账号家人） */
export const addTripMemberSchema = z.object({
  userId: idInput.optional(),
  displayName: z.string().min(1).max(32).optional(),
  isVirtual: z.boolean().default(false),
  /** 外部同行者（如朋友），不属家庭 */
  isExternal: z.boolean().default(false),
  role: z.enum(['LEADER', 'MEMBER']).default('MEMBER'),
  managedBy: idInput.optional(),
  /** 访问级别：默认 ACTIVE；把某人设为只读（例如已离队但仍可查阅） */
  accessLevel: z.enum(['ACTIVE', 'HISTORICAL_READONLY']).default('ACTIVE'),
});

export type AddTripMemberInput = z.infer<typeof addTripMemberSchema>;

export const updateTripMemberSchema = z
  .object({
    role: z.enum(['LEADER', 'MEMBER']).optional(),
    accessLevel: z.enum(['ACTIVE', 'HISTORICAL_READONLY']).optional(),
    displayName: z.string().min(1).max(32).optional(),
    managedBy: idInput.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type UpdateTripMemberInput = z.infer<typeof updateTripMemberSchema>;

/**
 * 设主导者（E8 行锁 + 退位判定）。
 *
 * `expectLeaderId`：客户端看到的当前主导者。若服务端实际主导者已变，
 * 说明有人并发改过 —— 直接拒（409），让客户端刷新重试。
 */
export const setLeaderSchema = z.object({
  leaderMemberId: idInput,
  expectLeaderId: idInput.nullable().optional(),
});

export type SetLeaderInput = z.infer<typeof setLeaderSchema>;

/** 离开出行 —— 若是主导者则触发退位判定（KEEP/PROMOTE/REFUSE） */
export const leaveTripSchema = z.object({
  /** 主动指定继任者（可选）；不指定则由服务端按规则判定 */
  successorMemberId: idInput.optional(),
});

export type LeaveTripInput = z.infer<typeof leaveTripSchema>;

/**
 * 凭行程邀请码加入（GRP-02 外部同行者）。
 *
 * 与 `joinFamilySchema` 同构：min4/max16 宽松兼容（前端固定发 8 位）。
 * 大小写不敏感由**生成侧**保证（字符集全大写）+ 前端 `toUpperCase`，
 * 🔴 后端不强制 transform —— 避免与 family 域行为分叉。
 */
export const joinTripSchema = z.object({
  inviteCode: z.string().min(4).max(16),
  /** 可选：加入后同行者看到的称呼 */
  displayName: z.string().max(32).optional(),
});

export type JoinTripInput = z.infer<typeof joinTripSchema>;

/** 结束出行 —— 把成员转为 HISTORICAL_READONLY（历史只读保留，B6） */
export const finishTripSchema = z.object({
  version: z.coerce.number().int().min(0),
  /** 实际行程回顾（JSON，供回忆归档） */
  actual: z.record(z.unknown()).optional(),
});

export type FinishTripInput = z.infer<typeof finishTripSchema>;
