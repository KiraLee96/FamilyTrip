/**
 * M3/M4 验收口径 4/5/6 —— 派发单 §六
 *   4  M3 生产 fail-fast：NODE_ENV=production + 未配授权源 → 启动失败
 *   5  M4 切档位不污染历史：切 rate_tier 后历史金额不变
 *   6  M4 缓存键含档位：键名含tier 段
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ACTIVE_RATE_TIER,
  AUTHORIZED_SOURCES_ENV,
  RateTier,
  assertAuthorizedSource,
  fxCacheKey,
  isAuthorizedSource,
  loadAuthorizedSources,
  resolveTier,
} from './rate-tier.js';
import {
  FxSourceMisconfiguredError,
  PRODUCTION,
  assertFxSourceConfigured,
  type FxRateSource,
} from './source-guard.js';
import { FxService, RATE_SERIES_VERSION, type KvCache, type RateSnapshot } from './fx.service.js';
import { convertToBase, fromMinorUnits, sumMinorUnits, toMinorUnits } from './amount.js';
import type { FxRate } from './rate-tier.js';

function makeSource(name: string, rate = '0.0471'): FxRateSource {
  return {
    name,
    async fetchRate({ base, quote, tier, date }): Promise<FxRate> {
      return {
        base,
        quote,
        rate,
        rateDate: date,
        tier,
        rateTime: new Date('2026-05-01T00:00:00Z'),
        source: name,
      };
    },
  };
}

/** 测试用 Map 缓存 */
class MapCache implements KvCache {
  readonly rows = new Map<string, string | null | object>();
  readonly keys: string[] = [];

  async get(key: string): Promise<string | null | object> {
    return this.rows.get(key) ?? null;
  }
  async set(key: string, value: unknown): Promise<void> {
    this.keys.push(key);
    this.rows.set(key, value as string | null | object);
  }
}

/** 捕获错误而非用 rejects —— 避免未处理的 rejection 泄漏到 runner */
async function grabError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('预期抛错但未抛出');
}

beforeEach(() => {
  loadAuthorizedSources({});
});

describe('验收 4 · M3 生产 fail-fast', () => {
  it('NODE_ENV=production + 未配授权源 → 启动失败', () => {
    expect(() =>
      assertFxSourceConfigured({ nodeEnv: PRODUCTION, sources: [makeSource('SCRAPER')] }),
    ).toThrow(FxSourceMisconfiguredError);
  });

  it('生产环境一个源都没注入 → 启动失败', () => {
    expect(() => assertFxSourceConfigured({ nodeEnv: PRODUCTION, sources: [] })).toThrow(
      /未注入任何汇率源/,
    );
  });

  it('非生产环境未配源 → 放行（开发自测不被阻断）', () => {
    const src = assertFxSourceConfigured({ nodeEnv: 'development', sources: [] });
    expect(src.name).toBe('DEV_PLACEHOLDER');
  });

  it('生产环境配了授权源 → 放行并返回该源', () => {
    loadAuthorizedSources({ [AUTHORIZED_SOURCES_ENV]: 'LICENSED_CNY_BANK' });
    expect(isAuthorizedSource('LICENSED_CNY_BANK')).toBe(true);
    const src = assertFxSourceConfigured({
      nodeEnv: PRODUCTION,
      sources: [makeSource('SCRAPER'), makeSource('LICENSED_CNY_BANK')],
    });
    expect(src.name).toBe('LICENSED_CNY_BANK'); // 跳过未授权源
  });

  it('⛔ 爬虫源在任何环境都不得被当作合法源使用', () => {
    loadAuthorizedSources({});
    expect(isAuthorizedSource('SCRAPER')).toBe(false);
    expect(() => assertAuthorizedSource('SCRAPER')).toThrow(/非合规授权源/);
  });

  it('开发态占位源恒为非授权 —— 误配到生产也会被拦', () => {
    const ph = assertFxSourceConfigured({ nodeEnv: 'development', sources: [] });
    expect(isAuthorizedSource(ph.name)).toBe(false);
  });
});

