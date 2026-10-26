/**
 * D-2026-10-26-04 · 媒体上传链路（对象存储 + 收单端点 + 用途分流）
 * ============================================================================
 * 这条测试补的是派发单 §9 点出的回归缺口：
 *   「上传整条链路在建库以来从未被真实执行过」——
 *   服务端测试全跑内存驱动 + `signUpload` 未注入 → presign 恒返占位地址，
 *   客户端 H5 验收跑 Mock 客户端 → 假成功。
 *
 * 本文件把链路拆成两层都跑真：
 *   ① 存储层：LocalDiskStorage 落真实临时目录，字节可回读、可断言；
 *   ② HTTP 层：直接把收单 / 回读 handler 当 Node http 处理器驱动（真 multipart），
 *      再用 `app.dispatch()` 走完整的 8 段链取 presign / confirm / list。
 *
 * 换句话说：presign → 上传 → 回读 → confirm → list.url 可访问，五步全绿才算过。
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import {
  MAX_UPLOAD_BYTES,
  safeMediaKey,
  signUploadParams,
  verifyUploadParams,
} from '../src/common/object-storage/local-disk-storage.js';
import {
  createMediaFileHandlers,
  type MediaFileHandlers,
} from '../src/common/object-storage/media-file-routes.js';
import { resolveMediaStorage } from '../src/common/object-storage/index.js';
import { dumpTable, mustOk, req, scaffold, type Scaffold } from './helpers.js';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const BASE = 'http://127.0.0.1:3999/media-files';
const NOW = 1_790_000_000; // 固定时钟，签名过期用例可精确控制

let tmpRoot = '';

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ft-media-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** 造一个真实的 multipart/form-data 请求体（模拟 Taro.uploadFile） */
function multipartBody(bytes: Buffer, mime = 'image/jpeg'): { body: Buffer; contentType: string } {
  const boundary = '----familyTripBoundary7d91';
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="photo.jpg"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  headersSent: boolean;
  body: Buffer;
  setHeader(name: string, value: string): void;
  end(chunk?: Buffer | string): void;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: Buffer.alloc(0),
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      res.headersSent = true;
      if (chunk !== undefined) res.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    },
  };
  return res;
}

/** 把 Buffer 包装成 IncomingMessage 的最小可用形态 */
function fakeReq(url: string, body: Buffer | null, contentType?: string): IncomingMessage {
  const stream = body === null ? Readable.from([]) : Readable.from([body]);
  return Object.assign(stream, {
    url,
    method: 'POST',
    headers: contentType !== undefined ? { 'content-type': contentType } : {},
  }) as unknown as IncomingMessage;
}

/** 驱动一次 handler，等它结束（handler 内部是 void + promise 链，靠 res.end 判定完成） */
async function run(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  request: IncomingMessage,
  response: FakeResponse,
): Promise<FakeResponse> {
  handler(request, response as unknown as ServerResponse);
  for (let i = 0; i < 200 && !response.headersSent; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return response;
}

function jsonOf(res: FakeResponse): { code: number; message: string; data: unknown } {
  return JSON.parse(res.body.toString('utf8')) as { code: number; message: string; data: unknown };
}

/** 用给定存储装配一个 app（其余全内存驱动） */
function appWith(storage: ReturnType<typeof resolveMediaStorage>): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaStorage: storage,
    mediaPublicBaseUrl: storage.publicBaseUrl,
  });
}

