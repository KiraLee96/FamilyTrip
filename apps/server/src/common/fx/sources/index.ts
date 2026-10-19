/**
 * 汇率源装配入口
 * ============================================================================
 * 只做一件事：按环境决定「要不要注入公开源」。
 *
 * 🔴 生产恒返回 undefined —— 不是漏写，是刻意让 `assertFxSourceConfigured()`
 *    的 fail-fast 接管（M3 派发单 §3.2）。生产要接授权源，请在这里加分支，
 *    而不是放宽本函数的返回条件。
 */

import type { FxRateSource } from '../source-guard.js';
import { PUBLIC_RATE_SOURCE_NAME, PublicRateSource } from './public-rate-source.js';
import { ManualRateSource } from './manual-rate-source.js';

export { PUBLIC_RATE_SOURCE_NAME, PublicRateSource } from './public-rate-source.js';
export type { PublicRateProvider, PublicRateSourceOptions } from './public-rate-source.js';
export { MANUAL_RATE_SOURCE_NAME, ManualRateSource } from './manual-rate-source.js';

/** 环境变量：置 '0' 可显式关掉公开源（例如本地想验证「汇率缺失」分支） */
export const PUBLIC_FX_DISABLED_ENV = 'FX_PUBLIC_SOURCE_DISABLED';
/** 环境变量：覆盖源标识（须同步写入 FX_AUTHORIZED_SOURCES） */
export const PUBLIC_FX_NAME_ENV = 'FX_PUBLIC_SOURCE_NAME';

export interface ResolveFxSourceOptions {
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
  /** 注入时钟（测试用） */
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * 开发 / 测试环境的公开源；生产恒为 undefined。
 *
 * @returns 可注入 `buildApp({ fxSource })` / `installFxSource()` 的实例
 */
export function resolvePublicFxSource(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveFxSourceOptions = {},
): FxRateSource | undefined {
  // 生产绝不注入（红线 R7）
  if ((env['NODE_ENV'] ?? 'development') === 'production') return undefined;
  if (env[PUBLIC_FX_DISABLED_ENV] === '0') return undefined;

  const name = env[PUBLIC_FX_NAME_ENV]?.trim() ?? PUBLIC_RATE_SOURCE_NAME;
  return new PublicRateSource({
    name: name === '' ? PUBLIC_RATE_SOURCE_NAME : name,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/**
 * 汇率源策略总入口（main.ts 唯一调用点）。
 *
 * 三期路线：
 *   开发/预览  → PublicRateSource（中间价，仅本地/预览，生产恒 undefined）
 *   生产初期  → ManualRateSource（银行牌价人工录入，0 采购成本，口径正确）
 *   规模化后  → 在此处加签约 API 分支（实现同一接口，域代码零改动）
 *
 * ⚠️ 生产返回 ManualRateSource **不等于**闸门放行：它的名字仍须显式出现在
 *    FX_AUTHORIZED_SOURCES 里，否则 assertFxSourceConfigured 照常拒绝启动
 *    —— 「启用人工录入路径」必须是一次显式的运维决策，不能默认发生。
 */
export function resolveFxSource(
  env: NodeJS.ProcessEnv = process.env,
  options: ResolveFxSourceOptions = {},
): FxRateSource | undefined {
  const pub = resolvePublicFxSource(env, options);
  if (pub !== undefined) return pub;
  if ((env['NODE_ENV'] ?? 'development') === 'production') {
    return new ManualRateSource();
  }
  return undefined;
}
