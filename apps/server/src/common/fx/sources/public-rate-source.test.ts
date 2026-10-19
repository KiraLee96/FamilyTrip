/**
 * PublicRateSource 单测 —— 公开汇率源适配器（开发/预览专用）
 *
 * 覆盖：红线 R5 档位守卫、货币校验、双源回退顺序、历史日期只走 frankfurter、
 *       rateDate 不伪造、进程内缓存 TTL、并发去重、数值/缺失币种抛错、
 *       resolvePublicFxSource 环境分流（生产恒 undefined / 显式关闭 / 改名）。
 */
import { describe, expect, it, vi } from 'vitest';
import { RateTier } from '../rate-tier.js';
import { PublicRateSource, PUBLIC_RATE_SOURCE_NAME } from './public-rate-source.js';
import { resolvePublicFxSource } from './index.js';

/** 最小 Response 形状 —— 源只消费 ok/status/json()，不依赖完整 DOM Response */
interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function jsonRes(body: unknown, ok = true): FakeResponse {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

/** 可控时钟：now() 返回当前假时间，advance() 拨快 */
function fakeClock(iso = '2026-10-19T00:00:00.000Z') {
  let t = new Date(iso);
  return {
    now: (): Date => t,
    advance(ms: number): void {
      t = new Date(t.getTime() + ms);
    },
  };
}

/** 记录调用的 fetch 桩：按 URL 关键词路由到不同响应 */
function routingFetch(routes: Record<string, () => FakeResponse>): {
  impl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    for (const [frag, make] of Object.entries(routes)) {
      if (url.includes(frag)) return make();
    }
    return jsonRes({}, false);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function openErBody(
  rates: Record<string, number>,
  unix = Math.floor(Date.UTC(2026, 0, 1) / 1000),
): unknown {
  return { result: 'success', rates, time_last_update_unix: unix };
}

const TODAY = '2026-10-19';

describe('PublicRateSource · 入参守卫（红线 R5 / ISO 4217）', () => {
  const src = new PublicRateSource({
    fetchImpl: (async () => jsonRes(openErBody({ JPY: 20.85 }))) as unknown as typeof fetch,
  });

  it('非 SPOT_SELL 档位 → 拒绝（公开源只有中间价，不出其他口径）', async () => {
    await expect(
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.Mid, date: TODAY }),
    ).rejects.toThrow(/公开源仅提供中间价/);
  });

  it('货币代码非三位大写 → 拒绝', async () => {
    await expect(
      src.fetchRate({ base: 'cn', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY }),
    ).rejects.toThrow(/货币代码非法/);
  });
});

describe('PublicRateSource · 当日取数与回退', () => {
  it('当日优先 open.er-api，解析 8 位定点 + time_last_update_unix 日期', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 20.85, USD: 0.1402 })),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    const r = await src.fetchRate({
      base: 'CNY',
      quote: 'JPY',
      tier: RateTier.SpotSell,
      date: TODAY,
    });

    expect(r.rate).toBe('20.85000000');
    expect(r.rateDate).toBe('2026-01-01'); // 固定 UTC 2026-01-01，与 now 假时钟无关
    expect(r.source).toBe(PUBLIC_RATE_SOURCE_NAME);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('open.er-api.com/v6/latest/CNY');
  });

  it('open.er-api 失败 → 回退 frankfurter（当日也回退）', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes({ result: 'error' }),
      'frankfurter.app': () =>
        jsonRes({ base: 'CNY', date: '2026-10-19', rates: { JPY: 23.602879 } }),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    const r = await src.fetchRate({
      base: 'CNY',
      quote: 'JPY',
      tier: RateTier.SpotSell,
      date: TODAY,
    });

    expect(r.rate).toBe('23.60287900');
    expect(r.rateDate).toBe('2026-10-19');
    expect(calls).toHaveLength(2); // 先 er-api 后 frankfurter
  });

  it('两个源都挂 → 抛错且带上两个源的失败原因', async () => {
    const { impl } = routingFetch({}); // 全部 500
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    await expect(
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY }),
    ).rejects.toThrow(/公开汇率源均不可用.*open\.er-api.*frankfurter/s);
  });
});

