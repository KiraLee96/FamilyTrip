/**
 * 媒体文件收单 / 回读端点（express 原生路由，绕开 8 段链）
 * ============================================================================
 * 为什么不用 `RouteSpec` 走派发器：
 *   派发器的契约是「JSON 进 JSON 出」+ 统一信封 + 鉴权链；而这里要接
 *   `multipart/form-data` 二进制流。两者不兼容，硬塞进链里会破坏 body 解析。
 *
 * 鉴权：**不看 Authorization，看 URL 上的签名**（`fileKey + exp` 的 HMAC）。
 *   原因：小程序 `Taro.uploadFile` 的 header 来自 presign 响应，塞 Bearer token
 *   既多一次往返也容易过期；URL 自带短时效签名更省事，也天然不可分享给他人复用。
 *   → 签名校验由 `LocalDiskStorage` 的 `verifyUploadParams` 承担。
 *
 * 🔴 挂在根路径 `/media-files`（**不是** `/api`）：Nest 的 `HttpAdapterController`
 *    已经把 `/api/*` 全量 ALL 路由注册成了派发入口，晚注册的同前缀路由会被它吃掉。
 *    因此 nginx 需要为本前缀单独加一个 location（见 deploy/nginx-family-trip.conf）。
 */

import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  contentTypeOfKey,
  isServableMediaKey,
  MAX_UPLOAD_BYTES,
  safeMediaKey,
  verifyUploadParams,
} from './local-disk-storage.js';
import type { ObjectStorage } from './object-storage.js';

/** 对外路由前缀（nginx 需同前缀反代/alias） */
export const MEDIA_FILE_PREFIX = '/media-files';

/** multipart 头部/边界等附加开销的宽容量 */
const MULTIPART_SLACK_BYTES = 64 * 1024;

export interface MediaFileRouteDeps {
  storage: ObjectStorage;
  /** 上传位签名密钥（与签发侧同源） */
  uploadSecret: string;
  /** 单文件上限（默认 50MB，与库级 CHECK 对齐） */
  maxBytes?: number;
  /** 注入时钟（秒），测试用 */
  now?: () => number;
}

export interface MediaFileHandlers {
  upload: (req: IncomingMessage, res: ServerResponse) => void;
  read: (req: IncomingMessage, res: ServerResponse) => void;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: { code: number; message: string; data?: unknown },
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ...payload, data: payload.data ?? null, meta: {} }));
}

