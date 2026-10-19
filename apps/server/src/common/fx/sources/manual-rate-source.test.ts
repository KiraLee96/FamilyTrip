/**
 * ManualRateSource 单测 —— 人工录入汇率源（上线初期生产路径）
 *
 * 覆盖：恒抛 5006 + 录入指引、源名契约、resolveFxSource 三期分流
 *      （开发→公开源 / 生产→人工源）、M3 闸门集成（白名单显式声明才放行）。
 */
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '../../errors/error-code.js';
import { isAuthorizedSource, loadAuthorizedSources } from '../rate-tier.js';
import {
  assertFxSourceConfigured,
  FxSourceMisconfiguredError,
  PRODUCTION,
} from '../source-guard.js';
import {
  MANUAL_RATE_SOURCE_NAME,
  ManualRateSource,
  PUBLIC_RATE_SOURCE_NAME,
  resolveFxSource,
} from './index.js';

/** 捕获错误而非 rejects —— 与 fx.test.ts 同模式，避免未处理 rejection 泄漏 */
async function grabError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('预期抛错但未抛出');
}

describe('ManualRateSource · 恒抛 5006 + 录入指引', () => {
  const src = new ManualRateSource();

  it('fetchRate 抛 AppError(5006)，消息含币种对/日期/录入路径', async () => {
    const e = await grabError(() =>
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: 'SPOT_SELL', date: '2026-10-19' }),
    );
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(ErrorCode.FX_SOURCE_MISCONFIGURED);
    const msg = (e as AppError).message;
    expect(msg).toContain('CNY→JPY');
    expect(msg).toContain('2026-10-19');
    expect(msg).toContain('现汇卖出价');
    expect(msg).toContain('POST /fx/rates');
    expect(msg).toContain(MANUAL_RATE_SOURCE_NAME);
  });

  it('5006 让前端走「暂无汇率」分支而非「出错了」（与 useFxRate.missing 契约对齐）', async () => {
    const e = (await grabError(() =>
      src.fetchRate({ base: 'CNY', quote: 'USD', tier: 'SPOT_SELL', date: '2026-10-19' }),
    )) as AppError;
    expect(String(e.code)).toBe('5006');
  });

  it('源名默认 MANUAL_RATE_ENTRY；构造参数可覆盖（须同步白名单）', () => {
    expect(new ManualRateSource().name).toBe(MANUAL_RATE_SOURCE_NAME);
    expect(new ManualRateSource('BOC_TABLE').name).toBe('BOC_TABLE');
  });
});

describe('resolveFxSource · 三期分流', () => {
  const fetchImpl = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ result: 'success', rates: { JPY: 20.85 } }),
  })) as unknown as typeof fetch;

  it('开发/测试环境 → 公开源（PUBLIC_RATE_DEV）', () => {
    const s = resolveFxSource({}, { fetchImpl });
    expect(s?.name).toBe(PUBLIC_RATE_SOURCE_NAME);
  });

  it('生产环境 → 人工录入源（公开源恒被挡，红线 R7）', () => {
    const s = resolveFxSource({ NODE_ENV: 'production' }, { fetchImpl });
    expect(s).toBeInstanceOf(ManualRateSource);
    expect(s?.name).toBe(MANUAL_RATE_SOURCE_NAME);
  });

  it('生产环境即使显式开启公开源开关也拿不到公开源', () => {
    // resolvePublicFxSource 的生产判定先于 DISABLED 判定，公开源零生产暴露
    const s = resolveFxSource({ NODE_ENV: 'production' }, { fetchImpl });
    expect(s?.name).not.toBe(PUBLIC_RATE_SOURCE_NAME);
  });
});

describe('M3 闸门集成 · 人工路径必须显式声明才放行', () => {
  const manual = new ManualRateSource();

  it('生产 + 白名单含 MANUAL_RATE_ENTRY → 放行并返回该源', () => {
    loadAuthorizedSources({ FX_AUTHORIZED_SOURCES: 'X,MANUAL_RATE_ENTRY' });
    const active = assertFxSourceConfigured({ nodeEnv: PRODUCTION, sources: [manual] });
    expect(active.name).toBe(MANUAL_RATE_SOURCE_NAME);
    expect(isAuthorizedSource(MANUAL_RATE_SOURCE_NAME)).toBe(true);
  });

  it('生产 + 白名单为空 → 拒绝启动（启用人工路径必须是显式决策）', () => {
    loadAuthorizedSources({});
    expect(() => assertFxSourceConfigured({ nodeEnv: PRODUCTION, sources: [manual] })).toThrow(
      FxSourceMisconfiguredError,
    );
  });

  it('生产 + 白名单是别的源名 → 拒绝启动（源不在授权范围）', () => {
    loadAuthorizedSources({ FX_AUTHORIZED_SOURCES: 'OTHER_SOURCE' });
    expect(() => assertFxSourceConfigured({ nodeEnv: PRODUCTION, sources: [manual] })).toThrow(
      /非合规授权源|不在授权白名单|未注入/,
    );
  });
});
