/**
 * M4 · 汇率口径统一
 * ---------------------------------------------------------------------------
 * 🔴 红线 R5：唯一口径 `rate_tier = 'SPOT_SELL'`（现汇卖出价）。
 *🔴 红线 R6：切档位默认**不重算历史**。
 * ⛔ 红线 R7：生产环境禁止抓取汇率。
 *
 * 为什么档位必须进缓存键：不填档位会跨档污染历史金额，G5 金额对账必然失败。
 * 例：同一 (JPY→CNY, 2026-05-01) 在 SPOT_SELL 档缓存了 0.0471，
 * 切到中间价档时不换键 → 读到 0.0471 → 但语义已错。
 */

/** ISO 4217 货币代码 */
export type CurrencyCode = string;

/**
 * 汇率档位。
 *
 * 本期唯一口径 = SPOT_SELL。其余档位**保留枚举但禁止启用**，
 * 便于将来接入授权源时扩展而不改调用方签名。
 */
export const RateTier = {
  /** 现汇卖出价 —— 本期唯一口径 */
  SpotSell: 'SPOT_SELL',
  /** 中间价 —— 技术方案 v1.2 表述，v1.4 起停用 */
  Mid: 'MIDDLE',
  /** 现钞买入价 —— 预留 */
  CashBuy: 'CASH_BUY',
} as const;

export type RateTierValue = (typeof RateTier)[keyof typeof RateTier];

/** 本期唯一允许的档位 */
export const ACTIVE_RATE_TIER: RateTierValue = RateTier.SpotSell;

/** 全部已知档位（用于入参校验） */
const ALL_TIERS = new Set<string>(Object.values(RateTier));

/** 归一化并校验档位入参。未传时填本期唯一口径。 */
export function resolveTier(tier?: string | null): RateTierValue {
  if (tier === undefined || tier === null || tier === '') return ACTIVE_RATE_TIER;
  const t = String(tier).toUpperCase();
  if (!ALL_TIERS.has(t)) {
    throw new Error(
      `未知汇率档位 "${tier}"。已知：${[...ALL_TIERS].join(' / ')}。` +
        '不填档位会跨档污染历史金额，必须显式传值。',
    );
  }
  if (t !== ACTIVE_RATE_TIER) {
    throw new Error(`档位 ${t} 本期未启用。唯一口径为 ${ACTIVE_RATE_TIER}（红线 R5）。`);
  }
  return t;
}

/**
 * 缓存键 —— **必须含档位段**（验收 6）。
 *
 * 格式：`fx:{base}:{quote}:{tier}:{date}`
 */
export function fxCacheKey(
  base: CurrencyCode,
  quote: CurrencyCode,
  tier: RateTierValue,
  date: string,
): string {
  if (!base || !quote) throw new Error('fxCacheKey: base / quote 不得为空');
  if (!isIsoDate(date)) throw new Error(`fxCacheKey: date 须为 YYYY-MM-DD 实际 ${date}`);
  return `fx:${base.toUpperCase()}:${quote.toUpperCase()}:${tier}:${date}`;
}

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 汇率方向：1 单位 base折合多少 quote（技术方案 §4.2.2「写死」） */
export interface FxRate {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** 1 base = rate quote */
  rate: string;
  rateDate: string;
  tier: RateTierValue;
  /** 取数时刻UTC(3) */
  rateTime: Date;
  /** 合规授权源标识；⛔ 不得为爬虫来源 */
  source: string;
}

/**
 * 合规授权源白名单。
 *
 * ⛔ 不硬编码、不写进仓库 —— 商务签约确定后由环境变量注入，
 * 凭证本身走 KMS / 环境变量，不入库（§5.2安全清单）。
 */
let authorizedSources: ReadonlySet<string> = new Set();

/** 环境变量名：逗号分隔的授权源名 */
export const AUTHORIZED_SOURCES_ENV = 'FX_AUTHORIZED_SOURCES';

/** 从环境变量装载白名单。应在启动早期调用一次。 */
export function loadAuthorizedSources(env: NodeJS.ProcessEnv = process.env): void {
  const raw = env[AUTHORIZED_SOURCES_ENV];
  authorizedSources = new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isAuthorizedSource(source: string): boolean {
  return authorizedSources.has(source);
}

export class FxSourceNotAuthorizedError extends Error {
  constructor(source: string) {
    super(
      `汇率源 "${source}" 非合规授权源。` +
        '⛔ 红线 R7：生产环境禁止抓取汇率（合规风险）。授权源接入前 M3 会阻断启动。',
    );
    this.name = 'FxSourceNotAuthorizedError';
  }
}

/** 校验取数来源合规；不合规直接抛错，任何环境都不放行 */
export function assertAuthorizedSource(source: string): void {
  if (!isAuthorizedSource(source)) throw new FxSourceNotAuthorizedError(source);
}