/** 读取请求体，超过上限立即中断（防大文件把内存打满） */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`文件超过 ${String(Math.floor(limit / 1024 / 1024))}MB 上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 从 multipart 请求体里取出文件分片。
 *
 * 只服务 `Taro.uploadFile` 这一种形态（单文件、字段名 `file`），做通用 multipart
 * 解析需要引依赖，不划算；拿不到 `name="file"` 时退化为「第一个带 Content-Type 的分片」。
 */
function extractFilePart(
  body: Buffer,
  contentType: string,
): { data: Buffer; mimeType: string } | null {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (m?.[1] ?? m?.[2] ?? '').trim();
  if (boundary === '') return null;

  const sep = Buffer.from(`--${boundary}`);
  const parsed: Array<{ headers: string; data: Buffer }> = [];

  let idx = body.indexOf(sep);
  while (idx !== -1) {
    const next = body.indexOf(sep, idx + sep.length);
    if (next === -1) break;
    const start = idx + sep.length + 2; // 跳过边界后的 \r\n
    const end = next - 2; // 去掉分片末尾的 \r\n
    if (end > start) {
      const chunk = body.subarray(start, end);
      const headerEnd = chunk.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        parsed.push({
          headers: chunk.subarray(0, headerEnd).toString('utf8'),
          data: chunk.subarray(headerEnd + 4),
        });
      }
    }
    idx = next;
  }

  const named = parsed.find((p) => /name="file"/i.test(p.headers));
  const picked = named ?? parsed.find((p) => /content-type:/i.test(p.headers));
  if (picked === undefined || picked.data.length === 0) return null;

  const declared = /content-type:\s*([^\r\n;]+)/i.exec(picked.headers)?.[1]?.trim();
  return {
    data: picked.data,
    mimeType: declared !== undefined && declared !== '' ? declared : 'application/octet-stream',
  };
}

export function createMediaFileHandlers(deps: MediaFileRouteDeps): MediaFileHandlers {
  const maxBytes = deps.maxBytes ?? MAX_UPLOAD_BYTES;
  const now = deps.now ?? ((): number => Math.floor(Date.now() / 1000));

  /** POST/PUT <prefix>/upload?fileKey&exp&sig —— 收流 → 校验签名 → 落盘 */
  const upload = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const fileKey = url.searchParams.get('fileKey') ?? '';
      const sig = url.searchParams.get('sig') ?? '';
      const exp = Number(url.searchParams.get('exp') ?? '0');

      const verdict = verifyUploadParams({
        fileKey,
        exp,
        sig,
        secret: deps.uploadSecret,
        nowSeconds: now(),
      });
      if (!verdict.ok) {
        // 签名是这里唯一的凭据，失败一律 403（不区分「过期」与「伪造」给客户端细节）
        sendJson(res, 403, { code: 4030, message: `上传位不可用：${verdict.reason}` });
        return;
      }

      let raw: Buffer;
      try {
        raw = await readBody(req, maxBytes + MULTIPART_SLACK_BYTES);
      } catch (e) {
        sendJson(res, 413, {
          code: 4130,
          message: e instanceof Error ? e.message : '文件超出上限',
        });
        return;
      }

      const contentType = String(req.headers['content-type'] ?? '');
      const part = contentType.includes('multipart/form-data')
        ? extractFilePart(raw, contentType)
        : { data: raw, mimeType: contentType.split(';')[0] ?? 'application/octet-stream' };

      if (part === null || part.data.length === 0) {
        sendJson(res, 400, { code: 4000, message: '请求体为空或缺少文件分片' });
        return;
      }
      if (part.data.length > maxBytes) {
        sendJson(res, 413, { code: 4130, message: '文件超过 50MB 上限' });
        return;
      }

      const key = safeMediaKey(fileKey);
      if (key === null) {
        sendJson(res, 400, { code: 4000, message: 'fileKey 非法' });
        return;
      }

      try {
        await deps.storage.putObject(key, part.data, part.mimeType);
      } catch (e) {
        console.error('[media] 落盘失败', key, e instanceof Error ? e.message : e);
        sendJson(res, 500, { code: 5000, message: '存储写入失败' });
        return;
      }

      sendJson(res, 200, {
        code: 0,
        message: 'ok',
        data: { fileKey: key, byteSize: part.data.length, mimeType: part.mimeType },
      });
    })().catch((e: unknown) => {
      console.error('[media] 收单端点异常', e instanceof Error ? e.message : e);
      if (!res.headersSent) sendJson(res, 500, { code: 5000, message: '服务内部错误' });
      else res.end();
    });
  };

  /** GET <prefix>/<fileKey> —— 静态回读（生产由 nginx alias 接管，这里是本地联调兜底） */
  const read = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      const raw = url.startsWith(MEDIA_FILE_PREFIX) ? url.slice(MEDIA_FILE_PREFIX.length) : url;
      const key = safeMediaKey(raw);
      if (key === null) {
        sendJson(res, 400, { code: 4000, message: 'fileKey 非法' });
        return;
      }
      // 🔴 未知扩展名不返回（防把 .html/.svg 当页面直出造成同域 XSS）
      if (!isServableMediaKey(key)) {
        sendJson(res, 404, { code: 4040, message: '资源不存在' });
        return;
      }
      try {
        const data = await deps.storage.fetchObject(key);
        res.statusCode = 200;
        res.setHeader('Content-Type', contentTypeOfKey(key));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.end(data);
      } catch {
        // 不区分「不存在」与「读失败」，避免探测
        sendJson(res, 404, { code: 4040, message: '资源不存在' });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { code: 5000, message: '服务内部错误' });
      else res.end();
    });
  };

  return { upload, read };
}

/**
 * 挂到 express 实例上。
 *
 * 参数用结构化类型而不是 import express：本仓没有 `@types/express` 的直接依赖
 * 语境下（Nest 自带适配器），避免为两个方法引入类型耦合。
 */
export function mountMediaFileRoutes(
  express: {
    get: (p: string, h: (req: IncomingMessage, res: ServerResponse) => void) => unknown;
    post: (p: string, h: (req: IncomingMessage, res: ServerResponse) => void) => unknown;
    put: (p: string, h: (req: IncomingMessage, res: ServerResponse) => void) => unknown;
  },
  handlers: MediaFileHandlers,
): void {
  express.post(`${MEDIA_FILE_PREFIX}/upload`, handlers.upload);
  express.put(`${MEDIA_FILE_PREFIX}/upload`, handlers.upload);
  express.get(`${MEDIA_FILE_PREFIX}/*`, handlers.read);
}

/** 仅测试用：直出 fs 探测（判断某个 key 是否真落盘） */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}
