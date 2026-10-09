/**
 * M4 · 汇率快照服务
 * ---------------------------------------------------------------------------
 * 🔴 红线 R6：切档位**默认不重算历史**。
 *
 * `amount_base` 一旦固化即成快照。切档位只影响**之后的新录入**。
 * 若业务确实要重算历史，必须：
 *   ① 显式声明（`allowRecomputeHistory: true`）
 *   ② 走版本通道（新汇率口径版本号）
 *   ③ 全量对账（G5 金额对账）
 * 三者缺一即拒绝。
 */

import {
  ACTIVE_RATE_TIER,
  fxCacheKey,
  resolveTier,
  type CurrencyCode,
  type FxRate,
  type RateTierValue,
} from './rate-tier.js';
import { convertToBase, fromMinorUnits, toMinorUnits } from './amount.js';
import type { FxRateSource } from './source-guard.js';

/** 汇率口径版本号 —— 重算历史必须 +1 并走版本通道 */
export const RATE_SERIES_VERSION = 1;

/** 汇率快照（落库后即固化） */
export interface RateSnapshot {
  currency: CurrencyCode;
  /** 原币最小单位整数 */
  amount: bigint;
  /** 1 base = rate quote */
  exchangeRate: string;
  /** 基准币最小单位整数；null = 待补汇率，不计入任何汇总 */
  amountBase: bigint | null;
  rateDate: string;
  tier: RateTierValue;
  rateTime: Date;
  rateSource: 'AUTO' | 'MANUAL';
  rateBy: bigint | null;
}

export class FxService {
  constructor(
    private readonly source: FxRateSource,
    /** 汇率缓存；生产用 Redis，键由 fxCacheKey 生成（必须含档位段） */
    private readonly cache: KvCache,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * 取当日汇率快照（缓存命中则不回源）。
   *
   * @param tier 未传时填本期唯一口径 SPOT_SELL。⛔ 不允许隐式省略档位。
   */
  async getRate(args: {
    base: CurrencyCode;
    quote: CurrencyCode;
    date: string;
    tier?: string | null;
  }): Promise<FxRate> {
    const tier = resolveTier(args.tier);
    const key = fxCacheKey(args.base, args.quote, tier, args.date);

    const hit = await this.cache.get(key);
    if (hit) return hit as unknown as FxRate;

    const rate = await this.source.fetchRate({
      base: args.base,
      quote: args.quote,
      tier,
      date: args.date,
    });

    // 回写缓存 —— 用同一个含档位的键
    await this.cache.set(key, rate);
    return rate;
  }

  /**
   * 录入外币金额 → 逐笔折算并固化 `amount_base`。
   *
   * - 汇率缺失 → `amountBase = null`（待补汇率，**不计入任何汇总**）
   * - 手动覆盖 → rateSource='MANUAL' + rateBy 必填
   */
  async snapshotAmount(args: {
    currency: CurrencyCode;
    baseCurrency: CurrencyCode;
    amount: string;
    /** 手动指定汇率；给了即成新快照，后续不重算 */
    manualRate?: string | null;
    manualRateBy?: bigint | null;
    date: string;
    tier?: string | null;
  }): Promise<RateSnapshot> {
    const tier = resolveTier(args.tier);

    if (args.manualRate !== null && args.manualRate !== undefined) {
      if (args.manualRateBy === null || args.manualRateBy === undefined) {
        throw new Error('手动覆盖汇率必须提供 manualRateBy（操作人），否则审计断链');
      }
      return {
        currency: args.currency,
        amount: toMinorUnits(args.amount, args.currency),
        exchangeRate: args.manualRate,
        amountBase: convertToBase(args.amount, args.manualRate, args.baseCurrency),
        rateDate: args.date,
        tier,
        rateTime: this.now(),
        rateSource: 'MANUAL',
        rateBy: args.manualRateBy,
      };
    }

    let rate: FxRate;
    try {
      rate = await this.getRate({
        base: args.baseCurrency,
        quote: args.currency,
        date: args.date,
        tier,
      });
    } catch {
      // 汇率缺失 → 待补。⛔ 不猜、不用 0、不用 1
      return {
        currency: args.currency,
        amount: toMinorUnits(args.amount, args.currency),
        exchangeRate: '',
        amountBase: null,
        rateDate: args.date,
        tier,
        rateTime: this.now(),
        rateSource: 'AUTO',
        rateBy: null,
      };
    }

    return {
      currency: args.currency,
      amount: toMinorUnits(args.amount, args.currency),
      exchangeRate: rate.rate,
      amountBase: convertToBase(args.amount, rate.rate, args.baseCurrency),
      rateDate: rate.rateDate,
      tier,
      rateTime: rate.rateTime,
      rateSource: 'AUTO',
      rateBy: null,
    };
  }

  /**
   * 重算历史金额 —— **默认拒绝**。
   *
   * 切档位不调本方法即代表「历史保持不变」，这是默认且推荐的做法。
   */
  async recomputeHistory(args: {
    snapshots: readonly RateSnapshot[];
    baseCurrency: CurrencyCode;
    newTier: string;
    allowRecomputeHistory?: boolean;
    versionChannel?: number;
    reconciliationReportId?: string;
  }): Promise<{
    recomputed: RateSnapshot[];
    report: { from: number; to: number; changed: number };
  }> {
    // 默认路径：切档位不重算，原样返回
    if (args.allowRecomputeHistory !== true) {
      return {
        recomputed: [...args.snapshots],
        report: { from: RATE_SERIES_VERSION, to: RATE_SERIES_VERSION, changed: 0 },
      };
    }

    const gaps: string[] = [];
    if (args.versionChannel === undefined || args.versionChannel <= RATE_SERIES_VERSION) {
      gaps.push('未声明新的版本通道（versionChannel 必须 > 当前口径版本）');
    }
    if (!args.reconciliationReportId) {
      gaps.push('未提供全量对账报告 ID（G5 金额对账）');
    }
    if (gaps.length > 0) {
      throw new Error(`拒绝重算历史：${gaps.join('；')}。红线 R6——切档位默认不重算历史金额。`);
    }

    const newTier = resolveTier(args.newTier);
    const recomputed: RateSnapshot[] = [];
    let changed = 0;

    for (const snap of args.snapshots) {
      // 待补汇率的记录（amountBase === null）保持 null —— 不猜、不用默认汇率补
      if (snap.amountBase === null) {
        recomputed.push(snap);
        continue;
      }
      const rate = await this.getRate({
        base: args.baseCurrency,
        quote: snap.currency,
        date: snap.rateDate,
        tier: newTier,
      });
      const nextBase = convertToBase(
        fromMinorUnits(snap.amount, snap.currency),
        rate.rate,
        args.baseCurrency,
      );
      if (nextBase !== snap.amountBase) changed += 1;
      recomputed.push({
        ...snap,
        tier: newTier,
        exchangeRate: rate.rate,
        amountBase: nextBase,
        rateTime: rate.rateTime,
      });
    }

    return {
      recomputed,
      report: { from: RATE_SERIES_VERSION, to: args.versionChannel as number, changed },
    };
  }

  /** 本期生效档位 */
  get activeTier(): RateTierValue {
    return ACTIVE_RATE_TIER;
  }
}

/** 极简 KV 接口（生产 = Redis；测试 = Map） */
export interface KvCache {
  get(key: string): Promise<string | null | object>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
}
