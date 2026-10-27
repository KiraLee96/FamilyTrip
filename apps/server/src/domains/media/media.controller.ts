/**
 * media 域 · controller（薄层）
 *
 * 路由（5 条）：
 *   POST   /media/presign      预签名上传位
 *   POST   /media/confirm      上传后登记资产
 *   POST   /media/strip-exif   服务端剥离 EXIF（可选兜底路径）
 *   GET    /media              资产列表
 *   DELETE /media/:id          删除资产
 */

import type { RouteSpec } from '../../common/middleware/dispatcher.js';
import type { ResolvedOwnership } from '../../common/middleware/chain.js';
import type { ImageProcessor } from '../../common/media/exif-strip.js';
import type { DomainContext } from '../domain-context.js';
import { MediaService } from './media.service.js';
import {
  createMediaAssetSchema,
  listMediaQuerySchema,
  listPhotoMemoriesQuerySchema,
  presignUploadSchema,
  stripExifSchema,
  type CreateMediaAssetInput,
  type ListMediaQueryInput,
  type ListPhotoMemoriesQueryInput,
  type PresignUploadInput,
  type StripExifInput,
} from './media.schema.js';

export interface MediaDomainOptions {
  ctx: DomainContext;
  signUpload?: (args: { fileKey: string; mimeType: string; byteSize: bigint }) => Promise<{
    uploadUrl: string;
    headers?: Record<string, string>;
    expiresIn: number;
  }>;
  processor?: ImageProcessor;
  fetchObject?: (fileKey: string) => Promise<Buffer>;
  putObject?: (fileKey: string, data: Buffer, mimeType: string) => Promise<void>;
  allowedMimePrefixes?: readonly string[];
  /** 媒体公网访问基址（方案 A：list 响应拼可访问 URL） */
  mediaPublicBaseUrl?: string;
}

export interface MediaDomain {
  routes: RouteSpec<never, unknown>[];
  service: MediaService;
}

export function createMediaDomain(o: MediaDomainOptions): MediaDomain {
  const service = new MediaService({
    ctx: o.ctx,
    ...(o.signUpload !== undefined ? { signUpload: o.signUpload } : {}),
    ...(o.processor !== undefined ? { processor: o.processor } : {}),
    ...(o.fetchObject !== undefined ? { fetchObject: o.fetchObject } : {}),
    ...(o.putObject !== undefined ? { putObject: o.putObject } : {}),
    ...(o.allowedMimePrefixes !== undefined ? { allowedMimePrefixes: o.allowedMimePrefixes } : {}),
    ...(o.mediaPublicBaseUrl !== undefined ? { mediaPublicBaseUrl: o.mediaPublicBaseUrl } : {}),
  });

  /**
   * 🔴 归属维度必须透传链在 withOwner 段读到的 `resolved`。
   *    写死 `familyId: null` 会让 SHARED_FAMILY 判定永远失败——
   *    表现为「自己是成员却被 404」，是最难查的一类权限 bug。
   */
  const ref = (
    id: bigint,
    _req: unknown,
    resolved: ResolvedOwnership,
  ): { type: 'media_asset'; id: bigint; familyId: bigint | null; tripId: bigint | null } => ({
    type: 'media_asset',
    id,
    familyId: resolved.familyId,
    tripId: resolved.tripId,
  });

  const routes: RouteSpec<never, unknown>[] = [
    {
      method: 'POST',
      path: '/media/presign',
      auth: { public: false, resourceType: 'media_asset', mode: 'WRITE' },
      idParam: '__none__',
      schema: presignUploadSchema as never,
      handler: async (ctx, input) => {
        const b = input as PresignUploadInput;
        const r = await service.presign(ctx.userId!, {
          familyId: BigInt(b.familyId),
          ...(b.tripId !== undefined ? { tripId: BigInt(b.tripId) } : {}),
          // D-2026-10-26-04 §7：用途分流（schema 已给默认值 MEDIA）
          purpose: b.purpose,
          fileName: b.fileName,
          mimeType: b.mimeType,
          byteSize: b.byteSize,
        });
        return { data: r };
      },
    },

    {
      method: 'POST',
      path: '/media/confirm',
      auth: { public: false, resourceType: 'media_asset', mode: 'WRITE' },
      idParam: '__none__',
      schema: createMediaAssetSchema as never,
      handler: async (ctx, input) => {
        const b = input as CreateMediaAssetInput;
        const asset = await service.confirm(ctx.userId!, {
          familyId: BigInt(b.familyId),
          ...(b.tripId !== undefined ? { tripId: BigInt(b.tripId) } : {}),
          fileKey: b.fileKey,
          mimeType: b.mimeType,
          byteSize: b.byteSize,
          compressed: b.compressed,
          exifStripped: b.exifStripped,
          hadGps: b.hadGps,
          storageClass: b.storageClass,
          ...(b.width !== undefined ? { width: b.width } : {}),
          ...(b.height !== undefined ? { height: b.height } : {}),
        });
        return { data: { asset } };
      },
    },

    {
      method: 'POST',
      path: '/media/strip-exif',
      auth: { public: false, resourceType: 'media_asset', mode: 'WRITE' },
      idParam: '__none__',
      schema: stripExifSchema as never,
      handler: async (ctx, input) => {
        const b = input as StripExifInput;
        const r = await service.stripExif(ctx.userId!, {
          fileKey: b.fileKey,
          mimeType: b.mimeType,
        });
        return { data: r };
      },
    },

    {
      method: 'GET',
      path: '/media',
      auth: { public: false, resourceType: 'media_asset', mode: 'READ' },
      idParam: '__none__',
      schema: listMediaQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListMediaQueryInput;
        const r = await service.list(ctx.userId!, {
          ...(q.familyId !== undefined ? { familyId: BigInt(q.familyId) } : {}),
          ...(q.tripId !== undefined ? { tripId: BigInt(q.tripId) } : {}),
          ...(q.mimePrefix !== undefined ? { mimePrefix: q.mimePrefix } : {}),
          page: q.page,
          pageSize: q.pageSize,
        });
        return { data: r, meta: r.meta };
      },
    },

    /**
     * 照片回忆聚合（2026-10-27 需求）。
     * ==========================================================================
     * 「行程中的照片自动生成回忆墙，最近回忆显示之前所有旅行的照片」——
     * 现算，不依赖 `memoryArchive` 快照，也不要求任何"生成"动作：
     * 照片一上传就自动出现在对应行程/月份的回忆组里。
     */
    {
      method: 'GET',
      path: '/media/memories',
      auth: { public: false, resourceType: 'media_asset', mode: 'READ' },
      idParam: '__none__',
      schema: listPhotoMemoriesQuerySchema as never,
      handler: async (ctx, input) => {
        const q = input as ListPhotoMemoriesQueryInput;
        const r = await service.listPhotoMemories(ctx.userId!, {
          ...(q.familyId !== undefined ? { familyId: BigInt(q.familyId) } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.previewSize !== undefined ? { previewSize: q.previewSize } : {}),
        });
        return { data: r, meta: r.meta };
      },
    },

    {
      method: 'DELETE',
      path: '/media/:id',
      auth: { public: false, resourceType: 'media_asset', mode: 'DELETE', ref },
      handler: async (ctx) => {
        const at = await service.remove(ctx.userId!, ctx.resourceId!);
        return { data: null as never, meta: { updatedAt: at.toISOString() } };
      },
    },
  ];

  return { routes, service };
}
