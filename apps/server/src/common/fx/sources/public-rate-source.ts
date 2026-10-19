/**
 * 公开汇率源适配器 —— 开发 / 预览专用
 * ============================================================================
 * 实现 `FxRateSource`，把「公开免费汇率 API」包成域内可注入的形态。
 *
 * 🔴 红线 R7 边界（改这个文件前务必读完）：
 *   本适配器取的是**市场中间价**，不是银行现汇卖出价（SPOT_SELL）。
 *   它只解决「本地 / 预览环境没有汇率数据、外币金额全挂 null」的问题，
 *   **绝不能**用于生产金额固化。因此做了两道锁：
 *     ① `resolvePublicFxSource()` 在 NODE_ENV=production 下直接返回 undefined，
 *        让 `assertFxSourceConfigured()` 的 fail-fast 照常生效（进程起不来）；
 *     ② 默认源名 `PUBLIC_RATE_DEV` 必须显式写进 `FX_AUTHORIZED_SOURCES`，
 *        生产环境没人会把它配进白名单。
 *
 *   生产要真数据，按同一个 `FxRateSource` 接口实现一个签约授权源（银行 /
 *   外汇交易中心）即可，域代码零改动 —— 这正是该接口存在的意义。
 *
 * 数据源（按顺序回退）：
 *   ① open.er-api.com      —— 无 key，166 币种，日更；只提供「最新」
 *   ② api.frankfurter.app  —— 无 key，ECB 口径，支持历史日期
 *
 * 缓存：同一 `(base, date)` 的全量汇率表在进程内复用（当日默认 30 分钟，
 *      历史日期永久），避免 N 个 quote 打 N 次外部接口。
 */

import { Decimal } from 'decimal.js';
import type { FxRate } from '../rate-tier.js';
import { RateTier } from '../rate-tier.js';
import type { FxRateSource } from '../source-guard.js';

export const PUBLIC_RATE_SOURCE_NAME = 'PUBLIC_RATE_DEV';

export type PublicRateProvider = 'OPEN_ER_API' | 'FRANKFURTER';

/** 一张「1 base = X quote」的全量表 */
interface RatesTable {
  base: string;
  /** 数据实际对应的日期（YYYY-MM-DD），不是请求日期 */
  date: string;
  rates: Record<string, string>;
  provider: PublicRateProvider;
  fetchedAt: number;
}

export interface PublicRateSourceOptions {
  /** 源标识，须与 FX_AUTHORIZED_SOURCES 中的名字一致 */
  name?: string;
  /** 单次外部请求超时 */
  timeoutMs?: number;
  /** 当日汇率的进程内缓存时长 */
  todayCacheTtlMs?: number;
  /** 注入时钟（测试用） */
  now?: () => Date;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_TODAY_TTL_MS = 30 * 60 * 1000;
/** 后端 exchange_rate.rate 为 DECIMAL(18,8)，此处对齐 8 位 */
const RATE_SCALE = 8;

/** UTC 日期切片 —— 汇率天然按 UTC / 伦敦时间结算，不用本地时区 */
function isoUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 任意源返回的数值 → 8 位定点字符串；非法值直接抛，不做 1 兜底 */
function toRateString(raw: unknown): string {
  let d: Decimal;
  try {
    d = new Decimal(typeof raw === 'number' ? String(raw) : String(raw));
  } catch {
    throw new Error(`汇率值非法：${String(raw)}`);
  }
  if (!d.isFinite() || d.lte(0)) throw new Error(`汇率值非法：${String(raw)}`);
  return d.toFixed(RATE_SCALE);
}

export class PublicRateSource implements FxRateSource {
  readonly name: string;

  private readonly timeoutMs: number;
  private readonly todayCacheTtlMs: number;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  private readonly cache = new Map<string, RatesTable>();
  /** 并发去重：同一 (base, date) 只允许一个外部请求在飞 */
  private readonly inflight = new Map<string, Promise<RatesTable>>();

