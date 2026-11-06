/**
 * media 域 · Zod schema（媒体资产）
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

/**
 * 登记媒体资产（M6：EXIF 剥离落 `media_assets.exif_stripped`）。
 *
 * 流程：客户端先直传对象存储 → 拿到 fileKey → 调本接口登记。
 * 服务端**不接收图片字节**（避免打爆请求体），只做元数据登记 +
 * 由 `stripExif` 标记是否已剥离。
 */
export const createMediaAssetSchema = z.object({
  /**
   * 2026-11-05：改成**可选** —— 头像是用户资产，不隶属任何家庭
   * （`familyId` 在 `media_asset` 上已放宽为可空，见迁移
   * `20261105000000_media_asset_family_nullable`）。
   *
   * ⚠️ 必填性由 service 按 **pending 记录的 purpose** 判定，不在这里判：
   *    同一个 `fileKey` 的用途只有服务端知道，schema 层拿不到。
   *    `purpose=MEDIA` 缺 `familyId` → service 报 422。
   */
  familyId: idInput.optional(),
  tripId: idInput.optional(),
  /**
   * 用途：与 `file_pending.purpose` 对齐校验。
   *
   * 🔴 刻意**不给默认值**：缺省 = 「以 pending 为准」。给默认 MEDIA 会让
   *    老客户端上传头像时被误判成「purpose 与上传位不一致」而 422。
   *    只有显式传了且与 pending 冲突，才拒绝（防客户端伪造用途）。
   */
  purpose: z.enum(['MEDIA', 'AVATAR']).optional(),
  /** 对象存储 key（客户端直传得到） */
  fileKey: z.string().min(1).max(512),
  mimeType: z.string().min(3).max(128),
  byteSize: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((s) => /^\d+$/.test(s), { message: 'byteSize 必须为非负整数字符串' }),
  compressed: z.boolean().default(false),
  /** 是否经服务端/客户端剥离过 EXIF */
  exifStripped: z.boolean().default(false),
  /** 原图是否含 GPS —— 供审计告警（T-4） */
  hadGps: z.boolean().default(false),
  storageClass: z.enum(['STANDARD', 'IA', 'ARCHIVE']).default('STANDARD'),
  width: z.coerce.number().int().positive().optional(),
  height: z.coerce.number().int().positive().optional(),
});

export type CreateMediaAssetInput = z.infer<typeof createMediaAssetSchema>;

export const listMediaQuerySchema = z.object({
  familyId: idInput.optional(),
  tripId: idInput.optional(),
  mimePrefix: z.string().max(32).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListMediaQueryInput = z.infer<typeof listMediaQuerySchema>;

/**
 * 照片回忆聚合（2026-10-27）。
 * 与 `listMediaQuerySchema` 分开：回忆是「按行程/月份成组」的读模型，
 * 不接受 page（分页语义在"组"上，用 limit 限制组数足够）。
 */
export const listPhotoMemoriesQuerySchema = z.object({
  familyId: idInput.optional(),
  /** 最多返回几组回忆（默认 12） */
  limit: z.coerce.number().int().positive().max(50).optional(),
  /** 每组带几张预览图（默认 9，上限 9 —— 九宫格） */
  previewSize: z.coerce.number().int().positive().max(9).optional(),
});

export type ListPhotoMemoriesQueryInput = z.infer<typeof listPhotoMemoriesQuerySchema>;

/** 预签名上传位（客户端直传前取） */
export const presignUploadSchema = z
  .object({
    /**
     * 2026-11-05：**按用途可选**。
     *   · `purpose=MEDIA`（缺省）→ 必填：家庭照片必须落在某个家庭下，且要过成员门
     *   · `purpose=AVATAR`        → 可省略：头像只认当前用户，不该被「有没有家」卡住
     *
     * 老客户端永远会带（`http.ts` 里 `resolveFamilyId()` 注入），传了也不报错 ——
     * AVATAR 分支直接忽略它，所以是纯加法、无回归面。
     */
    familyId: idInput.optional(),
    /**
     * D-2026-10-22-01 §2.3：可选行程归属。
     *
     * 前端「先取上传位再登记」的时序决定它不一定知道 tripId，
     * 故此处可选；一旦带上，服务端即按该行程的成员状态做写入门判定
     * （`confirm` 是必守点，`presign` 是提前拦截）。
     */
    tripId: idInput.optional(),
    /**
     * D-2026-10-26-04 §7：用途分流。
     *
     * 头像与家庭照片此前同池（fileKey 前缀都是 `f/<familyId>/`），孤儿清理 / 配额 /
     * 按用途过滤都无法区分。现在：`MEDIA` → `f/<familyId>/`，`AVATAR` → `a/<userId>/`。
     * 缺省 MEDIA —— 老客户端不传也走原路径（纯加法）。
     */
    purpose: z.enum(['MEDIA', 'AVATAR']).default('MEDIA'),
    fileName: z.string().min(1).max(256),
    mimeType: z.string().min(3).max(128),
    byteSize: z
      .union([z.string(), z.number()])
      .transform((v) => String(v))
      .refine((s) => /^\d+$/.test(s), { message: 'byteSize 必须为非负整数字符串' }),
  })
  .superRefine((v, ctx) => {
    // 家庭照片没有家庭可落 → 早失败（否则 fileKey 前缀会拼成 `f/undefined/`）
    if (v.purpose === 'MEDIA' && v.familyId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['familyId'],
        message: '家庭照片（purpose=MEDIA）必须提供 familyId',
      });
    }
    // 头像不属于任何行程：带上 tripId 说明客户端传错了，静默忽略会留下脏归属
    if (v.purpose === 'AVATAR' && v.tripId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tripId'],
        message: '头像（purpose=AVATAR）不支持 tripId',
      });
    }
  });

export type PresignUploadInput = z.infer<typeof presignUploadSchema>;

/**
 * 服务端剥离 EXIF（可选路径）。
 *
 * 🔴 永不静默跳过：无法剥离时必须报错，不能原样返回带 EXIF 的图。
 *    `stripExifServerSide` 内部已保证该语义。
 */
export const stripExifSchema = z.object({
  fileKey: z.string().min(1).max(512),
  mimeType: z.string().min(3).max(128),
});

export type StripExifInput = z.infer<typeof stripExifSchema>;
