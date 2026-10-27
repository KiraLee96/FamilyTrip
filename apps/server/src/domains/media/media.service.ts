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
import { stringCell } from '../../common/db/row-key.js';
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
      /** D-2026-10-22-01 §2.3：带 tripId 时先做行程写入门判定 */
      tripId?: bigint;
      /** D-2026-10-26-04 §7：用途分流（MEDIA / AVATAR），缺省 MEDIA */
      purpose?: 'MEDIA' | 'AVATAR';
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
    // D-2026-10-26-02 P0-2：带 tripId 时**只校验行程归属**（成员/创建者），
    // 不校验 access_level —— 已归档行程仍要能补回忆照片。
    // 这里是「早失败」优化；真正的口径由 confirm 承担（那时 tripId 一定已知）。
    if (input.tripId !== undefined) {
      await this.assertTripMediaWritable(this.o.ctx, input.tripId, userId);
    }

    const size = BigInt(input.byteSize);
    if (size <= 0n) throw new AppError(ErrorCode.VALIDATION_FAILED, '文件大小必须为正');

    const purpose = input.purpose ?? 'MEDIA';
    // fileKey 由服务端生成 —— 不让客户端指定路径（防目录穿越 / 覆盖他人文件）
    // D-2026-10-26-04 §7：头像走 `a/<userId>/`，家庭照片走 `f/<familyId>/`，两种用途不再共池
    const prefix =
      purpose === 'AVATAR' ? `a/${userId.toString()}` : `f/${input.familyId.toString()}`;
    const ext = safeExt(input.fileName);
    const fileKey = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      await tx.db.insert('filePending', {
        id: tx.write.nextId(),
        fileKey,
        ownerId: userId,
        // 有行程归属就落库：孤儿清理与审计按 trip 维度回溯时要用
        tripId: input.tripId ?? null,
        status: 'PENDING',
        // 🔴 必须落库：DB 有 chk_fp_size CHECK(expected_size > 0 AND <= 52428800)。
        // 漏传则落到 Prisma 默认值 0 → 真 MySQL 报 3819 违反约束 → POST /media/presign 恒 500。
        // 内存驱动无 CHECK 约束，故此前单测全绿也未暴露（2026-10-15 真库联调发现）。
        // 语义：签名时申报的字节数上限 —— 正是上面已校验过 size > 0 的那个 size。
        expectedSize: size,
        contentType: input.mimeType,
        // D-2026-10-26-04 §7：落真实用途（此前硬编码 MEDIA，头像也被当成家庭照片）
        purpose,
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

      // D-2026-10-26-02 P0-2（口径变更，覆盖 D-2026-10-22-01 §2.3）：
      // 用户原话「已完成的行程不能编辑信息**只能添加或删除回忆照片**」——
      // 故归档行程的照片登记**放行**，只校验行程归属；`archived` 为真时补一条
      // INFO 审计（归档后仍写入，需要留痕以便对账）。
      // 🔴 只有 media 域放宽：itinerary / checklist / expense / booking 一律维持 403。
      let archived = false;
      if (input.tripId !== undefined) {
        const gate = await this.assertTripMediaWritable(tx, input.tripId, userId);
        archived = gate.archived;
      }

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

      // 归档行程补照片：放行但留痕（INFO 级，不进告警通道）
      if (archived) {
        await this.audit(tx, {
          actorId: userId,
          action: 'media.upload_archived_trip',
          reason: 'ARCHIVED_TRIP_MEDIA_WRITE',
          severity: 'INFO',
          targetId: id,
          detail: { tripId: (input.tripId ?? 0n).toString(), fileKey: input.fileKey },
          at: now,
        });
      }

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
    if (q.tripId !== undefined) {
      // D-2026-10-15-01（P1）：行程软删后，其名下资产行**不级联软删**
      // （照片是家庭资产，「我的照片」仍可见），但按行程维度列表不再露出
      // —— 父行程已删/不存在 → 空集（防「幽灵行程」照片）。
      const trip = await this.o.ctx.read.findUnique('trip', { id: q.tripId, deletedAt: null });
      if (!trip) {
        return { items: [], meta: buildPageMeta(page, 0) as unknown as Record<string, unknown> };
      }
      rows = rows.filter((r) => r['tripId'] === q.tripId);
    }
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

      // D-2026-10-26-02 P0-2：资产带 tripId 时先过行程归属门。
      // 用「行程已软删 → 放行」的宽松版：行程删了照片仍是家庭资产、仍须允许
      // 上传者/户主清理（D-2026-10-22-01 §2.4 第 4 条「家庭照片删除行为不变」的延伸）。
      // 归档（FINISHED）**不再拦截** —— 用户明确要求归档行程可删回忆照片。
      const tripId = (r['tripId'] ?? null) as bigint | null;
      if (tripId !== null) {
        await this.assertTripMediaWritableOrGone(tx, tripId, userId);
      }

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

  /**
   * 行程媒体写入门（D-2026-10-26-02 P0-2）。
   *
   * 🔴 **只校验归属，不校验 access_level** —— 这是与
   *    itinerary / expense / checklist / booking 四域**有意**的分叉：
   *    产品口径是「已完成的行程不能编辑信息，**只能**添加或删除回忆照片」。
   *    故本方法不做 `HISTORICAL_READONLY → 403` 判定，而是把「是否归档」
   *    作为返回值交给调用方补审计。
   *
   * ⚠️ 不要在 `common/auth/access-policy` 里改四域共用的只读门来「顺手统一」——
   *    那条是四域同源的单点，动它会连坐「信息锁定」。
   *
   * 判定：行程必须存在（含 `deletedAt: null`）→ 是行程成员（含代管人）或创建者；
   * 否则 404（与「不存在」同形，防 ID 枚举）。
   *
   * @returns `archived` = 该成员在归档行程里（access_level = HISTORICAL_READONLY）
   */
  private async assertTripMediaWritable(
    src: TxHandle | DomainContext,
    tripId: bigint,
    userId: bigint,
  ): Promise<{ archived: boolean }> {
    const db = 'db' in src ? src.db : src.read;
    const t = await db.findUnique('trip', { id: tripId, deletedAt: null });
    if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    return this.assertTripMediaMember(t, await this.tripMemberRow(db, tripId, userId), userId);
  }

  /**
   * 同上的「宽松版」：行程不存在（已软删）时**放行**（`archived: false`）。
   *
   * 用于 `remove` —— 行程删除不级联软删照片（照片是家庭资产，「我的照片」
   * 仍应可见可清理），若在这里因行程已删而 404，用户就再也删不掉自己的图。
   */
  private async assertTripMediaWritableOrGone(
    src: TxHandle | DomainContext,
    tripId: bigint,
    userId: bigint,
  ): Promise<{ archived: boolean }> {
    const db = 'db' in src ? src.db : src.read;
    const t = await db.findUnique('trip', { id: tripId, deletedAt: null });
    if (!t) return { archived: false };
    return this.assertTripMediaMember(t, await this.tripMemberRow(db, tripId, userId), userId);
  }

  /**
   * 归属判定本体：成员 ∨ 创建者。
   *
   * 🔴 这里**不出现** `accessLevel` 分支 —— 一旦有人在这里补上只读判定，
   *    P0-2 会静默回退成「归档后传不了照片」。
   */
  private assertTripMediaMember(
    t: Record<string, unknown>,
    member: Record<string, unknown> | null,
    userId: bigint,
  ): { archived: boolean } {
    if (member) {
      return { archived: member['accessLevel'] === 'HISTORICAL_READONLY' };
    }
    if (t['createdBy'] === userId) return { archived: false };
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  /** 成员的 access_level 读取（含代管人：虚拟成员的代管行为等同本人） */
  private async tripMemberRow(
    db: { findUnique: TxHandle['db']['findUnique']; findMany: TxHandle['db']['findMany'] },
    tripId: bigint,
    userId: bigint,
  ): Promise<Record<string, unknown> | null> {
    const own = await db.findUnique('tripMember', { tripId, userId, deletedAt: null });
    if (own) return own;
    const managed = await db.findMany('tripMember', {
      where: { tripId, managedBy: userId, deletedAt: null },
    });
    return managed[0] ?? null;
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
  /**
   * 照片回忆聚合（2026-10-27 需求：「行程中的照片自动生成回忆墙，最近回忆显示
   * 之前所有旅行的照片，类似苹果手机相册的回忆」）。
   * ============================================================================
   * 🔴 为什么不用 `memoryArchive` 快照：那张表的唯一键是 `(familyId, year, type)`，
   *    一年只能有一篇 TRIP 回忆，而且必须手动 `generateTripMemory` 才会产生。
   *    用户要的是「自动 + 按行程聚合的照片流」，本质是**按 tripId 分组查询**，
   *    不该走快照。所以这里直接从 `media_asset` 现算，照片一上传就自动出现在
   *    回忆里，不需要任何"生成"动作。`memoryArchive` 的年度回顾保持原样。
   *
   * 分组规则：
   *   · 有 `tripId` 的照片 → 按行程成组，标题取行程名、副标题取日期区间；
   *   · 没 `tripId` 的照片 → 按 `created_at` 的月份成组（「2026 年 10 月」）。
   *
   * 🔴 必须排除头像池：头像也是 `media_asset` 行且 `tripId` 为空，
   *    按月份分组会把「换过的头像」当成旅行照片混进回忆墙。
   *    后端 local-disk 按 purpose 分池：头像 `a/<userId>/`、行程照片 `f/<familyId>/`
   *    （见 commit aabd935），所以用 `fileKey` 前缀判定。
   *
   * 输出按「组内最新一张的时间」倒序，每组带封面 + 前 N 张（供九宫格预览）。
   */
  async listPhotoMemories(
    userId: bigint,
    q: { familyId?: bigint; limit?: number; previewSize?: number },
  ): Promise<{
    items: Array<{
      kind: 'TRIP' | 'MONTH';
      tripId: string | null;
      month: string | null;
      title: string;
      subtitle: string;
      cover: string;
      photoCount: number;
      photos: string[];
      lastAt: string;
    }>;
    meta: Record<string, unknown>;
  }> {
    const visibleFamilies = await this.visibleFamilyIds(userId);
    const all = await this.o.ctx.read.findMany('mediaAsset', { where: { deletedAt: null } });

    const rows = all.filter((r) => {
      if (!visibleFamilies.has(r['familyId'] as bigint)) return false;
      if (q.familyId !== undefined && r['familyId'] !== q.familyId) return false;
      // 只要图片（视频暂不参与回忆，避免封面无法展示）
      // 用 stringCell 而不是 String(...)：行值是 unknown，String() 遇对象会产出
      // '[object Object]'（no-base-to-string），那会让过滤条件静默变成 false。
      if (!(stringCell(r, 'mimeType') ?? '').startsWith('image/')) return false;
      // 排除头像池
      if ((stringCell(r, 'fileKey') ?? '').startsWith('a/')) return false;
      return true;
    });

    const tripCache = new Map<string, Record<string, unknown> | null>();
    const groups = new Map<
      string,
      {
        kind: 'TRIP' | 'MONTH';
        tripId: bigint | null;
        month: string | null;
        rows: Record<string, unknown>[];
      }
    >();

    for (const r of rows) {
      const tripId = typeof r['tripId'] === 'bigint' ? r['tripId'] : null;
      if (tripId !== null) {
        const key = `T:${tripId.toString()}`;
        let g = groups.get(key);
        if (g === undefined) {
          g = { kind: 'TRIP', tripId, month: null, rows: [] };
          groups.set(key, g);
        }
        g.rows.push(r);
        continue;
      }
      // 无行程 → 按创建月份分组
      // 行里的 createdAt 可能是 Date（Prisma）或 ISO 字符串（内存驱动），
      // 其它形态一律当「无时间」处理 —— 绝不用 String() 兜（会得到 '[object Object]'，
      // 进而拼出非法月份、把不相干的照片合并进同一组）。
      const created = r['createdAt'];
      const iso =
        created instanceof Date
          ? created.toISOString()
          : typeof created === 'string'
            ? created
            : '';
      const month = iso.slice(0, 7); // YYYY-MM
      const key = `M:${month}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = { kind: 'MONTH', tripId: null, month, rows: [] };
        groups.set(key, g);
      }
      g.rows.push(r);
    }

    const previewSize = Math.max(1, Math.min(9, q.previewSize ?? 9));
    const items: Array<{
      kind: 'TRIP' | 'MONTH';
      tripId: string | null;
      month: string | null;
      title: string;
      subtitle: string;
      cover: string;
      photoCount: number;
      photos: string[];
      lastAt: string;
    }> = [];

    for (const g of groups.values()) {
      // 组内按创建时间倒序：第一张就是封面
      const sorted = [...g.rows].sort((a, b) => {
        const ta = a['createdAt'] instanceof Date ? a['createdAt'].getTime() : 0;
        const tb = b['createdAt'] instanceof Date ? b['createdAt'].getTime() : 0;
        return tb - ta;
      });
      const photos = sorted.slice(0, previewSize).map((r) => {
        const key = stringCell(r, 'fileKey') ?? '';
        return key === '' ? '' : `${this.mediaBase}/${key}`;
      });
      // 组内最新一张的时间（instanceof 已收窄类型，无需再断言）
      const newest = sorted[0]?.['createdAt'];
      const lastAt = newest instanceof Date ? newest.toISOString() : new Date(0).toISOString();

      if (g.kind === 'TRIP' && g.tripId !== null) {
        const cacheKey = g.tripId.toString();
        if (!tripCache.has(cacheKey)) {
          tripCache.set(cacheKey, await this.o.ctx.read.findUnique('trip', { id: g.tripId }));
        }
        const trip = tripCache.get(cacheKey) ?? null;
        if (trip === null || trip['deletedAt'] !== null) continue; // 行程已删 → 该组不露出
        const title = typeof trip['title'] === 'string' ? trip['title'] : '一次旅行';
        /**
         * 🔴 Prisma 返回的 `startDate` / `endDate` 是 **Date 对象**，不是字符串。
         *    之前只判 `typeof === 'string'`，日期恒为空 → 副标题退化成「N 张照片」，
         *    前端再拼一次张数就变成「1 张照片 · 1 张」（2026-10-27 截图发现）。
         */
        const range = compactDateRange(toDateStr(trip['startDate']), toDateStr(trip['endDate']));
        items.push({
          kind: 'TRIP',
          tripId: cacheKey,
          month: null,
          title,
          subtitle: range,
          cover: photos[0] ?? '',
          photoCount: sorted.length,
          photos,
          lastAt,
        });
        continue;
      }

      const month = g.month ?? '';
      items.push({
        kind: 'MONTH',
        tripId: null,
        month,
        title: monthFormat(month),
        // 月份组的标题已含月份，副标题留空；张数由前端统一拼，避免「N 张照片 · N 张」
        subtitle: '',
        cover: photos[0] ?? '',
        photoCount: sorted.length,
        photos,
        lastAt,
      });
    }

    // 最近有更新的组排前面
    items.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    const limit = Math.max(1, Math.min(50, q.limit ?? 12));
    const sliced = items.slice(0, limit);

    return {
      items: sliced,
      meta: { total: items.length, returned: sliced.length },
    };
  }

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

/** '2026-10' → '2026 年 10 月'（月份回忆组的标题） */
function monthFormat(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (m === null) return month === '' ? '未分类照片' : month;
  return `${m[1]} 年 ${Number(m[2])} 月`;
}

/** Date | string | null → 'YYYY-MM-DD'（Prisma 的日期列是 Date，别只判 string） */
function toDateStr(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.slice(0, 10);
  return '';
}

/**
 * 日期区间文案：同年省略结束年份，跨年两年都写（与前端 formatDateRange 同口径）。
 * 例如 `2026-10-22 ~ 10-25` / `2026-12-30 ~ 2027-01-02`。
 */
function compactDateRange(a: string, b: string): string {
  if (a === '' || b === '') return '';
  const ya = a.slice(0, 4);
  const yb = b.slice(0, 4);
  return ya === yb && ya !== '' ? `${a} ~ ${b.slice(5)}` : `${a} ~ ${b}`;
}

void PENDING_TTL_MS; // 供清理任务引用（导出于此便于配置化）

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