function storageFor(
  overrides: Record<string, string> = {},
): ReturnType<typeof resolveMediaStorage> {
  return resolveMediaStorage(
    {
      NODE_ENV: 'test',
      MEDIA_PUBLIC_BASE_URL: BASE,
      MEDIA_UPLOAD_SECRET: SECRET,
      OBJECT_STORAGE_ROOT: tmpRoot,
      ...overrides,
    },
    { now: () => NOW },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 一、配置解析与降级
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-04 · 存储配置解析', () => {
  it('① 开发未配密钥 → 进程内随机密钥 + 本地磁盘驱动（零配置可跑）', () => {
    const r = resolveMediaStorage({ NODE_ENV: 'development', PORT: '3010' });
    expect(r.storage.kind).toBe('local-disk');
    expect(r.mountRoutes).toBe(true);
    expect(r.publicBaseUrl).toBe('http://127.0.0.1:3010/media-files');
    expect(r.uploadSecret.length).toBeGreaterThan(16);
    expect(r.problems).toEqual([]);
  });

  it('② 生产缺配置 → 不拖死进程，但 presign 明确报 5008（不再回假地址）', async () => {
    const r = resolveMediaStorage({
      NODE_ENV: 'production',
      MEDIA_PUBLIC_BASE_URL: 'https://media.local', // 占位域名
    });
    expect(r.storage.kind).toBe('unconfigured');
    expect(r.mountRoutes).toBe(false);
    expect(r.problems.join(' ')).toContain('MEDIA_UPLOAD_SECRET');
    expect(r.problems.join(' ')).toContain('占位域名');

    await expect(
      r.storage.signUpload({ fileKey: 'f/1/a.jpg', mimeType: 'image/jpeg', byteSize: 1n }),
    ).rejects.toMatchObject({ code: ErrorCode.MEDIA_STORAGE_UNCONFIGURED });
  });

  it('③ 生产配置齐全 → 本地磁盘驱动，基址取显式环境变量', () => {
    const r = resolveMediaStorage({
      NODE_ENV: 'production',
      MEDIA_PUBLIC_BASE_URL: 'https://api.example.com/media-files/',
      MEDIA_UPLOAD_SECRET: SECRET,
      OBJECT_STORAGE_ROOT: '/var/lib/ft-media',
    });
    expect(r.storage.kind).toBe('local-disk');
    expect(r.publicBaseUrl).toBe('https://api.example.com/media-files'); // 去尾斜杠
    expect(r.problems).toEqual([]);
  });

  it('④ 未实现的 provider 直接抛错（不静默退回本地磁盘）', () => {
    expect(() => resolveMediaStorage({ OBJECT_STORAGE_PROVIDER: 'cos' })).toThrow(/尚未实现/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 二、签名与路径安全
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-04 · 上传位签名与路径安全', () => {
  const fileKey = 'f/100/1700000000-abc123.jpg';

  it('① 签名有效；过期 / 篡改 / 换 key 全部拒绝', () => {
    const exp = NOW + 900;
    const sig = signUploadParams({ fileKey, exp, secret: SECRET });
    expect(verifyUploadParams({ fileKey, exp, sig, secret: SECRET, nowSeconds: NOW }).ok).toBe(
      true,
    );

    expect(
      verifyUploadParams({ fileKey, exp, sig, secret: SECRET, nowSeconds: exp + 1 }),
    ).toMatchObject({ ok: false, reason: '上传位已过期' });

    expect(
      verifyUploadParams({
        fileKey,
        exp,
        sig: `${sig.slice(0, -1)}0`,
        secret: SECRET,
        nowSeconds: NOW,
      }),
    ).toMatchObject({ ok: false, reason: '签名无效' });

    // 换 key 复用同一签名 → 签名不匹配（签名覆盖了 fileKey）
    expect(
      verifyUploadParams({ fileKey: 'f/100/other.jpg', exp, sig, secret: SECRET, nowSeconds: NOW }),
    ).toMatchObject({ ok: false, reason: '签名无效' });

    // 换密钥（模拟他人伪造）
    expect(
      verifyUploadParams({ fileKey, exp, sig, secret: 'other-secret', nowSeconds: NOW }),
    ).toMatchObject({ ok: false, reason: '签名无效' });
  });

  it('② fileKey 穿越 / 非法字符一律 null', () => {
    expect(safeMediaKey('f/100/a.jpg')).toBe('f/100/a.jpg');
    expect(safeMediaKey('/f/100/a.jpg')).toBe('f/100/a.jpg');
    expect(safeMediaKey('../../etc/passwd')).toBeNull();
    expect(safeMediaKey('f/../a.jpg')).toBeNull();
    expect(safeMediaKey('f/100/a.jpg\\0.png')).toBeNull();
    expect(safeMediaKey('f/100/a.jsp')).toBe('f/100/a.jsp'); // key 本身合法
    expect(safeMediaKey('f/100/中文.jpg')).toBeNull();
    expect(safeMediaKey('%E0%A4%A')).toBeNull(); // 非法百分号编码
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 三、收单 / 回读端点
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-04 · 收单端点与回读端点', () => {
  const bytes = Buffer.from('fake-jpeg-bytes-0123456789', 'utf8');

  function handlers(now = NOW): MediaFileHandlers {
    return createMediaFileHandlers({
      storage: storageFor().storage,
      uploadSecret: SECRET,
      now: () => now,
    });
  }

  it('① 签名有效 → 200，字节真的落盘（multipart，模拟 Taro.uploadFile）', async () => {
    const h = handlers();
    const fileKey = 'f/200/1700000000-upload01.jpg';
    const exp = NOW + 900;
    const sig = signUploadParams({ fileKey, exp, secret: SECRET });
    const { body, contentType } = multipartBody(bytes);

    const res = await run(
      h.upload,
      fakeReq(
        `/media-files/upload?fileKey=${encodeURIComponent(fileKey)}&exp=${String(exp)}&sig=${sig}`,
        body,
        contentType,
      ),
      fakeRes(),
    );
    expect(res.statusCode).toBe(200);
    const payload = jsonOf(res);
    expect(payload.code).toBe(0);
    expect((payload.data as { byteSize: number }).byteSize).toBe(bytes.length);

    // 落盘校验（不是「返回 200 就算成功」）
    const onDisk = await fs.readFile(path.join(tmpRoot, fileKey));
    expect(onDisk.equals(bytes)).toBe(true);
  });

  it('② 签名无效 / 缺失 → 403，且不落盘', async () => {
    const h = handlers();
    const fileKey = 'f/200/forged.jpg';
    const { body, contentType } = multipartBody(bytes);

    const res = await run(
      h.upload,
      fakeReq(
        `/media-files/upload?fileKey=${encodeURIComponent(fileKey)}&exp=${String(NOW + 900)}&sig=deadbeef`,
        body,
        contentType,
      ),
      fakeRes(),
    );
    expect(res.statusCode).toBe(403);
    expect(jsonOf(res).message).toContain('签名无效');

    await expect(fs.access(path.join(tmpRoot, fileKey))).rejects.toThrow();
  });

  it('③ 回读：命中 → 200 + 正确 Content-Type + nosniff；不存在的 key 与可疑扩展名 → 404', async () => {
    const h = handlers();
    const fileKey = 'f/200/serve.jpg';
    await fs.mkdir(path.dirname(path.join(tmpRoot, fileKey)), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, fileKey), bytes);

    const ok = await run(h.read, fakeReq(`/media-files/${fileKey}`, null), fakeRes());
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.body.equals(bytes)).toBe(true);

    const missing = await run(h.read, fakeReq('/media-files/f/200/nope.jpg', null), fakeRes());
    expect(missing.statusCode).toBe(404);

    // 可疑扩展名不直出（防把 .html 当页面返回造成同域 XSS）
    const htmlKey = 'f/200/evil.html';
    await fs.writeFile(path.join(tmpRoot, htmlKey), Buffer.from('<script>alert(1)</script>'));
    const html = await run(h.read, fakeReq(`/media-files/${htmlKey}`, null), fakeRes());
    expect(html.statusCode).toBe(404);
  });

  it('④ 超过 50MB 上限 → 413（与库级 CHECK 同口径，避免「上传成功但 confirm 失败」）', async () => {
    // 构造一个超过上限的请求体需要真占内存，这里只断言上限常量与判定分支的一致性
    expect(MAX_UPLOAD_BYTES).toBe(52_428_800);
    const h2 = createMediaFileHandlers({
      storage: storageFor().storage,
      uploadSecret: SECRET,
      maxBytes: 8, // 把上限压到 8 字节，用同一段代码验 413 分支
      now: () => NOW,
    });
    const fileKey = 'f/200/toobig.jpg';
    const exp = NOW + 900;
    const sig = signUploadParams({ fileKey, exp, secret: SECRET });
    const { body, contentType } = multipartBody(Buffer.from('0123456789abcdef', 'utf8'));
    const res = await run(
      h2.upload,
      fakeReq(
        `/media-files/upload?fileKey=${encodeURIComponent(fileKey)}&exp=${String(exp)}&sig=${sig}`,
        body,
        contentType,
      ),
      fakeRes(),
    );
    expect(res.statusCode).toBe(413);
    expect(jsonOf(res).code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 四、端到端：presign → 上传 → 回读 → confirm → list.url
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-04 · 端到端上传闭环（派发单 §9 缺口）', () => {
  it('① 五步全通：presign 给真地址 → 上传落盘 → 回读字节一致 → confirm 落库 → list.url 可访问', async () => {
    const storage = storageFor();
    const app = appWith(storage);
    const s: Scaffold = await scaffold(app, 'media-e2e');
    const h = createMediaFileHandlers({
      storage: storage.storage,
      uploadSecret: storage.uploadSecret,
      now: () => NOW,
    });

    // 1) presign（走真实 8 段链）
    const presign = mustOk<{ uploadUrl: string; fileKey: string; expiresIn: number }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: s.token,
          body: {
            familyId: s.familyId,
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            byteSize: '20',
          },
        }),
      ),
    );
    // 不再是占位域名，而是自家收单端点，且带签名
    expect(presign.uploadUrl.startsWith(`${BASE}/upload?`)).toBe(true);
    expect(presign.uploadUrl).toContain('sig=');
    expect(presign.expiresIn).toBe(900);
    expect(presign.fileKey.startsWith(`f/${s.familyId}/`)).toBe(true);

    // 2) 上传（把 presign 的 URL 原样打给 handler）
    const bytes = Buffer.from('0123456789012345678', 'utf8'); // 19 字节
    const { body, contentType } = multipartBody(bytes);
    const uploadPath = presign.uploadUrl.slice(BASE.length);
    const up = await run(h.upload, fakeReq(uploadPath, body, contentType), fakeRes());
    expect(up.statusCode).toBe(200);

    // 3) 回读
    const read = await run(h.read, fakeReq(`/media-files/${presign.fileKey}`, null), fakeRes());
    expect(read.statusCode).toBe(200);
    expect(read.body.equals(bytes)).toBe(true);

    // 4) confirm 登记
    const asset = mustOk<{ asset: Record<string, unknown> }>(
      await app.dispatch(
        req('POST', '/media/confirm', {
          token: s.token,
          body: {
            familyId: s.familyId,
            fileKey: presign.fileKey,
            mimeType: 'image/jpeg',
            byteSize: String(bytes.length),
            compressed: true,
            exifStripped: true,
            hadGps: false,
            storageClass: 'STANDARD',
          },
        }),
      ),
    ).asset;
    expect(asset['fileKey']).toBe(presign.fileKey);

    // 5) list.url 指向上传基址，且该 URL 用回读 handler 能拿到字节
    const list = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/media', { token: s.token, query: { familyId: s.familyId } })),
    );
    const item = list.items.find((i) => i['fileKey'] === presign.fileKey);
    expect(item?.['url']).toBe(`${BASE}/${presign.fileKey}`);

    const relPath = String(item?.['url']).slice(BASE.length);
    const viaUrl = await run(h.read, fakeReq(`/media-files${relPath}`, null), fakeRes());
    expect(viaUrl.statusCode).toBe(200);
    expect(viaUrl.body.equals(bytes)).toBe(true);

    // 字节真的落在磁盘上（不是只写进了内存驱动）
    expect((await fs.stat(path.join(tmpRoot, presign.fileKey))).size).toBe(bytes.length);
  });

  it('② purpose=AVATAR → fileKey 走 a/<userId>/，与家庭照片分池', async () => {
    const app = appWith(storageFor());
    const s = await scaffold(app, 'media-avatar');

    const avatar = mustOk<{ fileKey: string }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: s.token,
          body: {
            familyId: s.familyId,
            purpose: 'AVATAR',
            fileName: 'me.jpg',
            mimeType: 'image/jpeg',
            byteSize: '10',
          },
        }),
      ),
    );
    expect(avatar.fileKey.startsWith(`a/${s.userId}/`)).toBe(true);

    // 不传 purpose → 默认 MEDIA，前缀不变（老客户端兼容）
    const photo = mustOk<{ fileKey: string }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: s.token,
          body: {
            familyId: s.familyId,
            fileName: 'trip.jpg',
            mimeType: 'image/jpeg',
            byteSize: '10',
          },
        }),
      ),
    );
    expect(photo.fileKey.startsWith(`f/${s.familyId}/`)).toBe(true);
  });

  it('③ filePending 的 purpose 落真实用途（此前硬编码 MEDIA）', async () => {
    const app = appWith(storageFor());
    const s = await scaffold(app, 'media-purpose');

    mustOk(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: s.token,
          body: {
            familyId: s.familyId,
            purpose: 'AVATAR',
            fileName: 'me2.jpg',
            mimeType: 'image/jpeg',
            byteSize: '10',
          },
        }),
      ),
    );
    const rows = dumpTable(app, 'filePending');
    expect(rows.some((r) => r['purpose'] === 'AVATAR')).toBe(true);
  });
});

/** 确保临时目录里的文件能被 fs 流读到（避免误用未使用的 import） */
void createReadStream;
