/**
 * fx 域 · service
 * ============================================================================
 * 职责：汇率查询 / 手工录入 / 金额快照 / 批量折算 / 历史重算（默认拒绝）。
 *
 * 🔴 R5 · 唯一口径 SPOT_SELL
 *   档位**必须进缓存键**。不填档位会跨档污染历史金额，G5 金额对账必然失败。
 *
 * 🔴 R6 · 切档位默认不重算历史
 *   `amount_base` 一旦固化成快照。切档位只影响之后的新录入。
 *   要重算必须三条件齐备：显式声明 + 版本通道 + 对账报告，缺一即拒。
 *
 * 🔴 R7 · 禁止抓取
 *   本域只认「合规授权源」。手工录入需带 source 且必须过白名单校验；
 *   未授权的 source 直接抛 FX_SOURCE_MISCONFIGURED。
 *
 * 🔴 汇率缺失 → amountBase = null（待补）
 *   ⛔ 不猜、不用 0、不用 1:1 兜底。null 的记录**不计入任何汇总**。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { bigIntCell, stringCell } from '../../common/db/row-key.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';
import { convertToBase, fromMinorUnits, minorUnitOf, toMinorUnits } from '../../common/fx/amount.js';
import {
  ACTIVE_RATE_TIER,
  assertAuthorizedSource,
  isAuthorizedSource,
  resolveTier,
  type CurrencyCode,
  type RateTierValue,
} from '../../common/fx/rate-tier.js';
import type { FxRateSource } from '../../common/fx/source-guard.js';
import { DEFAULT_AUDIT_RETENTION_DAYS } from '../domain-context.js';

const FX_BIGINT_FIELDS = ['id'];

/** 内存缓存条目 */
interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * 极简 KV 缓存（内存实现）。
 * 生产替换为 Redis —— 键格式由 `fxCacheKey` 固定（含档位段）。
 */
export class MemoryKvCache {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly defaultTtlMs = 6 * 60 * 60 * 1000) {}

  // 纯内存实现，接口声明为 Promise —— 用 Promise.resolve 显式落地，不写空 async。
  get(key: string): Promise<string | null | object> {
    const hit = this.map.get(key);
    if (!hit) return Promise.resolve(null);
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(hit.value as object);
  }

  set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds !== undefined ? ttlSeconds * 1000 : this.defaultTtlMs;
    this.map.set(key, { value, expiresAt: Date.now() + ttl });
    return Promise.resolve();
  }

  clear(): void {
    this.map.clear();
  }
}

