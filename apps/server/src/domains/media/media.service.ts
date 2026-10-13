/**
 * media 域 · service
 * ============================================================================
 * 职责：媒体资产登记 + 上传位签发 + EXIF 剥离编排。
 *
 * 🔴 M6 · EXIF 剥离是**强制**的
 *   家庭照片带 GPS = 把家庭住址公开（很多用户不知道）。
 *   故：
 *     · `had_gps` 落库供审计告警
 *     · `exif_stripped` 落库表明已处理
 *     · 未剥离的资产一律标记 `exifStripped: false` + 审计 ALERT
 *
 * 🔴 FilePending 两阶段（防孤儿文件）
 *   直传流程：预签名 → 客户端上传 → 登记确认。
 *   若客户端上传后没来登记，对象存储里就留了孤儿文件。
 *   故用 `file_pending` 表：预签名时插 PENDING，登记时转 CONFIRMED，
 *   定时任务清理超时 PENDING 并删对象。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { stripExifServerSide, type ImageProcessor } from '../../common/media/exif-strip.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface MediaServiceOptions {
  ctx: DomainContext;
  /** 预签名生成器（生产接对象存储 SDK） */
  signUpload?: (args: { fileKey: string; mimeType: string; byteSize: bigint }) => Promise<{
    uploadUrl: string;
    headers?: Record<string, string>;
    expiresIn: number;
  }>;
  /** 图片处理器（生产接 sharp） */
  processor?: ImageProcessor;
  /** 从对象存储读文件（服务端剥离场景） */
  fetchObject?: (fileKey: string) => Promise<Buffer>;
  /** 写回对象存储（服务端剥离场景） */
  putObject?: (fileKey: string, data: Buffer, mimeType: string) => Promise<void>;
  auditRetentionDays?: number;
  /** 允许的 MIME 前缀 */
  allowedMimePrefixes?: readonly string[];
  /** 媒体公网访问基址（方案 A：list 响应会把 fileKey 拼成可访问 URL）。生产接 CDN。 */
  mediaPublicBaseUrl?: string;
}

const MEDIA_BIGINT_FIELDS = ['id', 'familyId', 'tripId', 'ownerId', 'byteSize'];
const DEFAULT_ALLOWED = ['image/', 'video/'] as const;
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 小时

export class MediaService {
  private readonly retentionDays: number;
  private readonly allowed: readonly string[];
  private readonly mediaBase: string;

  constructor(private readonly o: MediaServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
    this.allowed = o.allowedMimePrefixes ?? DEFAULT_ALLOWED;
    this.mediaBase = (o.mediaPublicBaseUrl ?? 'https://media.local').replace(/\/+$/, '');
  }