  constructor(options: PublicRateSourceOptions = {}) {
    this.name = options.name ?? PUBLIC_RATE_SOURCE_NAME;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.todayCacheTtlMs = options.todayCacheTtlMs ?? DEFAULT_TODAY_TTL_MS;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async fetchRate(args: {
    base: string;
    quote: string;
    tier: string;
    date: string;
  }): Promise<FxRate> {
    // 域层只会传唯一口径，这里再挡一次：本适配器拿不到现汇卖出价
    if (args.tier !== RateTier.SpotSell) {
      throw new Error(
        `公开源仅提供中间价，无法产出档位 ${args.tier}（红线 R5：唯一口径 ${RateTier.SpotSell}）`,
      );
    }

    const base = args.base.toUpperCase();
    const quote = args.quote.toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      throw new Error(`货币代码非法：${base}/${quote}（须为 ISO 4217 三位大写字母）`);
    }

    const table = await this.loadTable(base, args.date);
    const rate = table.rates[quote];
    if (rate === undefined) {
      throw new Error(
        `汇率 ${base}→${quote} 缺失：${table.provider} 在 ${table.date} 无该币种数据`,
      );
    }

    return {
      base,
      quote,
      rate,
      rateDate: table.date,
      tier: args.tier,
      rateTime: this.now(),
      source: this.name,
    };
  }

  /** 取（并缓存）某 base 在某日的全量汇率表 */
  private async loadTable(base: string, date: string): Promise<RatesTable> {
    const key = `${base}|${date}`;
    const isToday = date === isoUtcDate(this.now());

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      const ttl = isToday ? this.todayCacheTtlMs : Number.POSITIVE_INFINITY;
      if (this.now().getTime() - cached.fetchedAt < ttl) return cached;
      this.cache.delete(key);
    }

    const flying = this.inflight.get(key);
    if (flying !== undefined) return flying;

    const task = this.fetchTable(base, date, isToday)
      .then((table) => {
        this.cache.set(key, table);
        return table;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }

  private async fetchTable(base: string, date: string, isToday: boolean): Promise<RatesTable> {
    // 历史日期只能用 frankfurter：open.er-api 免费档没有历史接口，
    // 用它会让「请求 10-01 却返回今天的数据」——日期对不上比取不到更危险。
    const attempts: Array<() => Promise<RatesTable>> = isToday
      ? [() => this.fromOpenErApi(base), () => this.fromFrankfurter(base)]
      : [() => this.fromFrankfurter(base, date)];

    const errors: string[] = [];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    throw new Error(`公开汇率源均不可用（${base} @ ${date}）：${errors.join('；')}`);
  }

  private async fromOpenErApi(base: string): Promise<RatesTable> {
    const json = (await this.getJson(`https://open.er-api.com/v6/latest/${base}`)) as {
      result?: string;
      rates?: Record<string, unknown>;
      time_last_update_unix?: number;
    };
    if (json.result !== 'success' || json.rates === undefined) {
      throw new Error(`open.er-api 响应异常（result=${String(json.result)}）`);
    }

    const rates: Record<string, string> = {};
    for (const [code, value] of Object.entries(json.rates)) {
      rates[code.toUpperCase()] = toRateString(value);
    }

    const date =
      typeof json.time_last_update_unix === 'number'
        ? isoUtcDate(new Date(json.time_last_update_unix * 1000))
        : isoUtcDate(this.now());

    return { base, date, rates, provider: 'OPEN_ER_API', fetchedAt: this.now().getTime() };
  }

  private async fromFrankfurter(base: string, date?: string): Promise<RatesTable> {
    const segment = date === undefined ? 'latest' : date;
    const json = (await this.getJson(`https://api.frankfurter.app/${segment}?from=${base}`)) as {
      base?: string;
      date?: string;
      rates?: Record<string, unknown>;
    };
    if (json.rates === undefined) throw new Error('frankfurter 响应异常');

    const rates: Record<string, string> = { [base]: '1' };
    for (const [code, value] of Object.entries(json.rates)) {
      rates[code.toUpperCase()] = toRateString(value);
    }

    return {
      base,
      date: json.date ?? date ?? isoUtcDate(this.now()),
      rates,
      provider: 'FRANKFURTER',
      fetchedAt: this.now().getTime(),
    };
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  }
}