describe('PublicRateSource · 历史日期（frankfurter 独占，不伪造日期）', () => {
  it('历史日期只打 frankfurter，URL 带日期，rateDate 用数据实际日期', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 20.85 })), // 若被调用即失败
      'frankfurter.app': () => jsonRes({ base: 'CNY', date: '2026-03-02', rates: { JPY: 21.5 } }),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    const r = await src.fetchRate({
      base: 'CNY',
      quote: 'JPY',
      tier: RateTier.SpotSell,
      date: '2026-03-02',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('frankfurter.app/2026-03-02?from=CNY');
    expect(r.rateDate).toBe('2026-03-02'); // 请求日 ≠ 数据日，照实回
  });

  it('frankfurter 不含该币种 → 缺失抛错（不 1 兜底）', async () => {
    const { impl } = routingFetch({
      'frankfurter.app': () => jsonRes({ base: 'CNY', date: '2026-03-02', rates: { USD: 0.14 } }),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    await expect(
      src.fetchRate({ base: 'CNY', quote: 'TWD', tier: RateTier.SpotSell, date: '2026-03-02' }),
    ).rejects.toThrow(/TWD 缺失/);
  });
});

describe('PublicRateSource · 缓存与并发', () => {
  it('同 (base,date) 二次取数命中进程内缓存，不再打外部', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 20.85 })),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    expect(calls).toHaveLength(1);
  });

  it('当日缓存 TTL 过期后重新回源；历史日期不过期', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 20.85 })),
      'frankfurter.app': () => jsonRes({ base: 'CNY', date: '2026-03-02', rates: { JPY: 21.5 } }),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now, todayCacheTtlMs: 1000 });

    // 当日：er-api 一发命中，无回退
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    clock.advance(500);
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    expect(calls).toHaveLength(1); // TTL 内仍命中

    clock.advance(600);
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    expect(calls).toHaveLength(2); // 过期重取

    // 历史日期：永久缓存，两次取数只打一次
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: '2026-03-02' });
    await src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: '2026-03-02' });
    expect(calls).toHaveLength(3);
  });

  it('并发同 key 只发一个外部请求（inflight 去重）', async () => {
    const { impl, calls } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 20.85, USD: 0.1402 })),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    await Promise.all([
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY }),
      src.fetchRate({ base: 'CNY', quote: 'USD', tier: RateTier.SpotSell, date: TODAY }),
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY }),
    ]);
    expect(calls).toHaveLength(1); // 三个 quote 共用一次 CNY 全量表
  });
});

describe('PublicRateSource · 数值合法性', () => {
  it('汇率为 0 / 负数 / 非数 → 抛错（不静默兜底）', async () => {
    const { impl } = routingFetch({
      'open.er-api.com': () => jsonRes(openErBody({ JPY: 0, XXX: -1 })),
    });
    const clock = fakeClock();
    const src = new PublicRateSource({ fetchImpl: impl, now: clock.now });

    await expect(
      src.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY }),
    ).rejects.toThrow(/汇率值非法/);
  });
});

describe('resolvePublicFxSource · 环境分流', () => {
  const fetchImpl = (async () => jsonRes(openErBody({ JPY: 20.85 }))) as unknown as typeof fetch;

  it('生产环境恒 undefined（红线 R7：公开源不许靠近生产）', () => {
    expect(resolvePublicFxSource({ NODE_ENV: 'production' }, { fetchImpl })).toBeUndefined();
  });

  it('FX_PUBLIC_SOURCE_DISABLED=0 → undefined（本地验缺失分支用）', () => {
    expect(
      resolvePublicFxSource({ FX_PUBLIC_SOURCE_DISABLED: '0' }, { fetchImpl }),
    ).toBeUndefined();
  });

  it('开发环境默认返回 PUBLIC_RATE_DEV 实例', () => {
    const s = resolvePublicFxSource({}, { fetchImpl });
    expect(s?.name).toBe(PUBLIC_RATE_SOURCE_NAME);
  });

  it('FX_PUBLIC_SOURCE_NAME 可覆盖源名（须同步进白名单）', () => {
    const s = resolvePublicFxSource({ FX_PUBLIC_SOURCE_NAME: 'MY_DEV_SRC' }, { fetchImpl });
    expect(s?.name).toBe('MY_DEV_SRC');
  });

  it('空白源名回落默认（trim 后为空串）', () => {
    const s = resolvePublicFxSource({ FX_PUBLIC_SOURCE_NAME: '   ' }, { fetchImpl });
    expect(s?.name).toBe(PUBLIC_RATE_SOURCE_NAME);
  });

  it('fetchImpl 被透传到实例（测试可桩掉外部请求）', async () => {
    const spy = vi.fn(async () => jsonRes(openErBody({ JPY: 20.85 }))) as unknown as typeof fetch;
    const s = resolvePublicFxSource({}, { fetchImpl: spy, now: fakeClock().now });
    await s?.fetchRate({ base: 'CNY', quote: 'JPY', tier: RateTier.SpotSell, date: TODAY });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
