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

/**
 * BigInt 安全的 JSON 序列化 replacer —— HTTP 响应出口的最后一道闸。
 * ============================================================================
 * 派发单 D-2026-10-15-02「P0-B · HTTP 边界 BigInt 兜底」的落地实现。
 *
 * 背景：各域用 `*_BIGINT_FIELDS` 白名单把 BigInt 列转字符串
 * （见 `domains/domain-context.ts` 的 `serializeRow`）。白名单一旦漏列，
 * 真 MySQL 下 `res.json()` 会抛 `TypeError: Do not know how to serialize a BigInt`
 * —— HTTP 500 且**响应不走信封**，客户端连错误码都解析不到。
 * 内存驱动（MemoryTableDriver）把 `version` 存为 JS number，永不触发该分支，
 * 所以这类缺陷只在真库上暴露（实证见派发单 §一）。
 *
 * 口径 —— 与内存驱动逐字对齐，故**不改任何接口契约**：
 *   - 落在 `Number` 安全整数范围内 → 输出 **number**。
 *     `version`（乐观锁版本号）即此类：内存驱动就是 number，客户端类型也是 number。
 *   - 超出安全整数范围 → 输出 **string**，不丢精度（雪花 id 等）。
 *
 * 🔴 白名单的职责因此收窄为「**标识类字段必须序列化为字符串**」
 *    （`id` / `familyId` / `tripId` … 客户端类型为 string）。
 *    非标识类 BigInt 列（`version` / `rateBy` / `mergedGroupId` …）**无需**进白名单，
 *    由本闸统一按 number 输出。反之，若把 `version` 加进白名单，真库会出 string
 *    而内存驱动出 number —— 那才是制造驱动间口径分叉。
 *
 * 为什么这是安全改动：当前代码下**任何**含 BigInt 的响应必然是 500，
 * 因此本闸只可能把「失败」变成「成功」，不存在行为回归。
 *
 * ⚠️ 但它**只是兜底**，不是白名单的替代品：标识类字段漏列仍会让 id 变成
 *    number（客户端 `asString()` 能归一化，但契约类型不准），需另行补齐。
 */
export function bigintSafeReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== 'bigint') return value;
  const asNumber = Number(value);
  return Number.isSafeInteger(asNumber) ? asNumber : value.toString();
}
