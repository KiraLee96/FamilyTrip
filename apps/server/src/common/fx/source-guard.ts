/**
 * M3 · 汇率源生产fail-fast
 * ---------------------------------------------------------------------------
 * 派发单 §3.2：**分支代码现在就合，不要等上线前。**
 *
 * ```js
 * if (process.env.NODE_ENV === 'production') {
 *   throw new Error('汇率源未配置为合规授权源，拒绝启动');
 * }
 * ```
 *
 * 现状：采购决策为本期不采购 → 分支先合，**实际生效待授权源接入**。
 * 🔴 硬约束：上线前必须完成授权源接入，否则本fail-fast 会阻断部署。
 */

import { isAuthorizedSource, type CurrencyCode } from './rate-tier.js';
import type { FxRate, RateTierValue } from './rate-tier.js';

/** 汇率源适配接口 —— 生产实现须为「合规授权源」客户端 */
export interface FxRateSource {
  name: string;
  /**
   * 拉取指定日期、指定档位的汇率。
   * ⛔ 实现不得使用网页抓取 / 爬虫。
   */
  fetchRate(args: {
    base: CurrencyCode;
    quote: CurrencyCode;
    tier: RateTierValue;
    date: string;
  }): Promise<FxRate>;
}

export interface FxSourceConfig {
  /** 环境名 */
  nodeEnv: string;
  /** 已配置的源（注入的实例） */
  sources: FxRateSource[];
  /** 显式启用的源名；未配置时由 sources[0] 推导 */
  activeSourceName?: string;
}

export class FxSourceMisconfiguredError extends Error {
  constructor(detail: string) {
    super(`汇率源未配置为合规授权源，拒绝启动：${detail}`);
    this.name = 'FxSourceMisconfiguredError';
  }
}

export const PRODUCTION = 'production';

/**
 * 启动期fail-fast。**必须在进程启动时调用**（main.ts / NestJS onModuleInit）。
 *
 * @throws FxSourceMisconfiguredError —— 仅当 NODE_ENV=production 且无合规源
 */
export function assertFxSourceConfigured(config: FxSourceConfig): FxRateSource {
  const candidates = config.sources.filter((s) => isAuthorizedSource(s.name));
  const active = config.activeSourceName
    ? candidates.find((s) => s.name === config.activeSourceName)
    : candidates[0];

  if (active) return active;

  // 非生产：告警但不阻断开发自测
  if (config.nodeEnv !== PRODUCTION) {
    return config.sources[0] ?? devFallbackSource();
  }

  const detail =
    candidates.length === 0 && config.sources.length > 0
      ? `已注入 ${config.sources.length} 个源但均不在授权白名单（${config.sources
          .map((s) => s.name)
          .join(', ')}）`
      : config.sources.length === 0
        ? '未注入任何汇率源'
        : `启用的源 "${config.activeSourceName}" 不在授权白名单`;

  throw new FxSourceMisconfiguredError(detail);
}

/**
 * 开发态占位源。
 * ⛔ 恒定以非授权源身份出现 —— 这样即使误配到生产也会被上面的白名单拦下。
 */
function devFallbackSource(): FxRateSource {
  return {
    name: 'DEV_PLACEHOLDER',
    fetchRate(): Promise<FxRate> {
      throw new FxSourceMisconfiguredError('开发态占位源不可用于真实取数，请注入合规授权源');
    },
  };
}

/**
 * 已授权源白名单的注入口 —— 契约占位提醒。
 * 实际通过 loadAuthorizedSources() 从环境变量装载，此处不提供写死路径。
 */
export function assertAuthorizedSourceConfigured(): void {
  throw new Error(
    '授权源登记走 loadAuthorizedSources()（读FX_AUTHORIZED_SOURCES 环境变量），' +
      '不在代码中硬编码源名。授权凭证走环境变量 / KMS，不入库。',
  );
}
