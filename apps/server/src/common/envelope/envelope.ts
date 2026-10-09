/**
 * 统一响应信封 `responseEnvelope`（链路第 8 段）
 * ---------------------------------------------------------------------------
 * `{ code: 0, message: 'ok', data: {...}, meta: {...} }`
 *
 * 写接口必须带 `meta.updatedAt` + `meta.serverTime`（取自 DB 时间），
 * 客户端据此判断同步状态。⛔ 禁止用应用服务器 `new Date()` 充当 serverTime。
 */

import { ErrorCode, type ErrorCodeValue } from '../errors/error-code.js';

export interface ResponseMeta {
  /** 记录更新时间（写接口必带） */
  updatedAt?: string;
  /** DB 当前时间，ISO 8601 带 Z */
  serverTime?: string;
  /** 分页信息 */
  page?: number;
  pageSize?: number;
  total?: number;
  /** 增量同步游标（服务端签发的不透明串，客户端只回传不解析） */
  cursor?: string;
  [k: string]: unknown;
}

export interface Envelope<T> {
  code: ErrorCodeValue | 0;
  message: string;
  data: T | null;
  meta?: ResponseMeta;
}

export function ok<T>(data: T, meta?: ResponseMeta): Envelope<T> {
  return meta === undefined
    ? { code: ErrorCode.OK, message: 'ok', data }
    : { code: ErrorCode.OK, message: 'ok', data, meta };
}

export function fail(code: ErrorCodeValue, message: string, meta?: ResponseMeta): Envelope<never> {
  return meta === undefined ? { code, message, data: null } : { code, message, data: null, meta };
}

/** 无内容（204 语义，但统一走信封以便客户端统一处理） */
export function noContent(meta?: ResponseMeta): Envelope<null> {
  return meta === undefined
    ? { code: ErrorCode.OK, message: 'ok', data: null }
    : { code: ErrorCode.OK, message: 'ok', data: null, meta };
}

/** DB 时间 → ISO 8601 带 Z。传 null 表示「取不到 DB 时间」，此时不编造 */
export function dbTimeToIso(t: Date | null): string | undefined {
  return t === null ? undefined : t.toISOString();
}
