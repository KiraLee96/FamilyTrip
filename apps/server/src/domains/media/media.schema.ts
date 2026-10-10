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
  familyId: idInput,
  tripId: idInput.optional(),
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

/** 预签名上传位（客户端直传前取） */
export const presignUploadSchema = z.object({
  familyId: idInput,
  fileName: z.string().min(1).max(256),
  mimeType: z.string().min(3).max(128),
  byteSize: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((s) => /^\d+$/.test(s), { message: 'byteSize 必须为非负整数字符串' }),
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
