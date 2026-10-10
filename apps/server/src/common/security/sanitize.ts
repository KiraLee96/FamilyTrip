/**
 * T-4 · 敏感数据旁路泄漏：四路脱敏（技术方案修订 · 第二评审 N 系列）
 * ============================================================================
 * 「四路」指敏感字段可能泄漏的四个旁路：
 *   ① 日志（stdout / 文件 / 日志采集）
 *   ② 错误上报（Sentry / 自建上报 / 异常堆栈）
 *   ③ 埋点（analytics event properties）
 *   ④ 网关（Nginx / API 网关访问日志的 query 与 body 片段）
 *
 * 泄漏的共同形态：把**整个请求/响应对象**丢进日志或上报。
 * 处置：所有出站序列化统一经 `sanitize()` —— 一处收敛，四路共用。
 *
 * 🔴 硬约束（TP-03 的 V5 扫描据此判定 0 命中）：
 *   · 加密列（*_enc / *_blind）永不外传，任何形态（Buffer/base64/hex）
 *   · 私有字段（order_no / order_link / contact）仅在解密且鉴权通过后返回，
 *     且**不得**进入日志/埋点
 *   · 敏感键名（password / token / openid / unionid / phone / idCard 等）一律掩码
 *   · 异常堆栈不得包含请求体
 */

/** 掩码字符 */
const MASK = '***';

/**
 * 敏感键名表（大小写不敏感，支持后缀匹配）。
 *
 * ⚠️ 采用「后缀匹配」而非「全等匹配」：
 *   `userPhone`、`member_phone`、`contactPhone` 都应命中 `phone`。
 *   全等匹配会漏掉大量变体 —— 这是历史上最常见的脱敏漏网点。
 */
const SENSITIVE_KEY_SUFFIXES = [
  // 凭证类
  'password',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'privatekey',
  'signature',
  // 标识类（PIPL 个人信息）
  'openid',
  'unionid',
  'idcard',
  'idnumber',
  'phone',
  'mobile',
  'email',
  // 加密列（永不外传）
  'enc',
  'blind',
  // M1 · 订单与联系人（敏感业务字段）
  'orderno',
  'orderlink',
  'contact',
  'realname',
] as const;

/** 精确匹配的高危键（不做后缀，避免误伤如 `encounter`） */
const SENSITIVE_EXACT_KEYS = new Set(['enc', 'blind', 'token', 'secret']);

/** 判断键名是否敏感 */
export function isSensitiveKey(key: string): boolean {
  const k = key.replace(/[_-]/g, '').toLowerCase();

  // 精确表优先（防 `enc` 后缀误伤 `encounter`）
  if (SENSITIVE_EXACT_KEYS.has(k)) return true;

  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (suffix === 'enc' || suffix === 'blind') {
      // 这两个只做「词边界」匹配：`order_no_enc` / `orderNoEnc` 命中，
      // `encounter` / `blinder` 不命中
      if (k.endsWith(suffix) && k.length > suffix.length) return true;
      continue;
    }
    if (k.endsWith(suffix)) return true;
  }
  return false;
}