describe('验收 6 · M4 缓存键含档位', () => {
  it('键名格式为 fx:{base}:{quote}:{tier}:{date}', () => {
    expect(fxCacheKey('jpy', 'cny', 'SPOT_SELL', '2026-05-01')).toBe(
      'fx:JPY:CNY:SPOT_SELL:2026-05-01',
    );
  });

  it('档位是键的一部分 —— 切档位即换键，不会读到旧档数据', () => {
    const a = fxCacheKey('JPY', 'CNY', 'SPOT_SELL', '2026-05-01');
    const b = fxCacheKey('JPY', 'CNY', 'MIDDLE', '2026-05-01');
    expect(a).not.toBe(b);
  });

  it('日期格式非法即拒', () => {
    expect(() => fxCacheKey('JPY', 'CNY', 'SPOT_SELL', '2026/05/01')).toThrow(/YYYY-MM-DD/);
  });

  it('回源后写入的键确实含 tier 段', async () => {
    loadAuthorizedSources({ [AUTHORIZED_SOURCES_ENV]: 'LICENSED' });
    const cache = new MapCache();
    const svc = new FxService(makeSource('LICENSED'), cache);
    await svc.getRate({ base: 'CNY', quote: 'JPY', date: '2026-05-01' });
    expect(cache.keys[0]).toBe('fx:CNY:JPY:SPOT_SELL:2026-05-01');
    expect(cache.keys[0]).toContain(ACTIVE_RATE_TIER);
  });
});

describe('M4 唯一口径 = SPOT_SELL', () => {
  it('未传档位时填唯一口径', () => {
    expect(resolveTier()).toBe(RateTier.SpotSell);
    expect(resolveTier(null)).toBe(RateTier.SpotSell);
  });

  it('显式传本期口径即通过', () => {
    expect(resolveTier('SPOT_SELL')).toBe('SPOT_SELL');
    expect(resolveTier('spot_sell')).toBe('SPOT_SELL'); // 大小写容错
  });

  it('非本期口径一律拒绝（防止跨档污染）', () => {
    expect(() => resolveTier('MIDDLE')).toThrow(/唯一口径/);
    expect(() => resolveTier('CASH_BUY')).toThrow(/唯一口径/);
    expect(() => resolveTier('SOMETHING')).toThrow(/未知汇率档位/);
  });
});

describe('金额精度（最小单位整数，禁止裸 Number）', () => {
  it('按币种 minor_unit 落整数', () => {
    expect(toMinorUnits('12.34', 'CNY')).toBe(1234n);
    expect(toMinorUnits('1200', 'JPY')).toBe(1200n); // JPY 零小数
    expect(toMinorUnits('1.234', 'BHD')).toBe(1234n); // BHD 三小数
  });

  it('展示时还原币种精度', () => {
    expect(fromMinorUnits(1234n, 'CNY')).toBe('12.34');
    expect(fromMinorUnits(1200n, 'JPY')).toBe('1200');
  });

  it('未知币种直接抛错 —— 不按默认 2 位猜测', () => {
    expect(() => toMinorUnits('1', 'XYZ')).toThrow(/未知币种/);
  });

  it('折算方向：1 base = rate quote，则 quote 金额 ÷ rate = base 金额', () => {
    // 1 CNY = 20 JPY → 1000 JPY = 50 CNY
    expect(convertToBase('1000', '20', 'CNY')).toBe(5000n);
  });

  it('汇总只加整数，无二次舍入', () => {
    expect(sumMinorUnits([1234n, 5678n, 100n])).toBe(7012n);
  });

  it('非法汇率抛错', () => {
    expect(() => convertToBase('100', '0', 'CNY')).toThrow(/汇率非法/);
    expect(() => convertToBase('100', '-1', 'CNY')).toThrow(/汇率非法/);
  });
});