  /** 签发上传位（第一段） */
  async presign(
    userId: bigint,
    input: {
      familyId: bigint;
      fileName: string;
      mimeType: string;
      byteSize: string;
    },
  ): Promise<{
    uploadUrl: string;
    headers?: Record<string, string>;
    expiresIn: number;
    fileKey: string;
  }> {
    this.assertMimeAllowed(input.mimeType);
    await this.assertFamilyMember(this.o.ctx, input.familyId, userId);

    const size = BigInt(input.byteSize);
    if (size <= 0n) throw new AppError(ErrorCode.VALIDATION_FAILED, '文件大小必须为正');

    // fileKey 由服务端生成 —— 不让客户端指定路径（防目录穿越 / 覆盖他人文件）
    const ext = safeExt(input.fileName);
    const fileKey = `f/${input.familyId}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      await tx.db.insert('filePending', {
        id: tx.write.nextId(),
        fileKey,
        ownerId: userId,
        tripId: null,
        status: 'PENDING',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      const signed = this.o.signUpload
        ? await this.o.signUpload({ fileKey, mimeType: input.mimeType, byteSize: size })
        : { uploadUrl: `https://upload.local/${fileKey}`, headers: {}, expiresIn: 900 };

      return { fileKey, ...signed };
    });
  }

  /** 登记资产（第二段：上传后确认） */
  async confirm(
    userId: bigint,
    input: {
      familyId: bigint;
      tripId?: bigint;
      fileKey: string;
      mimeType: string;
      byteSize: string;
      compressed: boolean;
      exifStripped: boolean;
      hadGps: boolean;
      storageClass: string;
      width?: number;
      height?: number;
    },
  ): Promise<Record<string, unknown>> {
    this.assertMimeAllowed(input.mimeType);

    return this.o.ctx.tx(async (tx) => {
      await this.assertFamilyMember(tx, input.familyId, userId);

      // filePending 必须存在且属于我（防「登记别人上传的文件」）
      const pending = await tx.db.findUnique('filePending', {
        fileKey: input.fileKey,
        deletedAt: null,
      });
      if (!pending) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      if (pending['ownerId'] !== userId) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');

      const now = await tx.db.dbNow();
      const id = tx.write.nextId();

      await tx.db.insert('mediaAsset', {
        id,
        familyId: input.familyId,
        tripId: input.tripId ?? null,
        ownerId: userId,
        fileKey: input.fileKey,
        mimeType: input.mimeType,
        byteSize: BigInt(input.byteSize),
        compressed: input.compressed,
        exifStripped: input.exifStripped,
        hadGps: input.hadGps,
        storageClass: input.storageClass,
        width: input.width ?? null,
        height: input.height ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await tx.db.update(
        'filePending',
        { id: pending['id'] },
        { status: 'CONFIRMED', updatedAt: now },
      );

      await this.change(tx, 'media_asset', id, input.familyId, input.tripId ?? null, 'INSERT', now);

      // GPS 未剥离 → 审计 ALERT（M6）
      if (input.hadGps && !input.exifStripped) {
        await this.audit(tx, {
          actorId: userId,
          action: 'media.exif_not_stripped',
          reason: 'GPS_METADATA_PRESENT',
          severity: 'ALERT',
          targetId: id,
          detail: { fileKey: input.fileKey, mimeType: input.mimeType },
          at: now,
        });
      }

      const row = await tx.db.findUnique('mediaAsset', { id });
      return this.withUrl(serializeRow(row ?? {}, MEDIA_BIGINT_FIELDS));
    });
  }

  /**
   * 服务端剥离 EXIF（可选路径 —— 客户端不剥离时兜底）。
   *
   * 🔴 需读+写对象存储（外部 I/O） → **必须在事务外**执行。
   *    只有最后的元数据回写用短事务。
   */
  async stripExif(
    userId: bigint,
    input: { fileKey: string; mimeType: string },
  ): Promise<{ asset: Record<string, unknown>; hadExif: boolean; hadGps: boolean }> {
    if (this.o.fetchObject === undefined || this.o.putObject === undefined) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, '未配置对象存储读写能力，无法服务端剥离');
    }

    const asset = await this.o.ctx.read.findUnique('mediaAsset', {
      fileKey: input.fileKey,
      deletedAt: null,
    });
    if (!asset) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertFamilyMember(this.o.ctx, asset['familyId'] as bigint, userId);

    // ── 事务外：读 → 剥离 → 写回 ──
    const raw = await this.o.fetchObject(input.fileKey);
    const result = await stripExifServerSide(
      raw,
      this.o.processor ? { processor: this.o.processor } : {},
    );
    await this.o.putObject(input.fileKey, result.data, input.mimeType);

    // ── 短事务：回写标记 ──
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      await tx.db.update(
        'mediaAsset',
        { id: asset['id'] },
        {
          exifStripped: result.exifStripped,
          hadGps: result.hadGps,
          byteSize: BigInt(result.data.length),
          updatedAt: now,
        },
      );

      if (result.hadGps) {
        await this.audit(tx, {
          actorId: userId,
          action: 'media.exif_stripped_server_side',
          reason: 'GPS_DETECTED_AND_REMOVED',
          severity: 'WARN',
          targetId: asset['id'] as bigint,
          detail: { hadExif: result.hadExif, hadGps: result.hadGps },
          at: now,
        });
      }

      const row = await tx.db.findUnique('mediaAsset', { id: asset['id'] });
      return {
        asset: this.withUrl(serializeRow(row ?? {}, MEDIA_BIGINT_FIELDS)),
        hadExif: result.hadExif,
        hadGps: result.hadGps,
      };
    });
  }

  /** 列表 */
  async list(
    userId: bigint,
    q: {
      familyId?: bigint;
      tripId?: bigint;
      mimePrefix?: string;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const visibleFamilies = await this.visibleFamilyIds(userId);

    const all = await this.o.ctx.read.findMany('mediaAsset', { where: { deletedAt: null } });
    let rows = all.filter((r) => visibleFamilies.has(r['familyId'] as bigint));
    if (q.familyId !== undefined) rows = rows.filter((r) => r['familyId'] === q.familyId);
    if (q.tripId !== undefined) rows = rows.filter((r) => r['tripId'] === q.tripId);
    if (q.mimePrefix !== undefined)
      rows = rows.filter((r) => String(r['mimeType']).startsWith(q.mimePrefix!));

    rows = [...rows].sort((a, b) => timeOf(b['createdAt']) - timeOf(a['createdAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    return {
      items: slice.map((r) => this.withUrl(serializeRow(r, MEDIA_BIGINT_FIELDS))),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  async remove(userId: bigint, assetId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('mediaAsset', { id: assetId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      // 仅上传者可删（避免他人删你照片）
      if (r['ownerId'] !== userId) {
        await this.assertFamilyOwner(tx, r['familyId'] as bigint, userId);
      }

      const now = await tx.db.dbNow();
      await tx.db.update('mediaAsset', { id: assetId }, { deletedAt: now, updatedAt: now });
      await this.change(
        tx,
        'media_asset',
        assetId,
        r['familyId'] as bigint,
        (r['tripId'] ?? null) as bigint | null,
        'DELETE',
        now,
      );
      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private assertMimeAllowed(mime: string): void {
    if (!this.allowed.some((p) => mime.startsWith(p))) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, `不支持的媒体类型：${mime}`);
    }
  }

  private async assertFamilyMember(
    src: TxHandle | DomainContext,
    familyId: bigint,
    userId: bigint,
  ): Promise<void> {
    const db = 'db' in src ? src.db : src.read;
    const m = await db.findUnique('familyMember', { familyId, userId, deletedAt: null });
    if (m) return;
    const managed = await db.findMany('familyMember', {
      where: { familyId, managedBy: userId, deletedAt: null },
    });
    if (managed.length > 0) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async assertFamilyOwner(tx: TxHandle, familyId: bigint, userId: bigint): Promise<void> {
    const o = await tx.db.findUnique('familyMember', {
      familyId,
      userId,
      role: 'OWNER',
      deletedAt: null,
    });
    if (!o) throw new AppError(ErrorCode.FORBIDDEN, '仅上传者或户主可删除');
  }

  private async visibleFamilyIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('familyMember', {
      where: { userId, deletedAt: null },
    });
    const managed = await this.o.ctx.read.findMany('familyMember', {
      where: { managedBy: userId, deletedAt: null },
    });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['familyId'] as bigint);
    for (const m of managed) s.add(m['familyId'] as bigint);
    return s;
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    familyId: bigint | null,
    tripId: bigint | null,
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId,
      tripId,
      op,
      changedAt: at,
      createdAt: at,
    });
  }

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
      targetId: bigint;
      detail?: Record<string, unknown>;
      at: Date;
    },
  ): Promise<void> {
    await tx.db.insert('auditLog', {
      id: tx.write.nextId(),
      actorId: e.actorId,
      action: e.action,
      reason: e.reason,
      severity: e.severity,
      retainUntil: new Date(e.at.getTime() + this.retentionDays * 86_400_000),
      targetType: 'media_asset',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }

  /**
   * 契约（#3 方案 A）：把内部 `fileKey` 拼成可访问 URL 随响应返回，前端零拼接。
   * base 来自 `MEDIA_PUBLIC_BASE_URL`（生产接对象存储 / CDN 公网域名）；
   * 缺省回落占位域名，仅供联调阶段验证契约形状（链接不可达）。
   */
  private withUrl(row: Record<string, unknown>): Record<string, unknown> {
    const fileKey = typeof row['fileKey'] === 'string' ? row['fileKey'] : '';
    return { ...row, url: fileKey ? `${this.mediaBase}/${fileKey}` : '' };
  }
}

/** 安全扩展名：只允许字母数字，防路径注入 */
function safeExt(fileName: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(fileName);
  return m ? `.${m[1]!.toLowerCase()}` : '';
}

void PENDING_TTL_MS; // 供清理任务引用（导出于此便于配置化）

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