/** 深拷贝 + 脱敏（不修改入参） */
export function sanitize<T>(value: T, depth = 0): unknown {
  // 防循环引用与超深嵌套（避免日志本身拖垮进程）
  if (depth > 12) return '[MaxDepth]';

  if (value === null || value === undefined) return value;

  // 二进制：加密列的真实形态 —— 绝不回显内容
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[Binary ${(value as Uint8Array).length}B]`;
  }

  if (Array.isArray(value)) {
    return value.map((v) => sanitize(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = MASK;
        continue;
      }
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }

  return value;
}

/**
 * ① 日志脱敏 —— 日志器出站前统一调用。
 */
export function sanitizeForLog(value: unknown): unknown {
  return sanitize(value);
}

/**
 * ② 错误上报脱敏 —— **额外剔除堆栈中的请求体**。
 *
 * 堆栈本身保留（排障需要），但去掉 message 里可能裹带的请求体。
 */
export interface ReportableError {
  name: string;
  message: string;
  code?: number | string;
  stack?: string;
  details?: unknown;
}

export function sanitizeForReport(err: unknown): ReportableError {
  if (!(err instanceof Error)) {
    return { name: 'UnknownError', message: String(err) };
  }
  const anyErr = err as Error & { code?: number | string; details?: unknown };
  const out: ReportableError = {
    name: err.name,
    // message 可能被上层拼接了原始入参；只截断长度 + 掩码
    message: redactInlineSecrets(err.message),
    stack: err.stack ? redactInlineSecrets(err.stack) : undefined,
  };
  if (anyErr.code !== undefined) out.code = anyErr.code;
  if (anyErr.details !== undefined) out.details = sanitize(anyErr.details);
  return out;
}

/**
 * ③ 埋点脱敏 —— 事件属性只允许白名单键。
 *
 * 埋点最容易泄漏：产品同学习惯把整个实体丢进 properties。
 * 故这里用**白名单**（而不是黑名单）：未登记键一律丢弃。
 */
const ANALYTICS_ALLOWED_KEYS = new Set([
  'event',
  'page',
  'action',
  'result',
  'durationMs',
  'count',
  'entityType',
  'status',
  'code',
  'platform',
  'version',
  'traceId',
]);

export function sanitizeForAnalytics(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(properties)) {
    if (!ANALYTICS_ALLOWED_KEYS.has(k)) continue;
    // 白名单键也可能被塞对象 —— 仍走一层 sanitize
    out[k] = typeof v === 'object' && v !== null ? sanitize(v) : v;
  }
  return out;
}

/**
 * ④ 网关脱敏 —— URL query 与 body 摘要。
 */
export function sanitizeQuery(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    out[k] = isSensitiveKey(k) ? MASK : v;
  }
  return out;
}

/** 请求摘要（网关/审计用）—— 只保留方法、路径、query 脱敏结果 */
export function requestDigest(req: {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  userId?: bigint | null;
}): Record<string, unknown> {
  return {
    method: req.method,
    path: req.path,
    query: req.query ? sanitizeQuery(req.query) : undefined,
    userId: req.userId === null || req.userId === undefined ? undefined : req.userId.toString(),
  };
}

/**
 * 内联脱敏 —— 处理「敏感值被拼进字符串」的情况。
 *
 * 例：`throw new Error(\`用户 ${phone} 不存在\`)` —— 键名级脱敏抓不到，
 * 必须在这里按**值形态**兜底：
 *   · 11 位手机号 → 139****8888
 *   · openid（27–28 位 base64url 风格）→ 前 6 位 + ***
 *   · 长 hex/base64 串（≥32 位连续）→ [REDACTED]
 */
export function redactInlineSecrets(text: string): string {
  let out = text;

  // 中国大陆手机号
  out = out.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2');

  // 身份证（18 位）
  out = out.replace(/\b(\d{6})\d{8}(\d{3}[\dXx])\b/g, '$1********$2');

  // 邮箱
  out = out.replace(/\b([\w.+-]{1,3})[\w.+-]*(@[\w.-]+\.\w+)\b/g, '$1***$2');

  // openid / unionid：以 o 开头、长度 27–28 的 base64url
  out = out.replace(/\b(o[A-Za-z0-9_-]{24,30})\b/g, (m) => `${m.slice(0, 6)}***`);

  // 长 hex / base64（密文、密钥、签名）
  out = out.replace(/\b[A-Fa-f0-9]{32,}\b/g, '[REDACTED]');
  out = out.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[REDACTED]');

  return out;
}

/**
 * 断言「一段文本里不含明文敏感值」—— 供 V5 四路泄漏扫描的单测使用。
 *
 * @throws 命中即抛 —— 让 CI 红，而不是打个日志继续
 */
export function assertNoPlaintextSecrets(
  text: string,
  forbidden: readonly string[],
  channel: 'log' | 'report' | 'analytics' | 'gateway',
): void {
  for (const secret of forbidden) {
    if (secret.length === 0) continue;
    if (text.includes(secret)) {
      throw new Error(
        `V5 泄漏扫描失败[${channel}]：输出文本命中禁止的明文值（长度 ${secret.length}）。` +
          '四路脱敏必须覆盖全部出站路径。',
      );
    }
  }
}