describe('验收 5 · M4 切档位不污染历史', () => {
  const snapshot = (): RateSnapshot => ({
    currency: 'JPY',
    amount: 100000n,
    exchangeRate: '20',
    amountBase: 5000n, // 1000 JPY = 50.00 CNY
    rateDate: '2026-05-01',
    tier: 'SPOT_SELL',
    rateTime: new Date('2026-05-01T00:00:00Z'),
    rateSource: 'AUTO',
    rateBy: null,
  });

  it('默认切档位：历史金额完全不变', async () => {
    loadAuthorizedSources({ [AUTHORIZED_SOURCES_ENV]: 'LICENSED' });
    const svc = new FxService(makeSource('LICENSED', '21'), new MapCache());
    const before = snapshot();

    const { recomputed, report } = await svc.recomputeHistory({
      snapshots: [before],
      baseCurrency: 'CNY',
      newTier: RateTier.Mid,
    });

    expect(recomputed[0]!.amountBase).toBe(before.amountBase);
    expect(recomputed[0]!.tier).toBe(before.tier);
    expect(report.changed).toBe(0);
    expect(report.from).toBe(report.to);
  });

  it('未走版本通道 + 对账报告时，重算被拒绝', async () => {
    const svc = new FxService(makeSource('LICENSED'), new MapCache());
    const err = await grabError(() =>
      svc.recomputeHistory({
        snapshots: [snapshot()],
        baseCurrency: 'CNY',
        newTier: RateTier.Mid,
        allowRecomputeHistory: true,
      }),
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/拒绝重算历史/);
  });

  it('即便强行重算，非本期档位仍被口径校验拦下', async () => {
    const svc = new FxService(makeSource('LICENSED'), new MapCache());
    const err = await grabError(() =>
      svc.recomputeHistory({
        snapshots: [snapshot()],
        baseCurrency: 'CNY',
        newTier: RateTier.Mid,
        allowRecomputeHistory: true,
        versionChannel: RATE_SERIES_VERSION + 1,
        reconciliationReportId: 'REC-001',
      }),
    );
    expect((err as Error).message).toMatch(/唯一口径/);
  });

  it('待补汇率记录在重算中保持 null，不被猜补', async () => {
    const svc = new FxService(makeSource('LICENSED'), new MapCache());
    const pending: RateSnapshot = { ...snapshot(), amountBase: null, exchangeRate: '' };
    const { recomputed } = await svc.recomputeHistory({
      snapshots: [pending],
      baseCurrency: 'CNY',
      newTier: RateTier.SpotSell,
    });
    expect(recomputed[0]!.amountBase).toBeNull();
  });
});

describe('逐笔快照固化', () => {
  it('AUTO：按当日汇率折算并固化 amount_base', async () => {
    loadAuthorizedSources({ [AUTHORIZED_SOURCES_ENV]: 'LICENSED' });
    const svc = new FxService(makeSource('LICENSED', '20'), new MapCache());
    const snap = await svc.snapshotAmount({
      currency: 'JPY',
      baseCurrency: 'CNY',
      amount: '1000',
      date: '2026-05-01',
    });
    expect(snap.amountBase).toBe(5000n);
    expect(snap.rateSource).toBe('AUTO');
    expect(snap.tier).toBe('SPOT_SELL');
  });

  it('MANUAL：手动覆盖汇率即成新快照，且必须带操作人', async () => {
    const svc = new FxService(makeSource('LICENSED'), new MapCache());
    const snap = await svc.snapshotAmount({
      currency: 'JPY',
      baseCurrency: 'CNY',
      amount: '1000',
      manualRate: '20',
      manualRateBy: 888n,
      date: '2026-05-01',
    });
    expect(snap.rateSource).toBe('MANUAL');
    expect(snap.rateBy).toBe(888n);
    expect(snap.amountBase).toBe(5000n);

    const err = await grabError(() =>
      svc.snapshotAmount({
        currency: 'JPY',
        baseCurrency: 'CNY',
        amount: '1000',
        manualRate: '20',
        manualRateBy: null,
        date: '2026-05-01',
      }),
    );
    expect((err as Error).message).toMatch(/必须提供 manualRateBy/);
  });

  it('汇率取不到 → amount_base = null（待补，不计入汇总）', async () => {
    const failing: FxRateSource = {
      name: 'LICENSED',
      async fetchRate() {
        throw new Error('上游超时');
      },
    };
    const svc = new FxService(failing, new MapCache());
    const snap = await svc.snapshotAmount({
      currency: 'JPY',
      baseCurrency: 'CNY',
      amount: '1000',
      date: '2026-05-01',
    });
    expect(snap.amountBase).toBeNull();
    // 待补记录不参与汇总
    expect(sumMinorUnits([snap.amountBase ?? 0n])).toBe(0n);
  });
});
