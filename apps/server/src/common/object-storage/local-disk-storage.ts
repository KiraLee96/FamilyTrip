/**
 * 本地磁盘驱动 —— 单机部署的默认实现
 * ============================================================================
 * 定位：把媒体文件落到本机磁盘，由 nginx（生产）或本进程（本地联调）直接静态服务。
 *
 * 为什么单机部署先选它（而不是一上来就上云）：
 *   · 零依赖、零成本、今天就能用 —— 当前服务器是腾讯云轻量单机（50G 盘 + nginx 已在跑）；
 *   · 抽象已成：`ObjectStorage` 就三个方法，将来换 COS/S3 只加一个 driver + rsync 老文件，
 *     media 域、客户端、契约全部不动；
 *   · 代价也说清楚：单盘无冗余（靠云硬盘自动快照）、无 CDN 加速、多实例要换共享存储。
 *     这些写进 docs/媒体存储接入.md，别在出事时才发现。
 *
 * 🔴 安全边界（这个驱动直接面对用户上传的字节）：
 *   ① fileKey 只允许安全字符且禁止 `..` —— 防目录穿越写出根目录；
 *   ② 扩展名 → Content-Type 走**白名单**，未知一律 `application/octet-stream` + attachment，
 *      防把 .html/.svg 当 text/html 返回导致同域 XSS；
 *   ③ 上传位用 HMAC 签名（`fileKey + exp`），过期即失效 —— 否则任何人都能往任意 key 写。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage, SignedUpload } from './object-storage.js';

/** 收单端点路径（相对 publicBaseUrl） */
export const MEDIA_UPLOAD_PATH = 'upload';

/** 默认上传位有效期（秒）—— 与 `Taro.uploadFile` 的选图→上传间隔匹配即可 */
export const DEFAULT_UPLOAD_TTL_SECONDS = 900;

/** 单文件上限：与库级 CHECK（chk_fp_size ≤ 52428800）对齐，超了会出现「传成功但 confirm 失败」 */
export const MAX_UPLOAD_BYTES = 52_428_800; // 50MB

/** 允许的扩展名 → Content-Type（白名单，其余一律 octet-stream） */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** 由 fileKey 推 Content-Type；未知扩展名不猜（防 XSS） */
export function contentTypeOfKey(fileKey: string): string {
  return MIME_BY_EXT[path.extname(fileKey).toLowerCase()] ?? 'application/octet-stream';
}

/** 是否是可静态直出的媒体类型（未知扩展名 → false） */
export function isServableMediaKey(fileKey: string): boolean {
  return path.extname(fileKey).toLowerCase() in MIME_BY_EXT;
}

/**
 * 校验并规范化 fileKey。
 *
 * 只允许 `[A-Za-z0-9/._-]`，且禁止 `..` 与绝对路径 —— 与 `media.service.safeExt`
 * 生成的形态（`f/<familyId>/<ts>-<rand>.jpg`）一致。返回 null 表示非法。
 */
export function safeMediaKey(raw: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(raw);
  } catch {
    return null; // 非法百分号编码
  }
  key = key.replace(/^\/+/, '');
  if (key === '' || key.length > 512) return null;
  if (key.includes('..') || key.includes('\\')) return null;
  if (!/^[A-Za-z0-9/._-]+$/.test(key)) return null;
  return key;
}

/** 上传位签名：HMAC-SHA256(secret, `${fileKey}\n${exp}`) 的 hex */
export function signUploadParams(args: { fileKey: string; exp: number; secret: string }): string {
  return createHmac('sha256', args.secret)
    .update(`${args.fileKey}\n${String(args.exp)}`)
    .digest('hex');
}

/**
 * 校验上传位签名。
 *
 * 三件事缺一不可：key 合法、签名等长比对（`timingSafeEqual`，防时序侧信道）、未过期。
 * 注意 `timingSafeEqual` 在长度不等时会抛错，故先比长度。
 */
export function verifyUploadParams(args: {
  fileKey: string;
  exp: number;
  sig: string;
  secret: string;
  nowSeconds: number;
}): { ok: true } | { ok: false; reason: string } {
  if (safeMediaKey(args.fileKey) === null) return { ok: false, reason: 'fileKey 非法' };
  if (!Number.isFinite(args.exp) || args.exp <= 0) return { ok: false, reason: '缺少有效期' };
  if (args.exp < args.nowSeconds) return { ok: false, reason: '上传位已过期' };
  const expect = signUploadParams({ fileKey: args.fileKey, exp: args.exp, secret: args.secret });
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(args.sig ?? '', 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: '签名无效' };
  return { ok: true };
}

/** 生成上传位 URL（`<publicBaseUrl>/upload?fileKey=..&exp=..&sig=..`） */
export function buildUploadUrl(args: {
  publicBaseUrl: string;
  fileKey: string;
  exp: number;
  secret: string;
}): string {
  const base = args.publicBaseUrl.replace(/\/+$/, '');
  const qs = new URLSearchParams({
    fileKey: args.fileKey,
    exp: String(args.exp),
    sig: signUploadParams({ fileKey: args.fileKey, exp: args.exp, secret: args.secret }),
  });
  return `${base}/${MEDIA_UPLOAD_PATH}?${qs.toString()}`;
}

export interface LocalDiskStorageOptions {
  /** 落盘根目录（绝对路径）；生产建议独立挂载点，勿放代码目录 */
  root: string;
  /** 对外媒体基址（读）—— 也是上传端点的父路径，如 `https://api.xxx/media-files` */
  publicBaseUrl: string;
  /** 上传位签名密钥 */
  secret: string;
  /** 上传位有效期（秒） */
  ttlSeconds?: number;
  /** 注入时钟（测试用） */
  now?: () => number;
}

/**
 * 本地磁盘实现。
 *
 * 落盘布局与 fileKey 一一对应：`<root>/f/<familyId>/<ts>-<rand>.jpg`
 * —— 换云存储时 fileKey 不用改，直接 `rsync <root>/` 到桶即可。
 */
export class LocalDiskStorage implements ObjectStorage {
  readonly kind = 'local-disk';
  private readonly root: string;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(private readonly o: LocalDiskStorageOptions) {
    this.root = path.resolve(o.root);
    this.ttlSeconds = o.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 落盘绝对路径（已做穿越校验，非法 key 抛错） */
  pathOf(fileKey: string): string {
    const key = safeMediaKey(fileKey);
    if (key === null) throw new Error(`非法 fileKey：${fileKey}`);
    const full = path.resolve(this.root, key);
    // 二次兜底：规范化后必须仍在根目录内（防符号链接 / 编码绕过）
    if (full !== this.root && !full.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`fileKey 越界：${fileKey}`);
    }
    return full;
  }

  signUpload(args: { fileKey: string; mimeType: string; byteSize: bigint }): Promise<SignedUpload> {
    const exp = this.now() + this.ttlSeconds;
    return Promise.resolve({
      uploadUrl: buildUploadUrl({
        publicBaseUrl: this.o.publicBaseUrl,
        fileKey: args.fileKey,
        exp,
        secret: this.o.secret,
      }),
      headers: {},
      expiresIn: this.ttlSeconds,
    });
  }

  async putObject(fileKey: string, data: Buffer, _mimeType: string): Promise<void> {
    const full = this.pathOf(fileKey);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async fetchObject(fileKey: string): Promise<Buffer> {
    return fs.readFile(this.pathOf(fileKey));
  }
}

/** 进程内随机密钥 —— 仅供开发联调（重启即失效，不做持久化） */
export function ephemeralUploadSecret(): string {
  return randomBytes(32).toString('hex');
}
