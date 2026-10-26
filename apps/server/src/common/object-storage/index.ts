/**
 * 媒体存储装配（唯一入口）
 * ============================================================================
 * 职责：按环境变量选出 driver，把「存储能力」和「对外基址」一次性交给组合根。
 *
 * 配置项（`.env.example` 有同款注释）：
 *   OBJECT_STORAGE_PROVIDER   local（默认，当前唯一实现）
 *   OBJECT_STORAGE_ROOT       落盘根目录，默认 `<cwd>/.media`
 *   MEDIA_PUBLIC_BASE_URL     对外媒体基址 = 回读前缀 = 收单端点的父路径
 *                             生产例：https://api.familytripallinone.cn/media-files
 *   MEDIA_UPLOAD_SECRET       上传位签名密钥（生产必须显式配置，openssl rand -hex 32）
 *   MEDIA_UPLOAD_TTL_SECONDS  上传位有效期，默认 900
 *
 * 🔴 三种环境三种处置（与 JWT / FX 那种「缺了就拒绝启动」不同，这里刻意降级）：
 *   · 开发未配密钥 → 用**进程内随机密钥** + 一次 warn。本地零配置可跑，
 *     重启后旧上传位失效无所谓（本来 15 分钟就过期）。
 *   · 生产配置齐全 → 正常 driver。
 *   · 生产缺配置/仍是占位域名 → 返回 `UnconfiguredStorage`：**服务照常启动**
 *     （不让一个功能缺配置把整个 API 拖死），但 `presign` 明确报 5008「媒体存储未配置」，
 *     而不是回一个假的 `https://upload.local/...` 让客户端「上传失败」查三天。
 */

import path from 'node:path';
import { AppError, ErrorCode } from '../errors/error-code.js';
import type { ObjectStorage } from './object-storage.js';
import {
  DEFAULT_UPLOAD_TTL_SECONDS,
  ephemeralUploadSecret,
  LocalDiskStorage,
} from './local-disk-storage.js';

export type { ObjectStorage, SignedUpload } from './object-storage.js';

export const MEDIA_FILES_SEGMENT = 'media-files';

export interface ResolvedMediaStorage {
  storage: ObjectStorage;
  /** 回读基址（media list 拼 url、itinerary image 块同源） */
  publicBaseUrl: string;
  /** 上传位签名密钥 —— 收单端点校验用，必须与签发侧同源 */
  uploadSecret: string;
  /** 是否需要挂载收单/回读路由（云存储直传时不需要） */
  mountRoutes: boolean;
  /** 配置问题清单（空 = 健康）；供启动日志与部署自检使用 */
  problems: string[];
}

/** 未配置时的占位实现：一切能力都明确报错，绝不返回假地址 */
class UnconfiguredStorage implements ObjectStorage {
  readonly kind = 'unconfigured';

  constructor(private readonly problems: readonly string[]) {}

  signUpload(): Promise<never> {
    return Promise.reject(
      new AppError(
        ErrorCode.MEDIA_STORAGE_UNCONFIGURED,
        `媒体存储未配置：${this.problems.join('；')}`,
      ),
    );
  }

  putObject(): Promise<never> {
    return Promise.reject(new AppError(ErrorCode.MEDIA_STORAGE_UNCONFIGURED, '媒体存储未配置'));
  }

  fetchObject(): Promise<never> {
    return Promise.reject(new AppError(ErrorCode.MEDIA_STORAGE_UNCONFIGURED, '媒体存储未配置'));
  }
}

let warnedEphemeral = false;

export interface ResolveMediaStorageOptions {
  /** 注入时钟（测试用，秒） */
  now?: () => number;
}

export function resolveMediaStorage(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveMediaStorageOptions = {},
): ResolvedMediaStorage {
  const provider = (env['OBJECT_STORAGE_PROVIDER'] ?? 'local').trim().toLowerCase();
  if (provider !== 'local') {
    // 明确「没写」比静默回落安全：写 cos 却跑本地磁盘会让数据分散在两处
    throw new Error(
      `OBJECT_STORAGE_PROVIDER=${provider} 尚未实现（当前只有 local）。` +
        '接入 COS/OSS/S3 需在 common/object-storage 新增 driver，见 docs/媒体存储接入.md §3。',
    );
  }

  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const isProd = nodeEnv === 'production';
  const port = env['PORT'] ?? '3000';

  const root = env['OBJECT_STORAGE_ROOT']?.trim() || path.resolve(process.cwd(), '.media');
  const ttlRaw = Number(env['MEDIA_UPLOAD_TTL_SECONDS'] ?? '');
  const ttlSeconds =
    Number.isFinite(ttlRaw) && ttlRaw >= 60 ? Math.floor(ttlRaw) : DEFAULT_UPLOAD_TTL_SECONDS;

  const publicBaseUrl = (
    env['MEDIA_PUBLIC_BASE_URL']?.trim() ||
    (isProd ? '' : `http://127.0.0.1:${port}/${MEDIA_FILES_SEGMENT}`)
  ).replace(/\/+$/, '');

  // 兼容「配成站点根 + 期望自动拼 media-files」的写法：只认显式配置，不做聪明猜测
  const problems: string[] = [];
  if (publicBaseUrl === '') {
    problems.push(`MEDIA_PUBLIC_BASE_URL 未配置（例：https://api.<域名>/${MEDIA_FILES_SEGMENT}）`);
  } else if (/\/\/(?:media|upload)\.local(?:[/:]|$)/.test(publicBaseUrl)) {
    // 占位域名能拼出「看起来正常」的 URL，但客户端必然打不开 —— 单独点出来
    problems.push(`MEDIA_PUBLIC_BASE_URL 仍是占位域名：${publicBaseUrl}`);
  }

  const configuredSecret = env['MEDIA_UPLOAD_SECRET']?.trim() ?? '';
  if (configuredSecret === '') {
    if (isProd) problems.push('MEDIA_UPLOAD_SECRET 未配置（生成：openssl rand -hex 32）');
  } else if (configuredSecret.length < 16) {
    problems.push('MEDIA_UPLOAD_SECRET 过短（至少 16 字符，建议 openssl rand -hex 32）');
  }

  if (problems.length > 0 && isProd) {
    return {
      storage: new UnconfiguredStorage(problems),
      publicBaseUrl: publicBaseUrl === '' ? `https://media.local` : publicBaseUrl,
      uploadSecret: '',
      mountRoutes: false,
      problems,
    };
  }

  let secret = configuredSecret;
  if (secret === '') {
    // 开发零配置：进程内随机密钥（重启失效，本来上传位 15 分钟就过期）
    secret = ephemeralUploadSecret();
    if (!warnedEphemeral) {
      warnedEphemeral = true;
      console.warn(
        '[family-trip] 媒体上传：未配置 MEDIA_UPLOAD_SECRET，已使用进程内随机密钥（仅开发；重启后旧上传位失效）',
      );
    }
  }

  return {
    storage: new LocalDiskStorage({
      root,
      publicBaseUrl,
      secret,
      ttlSeconds,
      ...(options.now !== undefined ? { now: options.now } : {}),
    }),
    publicBaseUrl,
    uploadSecret: secret,
    mountRoutes: true,
    problems,
  };
}
