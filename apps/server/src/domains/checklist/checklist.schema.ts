/**
 * checklist 域 · Zod schema
 * ============================================================================
 * 清单是**双语义**表：`scope` 决定域（SHARED 共享 / PERSONAL 私有）。
 * 因此：
 *   · SHARED 项 —— 出行成员可见，勾选走 CAS
 *   · PERSONAL 项 —— 仅 owner / 代管人可见（PRIVATE 短路）
 * 同一张表两种权限语义，是所有越权 bug 的高发区。
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

export const createChecklistItemSchema = z
  .object({
    tripId: idInput,
    familyId: idInput,
    name: z.string().min(1, '物品名不能为空').max(64),
    quantity: z.coerce.number().int().min(1).max(9999).default(1),
    sort: z.coerce.number().int().default(0),
    /** SHARED = 全员共用；PERSONAL = 个人专属 */
    scope: z.enum(['SHARED', 'PERSONAL']).default('SHARED'),
    /**
     * 2026-10-27 需求③：清单分两类，语义完全不同，不能混着排。
     *   TODO —— 「要做的事」（订门票、办签证、给猫找寄养）
     *   PACK —— 「要带的东西」（身份证、充电宝 x2）
     * 缺省 PACK：历史数据全是打包物品，且老客户端不传这个字段。
     */
    kind: z.enum(['TODO', 'PACK']).default('PACK'),
    /** PERSONAL 时必填（或取操作者） */
    ownerId: idInput.optional(),
    /** 从模板生成（可选） */
    templateId: idInput.optional(),
  })
  .refine((v) => v.scope !== 'PERSONAL' || v.ownerId !== undefined, {
    message: 'PERSONAL 清单项必须指定 ownerId',
  });

export type CreateChecklistItemInput = z.infer<typeof createChecklistItemSchema>;

/**
 * 勾选（E7 CAS 乐观锁）。
 *
 * 🔴 `version` **必传** —— 这是 CAS 的唯一依据。
 *    两人同时勾同一项，后写者会拿到 409 而非静默覆盖。
 *    缺 version 直接拒（不「降级为无锁」）—— 那会让并发保护形同虚设。
 */
export const toggleChecklistItemSchema = z.object({
  version: z.coerce.number().int().min(0),
  checked: z.boolean(),
});

export type ToggleChecklistItemInput = z.infer<typeof toggleChecklistItemSchema>;

export const updateChecklistItemSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    name: z.string().min(1).max(64).optional(),
    quantity: z.coerce.number().int().min(1).max(9999).optional(),
    sort: z.coerce.number().int().optional(),
  })
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateChecklistItemInput = z.infer<typeof updateChecklistItemSchema>;

export const listChecklistQuerySchema = z.object({
  tripId: idInput.optional(),
  familyId: idInput.optional(),
  /** 不传则返回「共享 + 我自己可见的私有」（其余私有折叠成占位） */
  scope: z.enum(['SHARED', 'PERSONAL']).optional(),
  /** 2026-10-27 需求③：只看「要做的事」或只看「要带的东西」 */
  kind: z.enum(['TODO', 'PACK']).optional(),
  checked: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListChecklistQueryInput = z.infer<typeof listChecklistQuerySchema>;

/** 批量勾选（多端同步场景：用户连勾多项） */
export const batchToggleSchema = z.object({
  items: z
    .array(z.object({ id: idInput, version: z.coerce.number().int().min(0), checked: z.boolean() }))
    .min(1)
    .max(100),
});

export type BatchToggleInput = z.infer<typeof batchToggleSchema>;

/** 模板 */
export const createTemplateSchema = z.object({
  familyId: idInput.optional(),
  name: z.string().min(1).max(64),
  scope: z.enum(['SHARED', 'PERSONAL']).default('SHARED'),
  /**
   * 仅 PERSONAL 有意义：清单归属人。**可省略** —— 省略时服务端取当前登录用户
   * （见 `ChecklistService.createTemplate` 的 `input.ownerId ?? userId`）。
   *
   * 🔴 这里此前有一条 `.refine(v => v.scope !== 'PERSONAL' || v.ownerId !== undefined)`
   *    要求前端必须显式传 ownerId，而服务层本身已经会兜底 —— 两处口径不一致的结果是
   *    「我的清单」永远创建不了，界面只显示「参数校验失败」（2026-10-27 反馈）。
   *    前端不该传 ownerId 更安全：归属人应由 token 推导，前端传等于允许冒充他人。
   *    代管场景（为被代管成员建清单）仍可显式传，权限由 `assertCanActForOwner` 把关。
   */
  ownerId: idInput.optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(64),
        quantity: z.coerce.number().int().min(1).default(1),
        /**
         * 条目类型（2026-10-27 反馈：清单条目要按类型归类）。
         * 不锁枚举：家庭自建分类（如「露营」）不该被后端拒；宽度对齐 item.category。
         */
        category: z.string().trim().min(1).max(16).optional(),
      }),
    )
    .max(200)
    .default([]),
});

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

/**
 * 改模板（D-2026-10-26-01 P0-1）。
 *
 * 🔴 三条硬约束：
 *   1. `version` **必传** —— CAS 的唯一依据。两人同时维护同一套长期清单
 *      是常态（A 加「溯溪鞋」、B 加「登山杖」），无锁实现会静默吞掉前者。
 *   2. `items` 是**整体替换语义**，不是增量合并 —— 前端传什么就存什么，
 *      少一条就是删一条。增量语义会让「删掉某条物品」无法表达。
 *   3. `name` 与 `items` 至少给一个；都不给直接拒（避免空 PATCH 白涨 version）。
 */
export const updateTemplateSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    name: z.string().trim().min(1, '名称不能为空').max(64).optional(),
    items: z
      .array(
        z.object({
          name: z.string().trim().min(1, '物品名不能为空').max(64),
          quantity: z.coerce.number().int().min(1).max(9999).default(1),
          /** 条目类型；不传 = 未分类（前端按「未分类」分组） */
          category: z.string().trim().min(1).max(16).optional(),
        }),
      )
      .max(200, '单套清单最多 200 条')
      .optional(),
  })
  .refine((v) => v.name !== undefined || v.items !== undefined, {
    message: 'name 与 items 至少提供一个',
  });

export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema>;

/**
 * 列模板（D-2026-10-26-01 P1-2）。
 *
 * `familyId` 只作**附加收窄**：真正的可见范围由后端按「用户所属家庭」判定
 * （见 `listTemplates`），请求参数不能用来扩大可见集合。
 */
export const listTemplatesQuerySchema = z.object({
  familyId: idInput.optional(),
});

export type ListTemplatesQueryInput = z.infer<typeof listTemplatesQuerySchema>;

/** 从模板套用到出行 */
export const applyTemplateSchema = z.object({
  templateId: idInput,
  tripId: idInput,
  familyId: idInput,
});

export type ApplyTemplateInput = z.infer<typeof applyTemplateSchema>;
