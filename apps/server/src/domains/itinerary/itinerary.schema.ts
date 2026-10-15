/**
 * itinerary 域 · Zod schema
 */

import { z } from 'zod';

const idInput = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => /^\d+$/.test(s), { message: 'ID 必须为正整数字符串' });

/** 本地时间字符串 `YYYY-MM-DDTHH:mm`（不带时区，按出行时区解释） */
const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, '时间格式须为 YYYY-MM-DDTHH:mm');

/** M-Client-2：交通方式（地图连线按此着色） */
const transportEnum = z.enum(['WALK', 'BIKE', 'CAR', 'BUS', 'TRAIN', 'FLIGHT']);

/** M-Client-2：地图标记坐标（chooseLocation 带回；范围校验防脏值落库） */
const latInput = z.coerce.number().min(-90).max(90);
const lngInput = z.coerce.number().min(-180).max(180);

/**
 * D-2026-10-15-01 · 安排正文块（富文本/图片混排）。
 *
 * 契约冻结于前端 `apps/client/src/api/types.ts` 的 `ItineraryBlock`，
 * 后端实现必须与之一字不差（字段名、大小写、可空性）。
 *
 * 🔴 入参侧 image 块只接受 `assetId`：`url` 是服务端派生字段
 *    （= MEDIA_PUBLIC_BASE_URL + fileKey），客户端传入的 url 被 Zod 剥离忽略
 *    —— 否则等于开放任意外链注入，绕过对象存储与 EXIF 治理。
 */
/** 正文块单块上限：与前端 MAX_BLOCKS 一致（界面先拦一次，服务端独立校验） */
const blockText = z.string().min(1).max(2000);
const blockUrl = z
  .string()
  .max(512)
  .refine((u) => /^https?:\/\//i.test(u), { message: '链接只允许 http/https' });

export const itineraryBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: blockText }),
  z.object({ type: z.literal('quote'), text: blockText }),
  z.object({ type: z.literal('code'), text: z.string().min(1).max(500) }),
  z.object({ type: z.literal('link'), text: z.string().min(1).max(120), url: blockUrl }),
  // 入参只接受 assetId；url 是服务端派生字段，不接受客户端传入
  z.object({
    type: z.literal('image'),
    assetId: idInput,
    caption: z.string().max(120).optional(),
  }),
]);

export type ItineraryBlock = z.infer<typeof itineraryBlockSchema>;

/** blocks：数组上限 20，整体可空（undefined = 不更新；[] = 清空） */
export const blocksInput = z.array(itineraryBlockSchema).max(20).optional();

export const createItineraryItemSchema = z.object({
  tripId: idInput,
  familyId: idInput,
  title: z.string().min(1, '日程标题不能为空').max(128),
  startAt: localDateTime,
  endAt: localDateTime.optional(),
  location: z.string().max(256).optional(),
  note: z.string().max(2000).optional(),
  /** 排序；同一天内按此升序 */
  sort: z.coerce.number().int().default(0),
  /** 地图标记纬度（未选点则不传，该安排不参与地图标记） */
  lat: latInput.optional(),
  /** 地图标记经度 */
  lng: lngInput.optional(),
  /** 交通方式（前往/离开该安排的出行方式） */
  transport: transportEnum.optional(),
  /** 金额相关字段（可选，用于日程内记账） */
  amount: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((s) => /^\d+$/.test(s), { message: '金额必须为非负整数字符串' })
    .optional(),
  currency: z.string().length(3).optional(),
  /** 汇率来源：AUTO = 按当日 SPOT_SELL 自动；MANUAL = 用户手填 */
  rateSource: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
  /** D-2026-10-15-01：富文本/图片正文块（有序；缺省表示老数据，只有 note） */
  blocks: blocksInput,
});

export type CreateItineraryItemInput = z.infer<typeof createItineraryItemSchema>;

export const updateItineraryItemSchema = z
  .object({
    version: z.coerce.number().int().min(0),
    title: z.string().min(1).max(128).optional(),
    startAt: localDateTime.optional(),
    endAt: localDateTime.nullable().optional(),
    location: z.string().max(256).nullable().optional(),
    note: z.string().max(2000).nullable().optional(),
    sort: z.coerce.number().int().optional(),
    /** M-Client-2：坐标/交通方式；传 null 表示清除标记 */
    lat: latInput.nullable().optional(),
    lng: lngInput.nullable().optional(),
    transport: transportEnum.nullable().optional(),
    rateSource: z.enum(['AUTO', 'MANUAL']).optional(),
    /** D-2026-10-15-01：正文块整体替换（undefined = 不更新；[] = 清空） */
    blocks: blocksInput,
  })
  // ⚠️ 保持既有语义：前端更新时始终带 version + title + startAt，
  //    不会只提交 blocks 而误触发「没有需要更新的字段」。
  .refine((v) => Object.keys(v).length > 1, { message: '没有需要更新的字段' });

export type UpdateItineraryItemInput = z.infer<typeof updateItineraryItemSchema>;

export const listItineraryQuerySchema = z.object({
  tripId: idInput,
  /** 只看某天（YYYY-MM-DD） */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export type ListItineraryQueryInput = z.infer<typeof listItineraryQuerySchema>;

/** 拖动排序（批量） */
export const reorderItinerarySchema = z.object({
  tripId: idInput,
  orders: z
    .array(z.object({ id: idInput, sort: z.coerce.number().int() }))
    .min(1)
    .max(200),
});

export type ReorderItineraryInput = z.infer<typeof reorderItinerarySchema>;