/** 缓存键（含档位段 —— 验收 6） */
export function fxCacheKeyOf(base: string, quote: string, tier: string, date: string): string {
  if (!base || !quote) throw new Error('fxCacheKey: base / quote 不得为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`fxCacheKey: date 须为 YYYY-MM-DD 实际 ${date}`);
  return `fx:${base.toUpperCase()}:${quote.toUpperCase()}:${tier}:${date}`;
}

export interface FxServiceOptions {
  ctx: DomainContext;
  /** 合规授权汇率源；未注入时只能走手工录入路径 */
  source?: FxRateSource;
  cache?: MemoryKvCache;
  auditRetentionDays?: number;
  now?: () => Date;
}

/** 汇率查询结果（对外形状） */
export interface RateView {
  base: CurrencyCode;
  quote: CurrencyCode;
  rate: string;
  rateDate: string;
  tier: RateTierValue;
  rateTime: string;
  source: string;
  fromCache: boolean;
}

/** 金额快照结果 */
export interface SnapshotView {
  currency: CurrencyCode;
  amountMinor: string;
  exchangeRate: string;
  amountBaseMinor: string | null;
  /** 待补汇率标记 —— 前端需提示用户 */
  pendingRate: boolean;
  rateDate: string;
  tier: RateTierValue;
  rateTime: string;
  rateSource: 'AUTO' | 'MANUAL';
  rateBy: string | null;
}

export class FxService {
  private readonly retentionDays: number;
  private readonly cache: MemoryKvCache;
  private readonly now: () => Date;

  constructor(private readonly o: FxServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
    this.cache = o.cache ?? new MemoryKvCache();
    this.now = o.now ?? (() => new Date());
  }

  /** 本期生效档位 */
  get activeTier(): RateTierValue {
    return ACTIVE_RATE_TIER;
  }

  // ══════════════════════════════════════════════════════════════════════
  // 查询
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 取汇率。顺序：缓存 → 库内 exchange_rate 表 → 授权源回源 → 落库。
   *
   * ⛔ 回源必须过授权白名单（R7）。库内已有记录视为有效源，不再回源。
   */
  async getRate(input: {
    base: string;
    quote: string;
    date: string;
    tier?: string;
    forceRefresh?: boolean;
  }): Promise<RateView> {
    const tier = resolveTier(input.tier);
    const base = input.base.toUpperCase();
    const quote = input.quote.toUpperCase();

    // 同币种：恒等 1，不建缓存不落库
    if (base === quote) {
      return {
        base,
        quote,
        rate: '1',
        rateDate: input.date,
        tier,
        rateTime: this.now().toISOString(),
        source: 'IDENTITY',
        fromCache: false,
      };
    }

    const key = fxCacheKeyOf(base, quote, tier, input.date);

    if (input.forceRefresh !== true) {
      const hit = await this.cache.get(key);
      if (hit) {
        const cached = hit as RateView;
        return { ...cached, fromCache: true };
      }
    }

    // 库内先查（人工录入 / 之前回源固化的都会在这里）
    const stored = await this.findStoredRate(base, quote, tier, input.date);
    if (stored) {
      const view = this.toRateView(stored);
      await this.cache.set(key, view);
      return { ...view, fromCache: false };
    }

    // 回源
    const src = this.o.source;
    if (!src) {
      throw new AppError(
        ErrorCode.FX_SOURCE_MISCONFIGURED,
        `汇率 ${base}→${quote} ${input.date} 缺失，且未注入合规授权源`,
      );
    }
    if (!isAuthorizedSource(src.name)) {
      throw new AppError(
        ErrorCode.FX_SOURCE_MISCONFIGURED,
        `汇率源 "${src.name}" 非合规授权源（红线 R7：禁止抓取）`,
      );
    }

    const fetched = await src.fetchRate({ base, quote, tier, date: input.date });
    const row = await this.persistRate({
      base: fetched.base.toUpperCase(),
      quote: fetched.quote.toUpperCase(),
      rate: fetched.rate,
      rateDate: fetched.rateDate,
      tier: fetched.tier,
      source: fetched.source,
      rateTime: fetched.rateTime,
    });

    const view = this.toRateView(row);
    await this.cache.set(key, view);
    return { ...view, fromCache: false };
  }

  /** 汇率列表（对账 / 运维） */
  async listRates(q: {
    base?: string;
    quote?: string;
    tier?: string;
    from?: string;
    to?: string;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: RateView[]; meta: Record<string, unknown>; }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const tier = q.tier !== undefined ? resolveTier(q.tier) : undefined;

    const all = await this.o.ctx.read.findMany('exchangeRate', { where: { deletedAt: null } });
    let rows = [...all];
    if (q.base !== undefined) rows = rows.filter((r) => r['base'] === q.base!.toUpperCase());
    if (q.quote !== undefined) rows = rows.filter((r) => r['quote'] === q.quote!.toUpperCase());
    if (tier !== undefined) rows = rows.filter((r) => r['tier'] === tier);
    if (q.from !== undefined) rows = rows.filter((r) => String(r['rateDate']) >= q.from!);
    if (q.to !== undefined) rows = rows.filter((r) => String(r['rateDate']) <= q.to!);

    // 按日期倒序，同日按 id 倒序（稳定）
    rows.sort((a, b) => {
      const d = String(b['rateDate']).localeCompare(String(a['rateDate']));
      return d !== 0 ? d : Number((b['id'] as bigint) - (a['id'] as bigint));
    });

    const slice = rows.slice(page.skip, page.skip + page.take);
    return {
      items: slice.map((r) => this.toRateView(r)),
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 手工录入
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 手工录入汇率（人工授权源路径）。
   *
   * 🔴 `source` 必须过授权白名单 —— 即使是手工录入，来源也要可审计。
   *    白名单为空（未签约授权源）时，只允许 `MANUAL_ENTRY` 这个显式内部源。
   */
  async upsertRate(
    userId: bigint,
    input: {
      base: string;
      quote: string;
      rate: string;
      rateDate: string;
      tier?: string;
      source: string;
    },
  ): Promise<RateView> {
    const tier = resolveTier(input.tier);
    const base = input.base.toUpperCase();
    const quote = input.quote.toUpperCase();

    // 手工源白名单：MANUAL_ENTRY 恒可；其余须在授权白名单内
    if (input.source !== MANUAL_SOURCE) {
      try {
        assertAuthorizedSource(input.source);
      } catch {
        throw new AppError(
          ErrorCode.FX_SOURCE_MISCONFIGURED,
          `汇率源 "${input.source}" 非合规授权源（红线 R7）`,
        );
      }
    }

    if (Number(input.rate) <= 0) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, '汇率必须大于 0');
    }

    const row = await this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();

      // 同键旧行软删（保留审计链，不物理删）
      const existing = await tx.db.findMany('exchangeRate', {
        where: { base, quote, tier, rateDate: input.rateDate, source: input.source, deletedAt: null },
      });
      for (const old of existing) {
        await tx.db.update('exchangeRate', { id: old['id'] }, { deletedAt: now, updatedAt: now });
      }

      const id = tx.write.nextId();
      await tx.db.insert('exchangeRate', {
        id,
        base,
        quote,
        tier,
        rate: input.rate,
        rateDate: input.rateDate,
        source: input.source,
        rateTime: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'exchange_rate', id, 'UPSERT', now);
      await this.audit(tx, {
        actorId: userId,
        action: 'fx.rate_manual_entry',
        reason: 'MANUAL_RATE_ENTRY',
        severity: 'INFO',
        targetId: id,
        detail: { base, quote, tier, rate: input.rate, rateDate: input.rateDate, source: input.source },
        at: now,
      });

      const row = await tx.db.findUnique('exchangeRate', { id });
      return row ?? {};
    });

    // 录入后失效缓存 —— 否则读到旧值
    await this.cache.set(fxCacheKeyOf(base, quote, tier, input.rateDate), this.toRateView(row));

    return this.toRateView(row);
  }

  // ══════════════════════════════════════════════════════════════════════
  // 金额快照 / 折算
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 录入外币金额 → 固化快照。
   *
   * - 同币种 → 直接 1:1 快照（不算汇率，不依赖汇率源）
   * - 汇率缺失 → `amountBase = null` + `pendingRate = true`
   *   ⛔ 不猜、不用 0、不用 1 兜底
   * - 手动覆盖 → `rateSource = 'MANUAL'` + `rateBy` 必填（否则审计断链）
   */
  async snapshotAmount(
    userId: bigint,
    input: {
      currency: string;
      baseCurrency: string;
      amount: string;
      date: string;
      tier?: string;
      manualRate?: string;
    },
  ): Promise<SnapshotView> {
    const tier = resolveTier(input.tier);
    const currency = input.currency.toUpperCase();
    const baseCurrency = input.baseCurrency.toUpperCase();
    const amountMinor = toMinorUnits(input.amount, currency);

    // 手动覆盖：必须有操作人（由登录态带入，恒有值）
    if (input.manualRate !== undefined) {
      if (input.manualRate.trim() === '' || Number(input.manualRate) <= 0) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, '手动汇率必须为正数');
      }
      return {
        currency,
        amountMinor: amountMinor.toString(),
        exchangeRate: input.manualRate,
        amountBaseMinor: convertToBase(input.amount, input.manualRate, baseCurrency).toString(),
        pendingRate: false,
        rateDate: input.date,
        tier,
        rateTime: this.now().toISOString(),
        rateSource: 'MANUAL',
        rateBy: userId.toString(),
      };
    }

    // 同币种快捷路径 —— 不给汇率源制造无谓压力
    if (currency === baseCurrency) {
      return {
        currency,
        amountMinor: amountMinor.toString(),
        exchangeRate: '1',
        amountBaseMinor: amountMinor.toString(),
        pendingRate: false,
        rateDate: input.date,
        tier,
        rateTime: this.now().toISOString(),
        rateSource: 'AUTO',
        rateBy: null,
      };
    }

    // 取汇率；取不到 → 待补（不阻断业务）
    try {
      const rate = await this.getRate({ base: baseCurrency, quote: currency, date: input.date, tier });
      return {
        currency,
        amountMinor: amountMinor.toString(),
        exchangeRate: rate.rate,
        amountBaseMinor: convertToBase(input.amount, rate.rate, baseCurrency).toString(),
        pendingRate: false,
        rateDate: rate.rateDate,
        tier,
        rateTime: rate.rateTime,
        rateSource: 'AUTO',
        rateBy: null,
      };
    } catch {
      // 汇率缺失 —— 待补，不计入任何汇总
      return {
        currency,
        amountMinor: amountMinor.toString(),
        exchangeRate: '',
        amountBaseMinor: null,
        pendingRate: true,
        rateDate: input.date,
        tier,
        rateTime: this.now().toISOString(),
        rateSource: 'AUTO',
        rateBy: null,
      };
    }
  }

  /**
   * 批量折算（列表页展示用）。
   *
   * 单条失败不阻断整批 —— 该条返回 `baseAmountMinor: null` + `error`。
   */
  async convertBatch(input: {
    baseCurrency: string;
    date: string;
    tier?: string;
    items: readonly { currency: string; amount: string }[];
  }): Promise<{
    baseCurrency: string;
    tier: RateTierValue;
    items: Array<{
      currency: string;
      amountMinor: string;
      baseAmountMinor: string | null;
      exchangeRate: string;
      error?: string;
    }>;
  }> {
    const tier = resolveTier(input.tier);
    const baseCurrency = input.baseCurrency.toUpperCase();
    const out: Array<{
      currency: string;
      amountMinor: string;
      baseAmountMinor: string | null;
      exchangeRate: string;
      error?: string;
    }> = [];

    for (const it of input.items) {
      const currency = it.currency.toUpperCase();
      try {
        const amountMinor = toMinorUnits(it.amount, currency);
        if (currency === baseCurrency) {
          out.push({
            currency,
            amountMinor: amountMinor.toString(),
            baseAmountMinor: amountMinor.toString(),
            exchangeRate: '1',
          });
          continue;
        }
        const rate = await this.getRate({ base: baseCurrency, quote: currency, date: input.date, tier });
        out.push({
          currency,
          amountMinor: amountMinor.toString(),
          baseAmountMinor: convertToBase(it.amount, rate.rate, baseCurrency).toString(),
          exchangeRate: rate.rate,
        });
      } catch (e) {
        out.push({
          currency,
          amountMinor: safeMinor(it.amount, currency).toString(),
          baseAmountMinor: null,
          exchangeRate: '',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { baseCurrency, tier, items: out };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 历史重算（默认拒绝）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 重算历史金额 —— **默认拒绝**。
   *
   * 三条件缺一即拒（R6）：
   *   ① `allowRecomputeHistory === true`（显式声明）
   *   ② `versionChannel > RATE_SERIES_VERSION`（走版本通道）
   *   ③ `reconciliationReportId`（G5 全量对账报告）
   */
  async recomputeHistory(
    userId: bigint,
    input: {
      baseCurrency: string;
      newTier: string;
      allowRecomputeHistory: boolean;
      versionChannel?: number;
      reconciliationReportId?: string;
      recordIds: readonly string[];
    },
  ): Promise<{
    recomputed: number;
    skippedPending: number;
    changed: number;
    report: { from: number; to: number };
    items: Array<{ id: string; amountBaseMinor: string | null; exchangeRate: string }>;
  }> {
    const baseCurrency = input.baseCurrency.toUpperCase();

    if (input.allowRecomputeHistory !== true) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        '拒绝重算历史：未显式声明 allowRecomputeHistory。红线 R6——切档位默认不重算历史金额。',
      );
    }

    const gaps: string[] = [];
    if (input.versionChannel === undefined || input.versionChannel <= RATE_SERIES_VERSION) {
      gaps.push('未声明新的版本通道（versionChannel 必须 > 当前口径版本）');
    }
    if (!input.reconciliationReportId) {
      gaps.push('未提供全量对账报告 ID（G5 金额对账）');
    }
    if (gaps.length > 0) {
      throw new AppError(ErrorCode.FORBIDDEN, `拒绝重算历史：${gaps.join('；')}。红线 R6。`);
    }

    const newTier = resolveTier(input.newTier);
    const ids = input.recordIds.map((s) => BigInt(s));
    // 上面的 gaps 校验已保证其存在；此处落成局部常量，避免闭包内再判一次
    const reconciliationReportId = input.reconciliationReportId as string;

    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const items: Array<{ id: string; amountBaseMinor: string | null; exchangeRate: string }> = [];
      let changed = 0;
      let skippedPending = 0;

      for (const id of ids) {
        const row = await tx.db.findUnique('expense', { id, deletedAt: null });
        if (!row) continue;

        // currency 缺失时不可盲折算：跳过并计入待补（与 amountBase=null 同语义）
        const currency = stringCell(row, 'currency');
        const amountBaseStr = row['amountBase'];
        // amountBase === null 的记录保持 null —— 不猜、不用默认汇率补
        if (amountBaseStr === null || amountBaseStr === undefined || currency === undefined) {
          skippedPending += 1;
          items.push({ id: id.toString(), amountBaseMinor: null, exchangeRate: '' });
          continue;
        }

        const rateDate = stringCell(row, 'rateDate') ?? reconciliationReportId;
        let rate: RateView;
        try {
          rate = await this.getRate({ base: baseCurrency, quote: currency, date: rateDate, tier: newTier });
        } catch {
          skippedPending += 1;
          items.push({ id: id.toString(), amountBaseMinor: null, exchangeRate: '' });
          continue;
        }

        const original = fromMinorUnits(bigIntCell(row, 'amount'), currency).toString();
        const nextBase = convertToBase(original, rate.rate, baseCurrency);
        if (nextBase !== bigIntCell({ amountBase: amountBaseStr }, 'amountBase')) changed += 1;

        await tx.db.update(
          'expense',
          { id },
          {
            amountBase: nextBase,
            exchangeRate: rate.rate,
            rateTier: newTier,
            rateDate: rate.rateDate,
            rateTime: new Date(rate.rateTime),
            rateSource: 'AUTO',
            updatedAt: now,
          },
        );

        await this.change(tx, 'expense', id, 'UPDATE', now);
        items.push({ id: id.toString(), amountBaseMinor: nextBase.toString(), exchangeRate: rate.rate });
      }

      await this.audit(tx, {
        actorId: userId,
        action: 'fx.history_recomputed',
        reason: 'EXPLICIT_VERSION_CHANNEL_RECOMPUTE',
        severity: 'ALERT',
        targetId: null,
        detail: {
          baseCurrency,
          newTier,
          versionChannel: input.versionChannel,
          reconciliationReportId: input.reconciliationReportId,
          changed,
          skippedPending,
        },
        at: now,
      });

      return {
        recomputed: items.length,
        skippedPending,
        changed,
        report: { from: RATE_SERIES_VERSION, to: input.versionChannel as number },
        items,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部
  // ══════════════════════════════════════════════════════════════════════

  private async findStoredRate(
    base: string,
    quote: string,
    tier: string,
    date: string,
  ): Promise<Row | null> {
    const rows = await this.o.ctx.read.findMany('exchangeRate', {
      where: { base, quote, tier, rateDate: date, deletedAt: null },
    });
    if (rows.length === 0) return null;
    // 同日同键可能多条（不同 source）→ 取 id 最大者（最新录入）
    return rows.reduce((a, b) => (Number((b['id'] as bigint) - (a['id'] as bigint)) > 0 ? b : a));
  }

  /** 落库（回源结果固化，避免重复回源） */
  private async persistRate(input: {
    base: string;
    quote: string;
    rate: string;
    rateDate: string;
    tier: RateTierValue;
    source: string;
    rateTime: Date;
  }): Promise<Row> {
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      const existing = await tx.db.findMany('exchangeRate', {
        where: {
          base: input.base,
          quote: input.quote,
          tier: input.tier,
          rateDate: input.rateDate,
          source: input.source,
          deletedAt: null,
        },
      });
      if (existing.length > 0) {
        const hit = existing[0]!;
        return hit;
      }

      const id = tx.write.nextId();
      await tx.db.insert('exchangeRate', {
        id,
        base: input.base,
        quote: input.quote,
        tier: input.tier,
        rate: input.rate,
        rateDate: input.rateDate,
        source: input.source,
        rateTime: input.rateTime,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
      const row = await tx.db.findUnique('exchangeRate', { id });
      return row ?? {};
    });
  }

  private toRateView(row: Row): RateView {
    const rateTime = row['rateTime'];
    const iso =
      rateTime instanceof Date ? rateTime.toISOString() : new Date(String(rateTime)).toISOString();
    return {
      base: String(row['base']),
      quote: String(row['quote']),
      rate: String(row['rate']),
      rateDate: String(row['rateDate']),
      tier: String(row['tier']) as RateTierValue,
      rateTime: iso,
      source: String(row['source']),
      fromCache: false,
    };
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    op: 'INSERT' | 'UPDATE' | 'DELETE' | 'UPSERT',
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId: null,
      tripId: null,
      op,
      changedAt: at,
      createdAt: at,
    });
  }

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT';
      targetId: bigint | null;
      detail: unknown;
      at: Date;
    },
  ): Promise<void> {
    await tx.db.insert('auditLog', {
      id: tx.write.nextId(),
      actorId: e.actorId,
      action: e.action,
      reason: e.reason,
      severity: e.severity,
      retainUntil: new Date(e.at.getTime() + this.retentionDays * 86_400_000),
      targetType: 'exchange_rate',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}

/** 手工录入的显式内部源标识（恒可，绕过授权白名单） */
export const MANUAL_SOURCE = 'MANUAL_ENTRY';

/** 当前汇率口径版本 */
export const RATE_SERIES_VERSION = 1;

void FX_BIGINT_FIELDS; // 供序列化工具引用
void serializeRow; // 保留引用，便于后续切换为序列化输出
void minorUnitOf;

/** 宽松最小单位换算：金额非法时兜底 0，不阻断批次 */
function safeMinor(amount: string, currency: string): bigint {
  try {
    return toMinorUnits(amount, currency);
  } catch {
    return 0n;
  }
}
