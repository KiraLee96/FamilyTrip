/**
 * 统一错误码与响应信封
 * ---------------------------------------------------------------------------
 * 响应结构：`{ code: 0, message: 'ok', data: {...}, meta: {...} }`
 * 错误码：4xxxx 客户端错误，5xxxx 服务端错误
 *
 * 🔴 5005 TX_QUOTA_EXCEEDED：跨表事务超限。
 * 已退化为「单笔事务 + reconcile」，因此该错误码在服务侧可捕获并降级，
 * 但仍保留在码表里 —— 对客户端语义不变。
 */

export const ErrorCode = {
  OK: 0,

  // ── 4xxxx 客户端 ───────────────────────────────────────────
  BAD_REQUEST: 4000,
  VALIDATION_FAILED: 4001,
  UNAUTHORIZED: 4010,
  TOKEN_EXPIRED: 4011,
  FORBIDDEN: 4030,
  /** 越权与资源不存在**返回逐字节一致的 404，防 ID 枚举 */
  NOT_FOUND: 4040,
  /**
   * 邀请码无效或已失效（D-2026-10-26-01 P2-1）。
   *
   * 🔴 为什么这一格**允许**与 4040 区分（破例说明，勿随意扩展到别的资源）：
   *    4040 的「同形」是为了防 ID 枚举 —— 攻击者拿一串自增 ID 试探资源是否存在。
   *    邀请码是**用户输入的凭据**（8 位、31^8 空间），不构成枚举面；
   *    而它与「路径写错 / 家庭已解散」同形时，用户只会得到「资源不存在」这种
   *    无法行动的提示 —— 反馈里「邀请码分享之后无效」正是卡在这里。
   *    HTTP 仍是 404（不额外暴露资源存在性），只让客户端能按码给文案。
   */
  INVITE_CODE_INVALID: 4041,
  VERSION_CONFLICT: 4090,
  IDEMPOTENT_IN_PROGRESS: 4091,
  RATE_LIMITED: 4290,
  PAYLOAD_TOO_LARGE: 4130,

  // ── 5xxxx 服务端 ───────────────────────────────────────────
  INTERNAL_ERROR: 5000,
  CRYPTO_ERROR: 5001,
  DECRYPT_FORMAT_ERROR: 5002,
  DB_ERROR: 5003,
  /** 跨表事务超限，已退化为单笔事务 + reconcile */
  TX_QUOTA_EXCEEDED: 5005,
  FX_SOURCE_MISCONFIGURED: 5006,
  KMS_ERROR: 5007,
  /**
   * 媒体存储未配置（D-2026-10-26-04）。
   *
   * 为什么不复用 INTERNAL_ERROR：客户端把 5000 统一翻成「服务内部错误」，用户与
   * 前端都无从判断该找谁。这一格的 message 会明确写出缺哪个环境变量，
   * HTTP 给 503（能力暂时不可用），而不是 500（服务出错）。
   */
  MEDIA_STORAGE_UNCONFIGURED: 5008,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS: Record<number, number> = {
  [ErrorCode.OK]: 200,
  [ErrorCode.BAD_REQUEST]: 400,
  [ErrorCode.VALIDATION_FAILED]: 422,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.INVITE_CODE_INVALID]: 404,
  [ErrorCode.VERSION_CONFLICT]: 409,
  [ErrorCode.IDEMPOTENT_IN_PROGRESS]: 409,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.CRYPTO_ERROR]: 500,
  [ErrorCode.DECRYPT_FORMAT_ERROR]: 500,
  [ErrorCode.DB_ERROR]: 500,
  [ErrorCode.TX_QUOTA_EXCEEDED]: 500,
  [ErrorCode.FX_SOURCE_MISCONFIGURED]: 500,
  [ErrorCode.KMS_ERROR]: 500,
  // 能力暂时不可用（不是服务出错）：前端据此提示「联系管理员配置」而不是「稍后重试」
  [ErrorCode.MEDIA_STORAGE_UNCONFIGURED]: 503,
};

export function httpStatusOf(code: number): number {
  return HTTP_STATUS[code] ?? 500;
}

export class AppError extends Error {
  constructor(
    readonly code: ErrorCodeValue,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get httpStatus(): number {
    return httpStatusOf(this.code);
  }
}

export const badRequest = (msg: string, details?: unknown): AppError =>
  new AppError(ErrorCode.BAD_REQUEST, msg, details);
export const validationFailed = (details: unknown): AppError =>
  new AppError(ErrorCode.VALIDATION_FAILED, '参数校验失败', details);
export const unauthorized = (msg = '未登录或凭证失效'): AppError =>
  new AppError(ErrorCode.UNAUTHORIZED, msg);
export const forbidden = (msg = '无权访问'): AppError => new AppError(ErrorCode.FORBIDDEN, msg);
export const notFound = (): AppError => new AppError(ErrorCode.NOT_FOUND, '资源不存在');
export const versionConflict = (): AppError =>
  new AppError(ErrorCode.VERSION_CONFLICT, '内容已更新，请刷新');
export const decryptFormatError = (msg: string): AppError =>
  new AppError(ErrorCode.DECRYPT_FORMAT_ERROR, msg);

/**
 * 🔴 越权与资源不存在必须**逐字节一致**（TP-02C D8）。
 *
 * 客户端无法通过状态码 / body / 结构差异反推资源是否存在，
 * 从而阻断 ID 枚举。此函数是「404 的唯一出口」——
 * 权限层与数据层都调它，禁止各自手写404。
 */
export function notFoundIndistinguishable(): AppError {
  return new AppError(ErrorCode.NOT_FOUND, '资源不存在');
}

/**
 * 邀请码未命中 —— 与 4040 唯一允许「可区分」的 404。
 *
 * HTTP 状态仍是 404（不暴露资源存在性），但 `code = 4041` 让客户端能把提示
 * 从「资源不存在」改成「邀请码无效，请让家人重新发一次」（见上方码表注释）。
 */
export function inviteCodeInvalid(): AppError {
  return new AppError(ErrorCode.INVITE_CODE_INVALID, '邀请码无效或已失效');
}
