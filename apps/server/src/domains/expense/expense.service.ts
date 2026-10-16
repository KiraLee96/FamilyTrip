/**
 * expense 域 · service
 * ============================================================================
 * 职责：花费记账。本域是**金额正确性**的主战场。
 *
 * 🔴 M2/M3 金额口径（三条铁律）：
 *   1. 存储用 `BIGINT` 最小货币单位（分/厘）—— **绝不**用 FLOAT/DOUBLE。
 *   2. 入参按**字符串**解析，经 `decimal.js` 转换 —— 不经 JS number。
 *      0.1 + 0.2 !== 0.3 这个经典坑在金额上不可接受。
 *   3. 汇总只加整数（`sumMinorUnits`），不做除法/反算/二次换算。
 *
 * 🔴 汇率档位（M4）：
 *   折算基准用 `SPOT_SELL`（现钞卖出价）。档位必须体现在缓存键里，
 *   否则「现汇」与「现钞」会互相污染 —— 这是曾经真实踩过的坑。
 *   `rate_source` / `rate_by` 落库，保证「当时用的什么汇率」可追溯。
 *
 * 🔴 快照语义（M4 recomputeHistory）：
 *   `amount_base` 是**记账时刻**折算结果，一旦落库不再随汇率变动而重算。
 *   历史账目重算只在管理员显式触发（`recomputeHistory`），且留审计。
 */

import { Decimal } from 'decimal.js';
import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import { ACTIVE_RATE_TIER } from '../../common/fx/rate-tier.js';
import { sumMinorUnits, toMinorUnits } from '../../common/fx/amount.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface ExpenseServiceOptions {
  ctx: DomainContext;
  /**
   * 取汇率：返回 `{ rate, source, rateDate }`。
   * 编排层注入（生产接 `FxService`；测试注入固定值）。
   */
  resolveRate: (args: {
    base: string;
    quote: string;
    tier: string;
    date: string;
  }) => Promise<{ rate: string; source: string } | null>;
  auditRetentionDays?: number;
  /** 「今天」的来源（默认 DB 时间取日期部分） */
  today?: () => string;
}

/**
 * D-2026-10-15-02：补 `rateBy` —— 手动覆盖汇率的操作人（A21 审计列）。
 * 漏列时该列在真 MySQL 下为 BigInt → JSON.stringify 抛 TypeError → 500 且丢信封。
 * （`version` 故意不入列：计数器经 HTTP 边界兜底出 number，见 envelope.ts。）
 */
const EXPENSE_BIGINT_FIELDS = [
  'id',
  'tripId',
  'familyId',
  'createdBy',
  'ownerMemberId',
  'amount',
  'amountBase',
  'rateBy',
];

export interface ExpenseSummary {
  displayCurrency: string;
  totalMinor: string;
  count: number;
  byOwner: Array<{ ownerMemberId: string | null; totalMinor: string; count: number }>;
  byCategory: Array<{ category: string | null; totalMinor: string; count: number }>;
  byCurrency: Array<{ currency: string; totalMinor: string; count: number }>;
}

export class ExpenseService {
  private readonly retentionDays: number;

  constructor(private readonly o: ExpenseServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 记一笔花费 —— 落库时做**一次**汇率折算快照 */
  async create(
    userId: bigint,
    input: {
      tripId: bigint;
      familyId: bigint;
      title: string;
      amount: string;
      currency: string;
      ownerMemberId?: bigint;
      category?: string;
      spentAt?: string;
      note?: string;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      // 字符串 → 最小单位整数（不经 number）
      const amountMinor = toMinorUnits(input.amount, input.currency);

      const now = await tx.db.dbNow();
      const spentAt = input.spentAt ?? now.toISOString().slice(0, 10);

      // 汇率快照：同币种时 rate=1，不查汇率源
      const { amountBase, exchangeRate, rateSource } = await this.snapshotAmount(
        input.currency,
        amountMinor,
        spentAt,
      );

      const id = tx.write.nextId();
      await tx.db.insert('expense', {
        id,
        tripId: input.tripId,
        familyId: input.familyId,
        createdBy: userId,
        ownerMemberId: input.ownerMemberId ?? null,
        title: input.title,
        amount: amountMinor,
        currency: input.currency.toUpperCase(),
        amountBase,
        exchangeRate,
        rateDate: new Date(`${spentAt}T00:00:00.000Z`),
        tier: ACTIVE_RATE_TIER,
        rateSource,
        rateBy: userId,
        category: input.category ?? null,
        spentAt: new Date(`${spentAt}T00:00:00.000Z`),
        note: input.note ?? null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'expense', id, input.familyId, input.tripId, 'INSERT', now);

      const row = await tx.db.findUnique('expense', { id });
      return serializeRow(row ?? {}, EXPENSE_BIGINT_FIELDS);
    });
  }

  /** 列表 */
  async list(
    userId: bigint,
    q: {
      tripId?: bigint;
      familyId?: bigint;
      ownerMemberId?: bigint;
      category?: string;
      from?: string;
      to?: string;
      displayCurrency?: string;
      page?: unknown;
      pageSize?: unknown;
    },
  ): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown> }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const all = await this.o.ctx.read.findMany('expense', { where: { deletedAt: null } });
    const visible = await this.visibleTripIds(userId);

    let rows = all.filter((e) => visible.has(e['tripId'] as bigint));
    if (q.tripId !== undefined) rows = rows.filter((e) => e['tripId'] === q.tripId);
    if (q.familyId !== undefined) rows = rows.filter((e) => e['familyId'] === q.familyId);
    if (q.ownerMemberId !== undefined)
      rows = rows.filter((e) => e['ownerMemberId'] === q.ownerMemberId);
    if (q.category !== undefined) rows = rows.filter((e) => e['category'] === q.category);
    if (q.from !== undefined) rows = rows.filter((e) => ymd(e['spentAt']) >= q.from!);
    if (q.to !== undefined) rows = rows.filter((e) => ymd(e['spentAt']) <= q.to!);

    rows = [...rows].sort((a, b) => (ymd(b['spentAt']) < ymd(a['spentAt']) ? -1 : 1));
    const slice = rows.slice(page.skip, page.skip + page.take);

    // 折算展示币种：按记账快照的 amount_base 反算（不再查汇率，避免口径漂移）
    const display = q.displayCurrency?.toUpperCase();
    const items = slice.map((e) => {
      const base = serializeRow(e, EXPENSE_BIGINT_FIELDS);
      if (display !== undefined && e['rateSource'] !== 'SAME_CURRENCY') {
        // 展示换算仅作参考，真值仍是 amount + currency
        const conv = this.displayConvert(e, display);
        return {
          ...base,
          displayAmount: conv.amount,
          displayCurrency: display,
          displayDerived: conv.derived,
        };
      }
      return base;
    });

    return {
      items,
      meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown>,
    };
  }

  /**
   * 汇总（按成员 / 分类 / 币种三维）。
   *
   * 🔴 只加整数最小单位。跨币种汇总时**必须先各自折算到基准币种**
   *    （用落库的 `amount_base`），而不是把不同币种的 amount 直接相加 ——
   *    那是「100 日元 + 100 人民币 = 200」的低级错误。
   */
  async summary(
    userId: bigint,
    q: { tripId?: bigint; familyId?: bigint; displayCurrency: string },
  ): Promise<ExpenseSummary> {
    const all = await this.o.ctx.read.findMany('expense', { where: { deletedAt: null } });
    const visible = await this.visibleTripIds(userId);
    let rows = all.filter((e) => visible.has(e['tripId'] as bigint));
    if (q.tripId !== undefined) rows = rows.filter((e) => e['tripId'] === q.tripId);
    if (q.familyId !== undefined) rows = rows.filter((e) => e['familyId'] === q.familyId);

    const display = q.displayCurrency.toUpperCase();

    const byOwner = new Map<bigint | null, bigint[]>();
    const byCategory = new Map<string | null, bigint[]>();
    const byCurrency = new Map<string, bigint[]>();
    const allBase: bigint[] = [];

    for (const e of rows) {
      const base = this.baseOf(e, display);
      allBase.push(base);

      const ownerKey = (e['ownerMemberId'] ?? null) as bigint | null;
      push(byOwner, ownerKey, base);
      push(byCategory, (e['category'] ?? null) as string | null, base);
      push(byCurrency, String(e['currency']), base);
    }

    const toBucket = <K>(m: Map<K, bigint[]>): Array<{ key: K; total: string; count: number }> =>
      [...m.entries()].map(([k, vs]) => ({
        key: k,
        total: sumMinorUnits(vs).toString(),
        count: vs.length,
      }));

    return {
      displayCurrency: display,
      totalMinor: sumMinorUnits(allBase).toString(),
      count: rows.length,
      byOwner: toBucket(byOwner).map((b) => ({
        ownerMemberId: b.key !== null ? String(b.key) : null,
        totalMinor: b.total,
        count: b.count,
      })),
      byCategory: toBucket(byCategory).map((b) => ({
        category: b.key,
        totalMinor: b.total,
        count: b.count,
      })),
      byCurrency: toBucket(byCurrency).map((b) => ({
        currency: String(b.key),
        totalMinor: b.total,
        count: b.count,
      })),
    };
  }

  /** 更新（CAS） */
  async update(
    userId: bigint,
    expenseId: bigint,
    patch: {
      version?: number;
      title?: string;
      amount?: string;
      currency?: string;
      category?: string | null;
      spentAt?: string | null;
      note?: string | null;
    },
  ): Promise<Record<string, unknown>> {
    return this.o.ctx.tx(async (tx) => {
      const e = await tx.db.findUnique('expense', { id: expenseId, deletedAt: null });
      if (!e) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: e['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      const expectedVersion = requireVersionOrSkip(patch.version, e['version']);

      const data: Row = { updatedAt: now, version: expectedVersion + 1 };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.category !== undefined) data['category'] = patch.category;
      if (patch.note !== undefined) data['note'] = patch.note;
      if (patch.spentAt !== undefined) {
        data['spentAt'] =
          patch.spentAt === null ? null : new Date(`${patch.spentAt}T00:00:00.000Z`);
        data['rateDate'] =
          patch.spentAt === null ? null : new Date(`${patch.spentAt}T00:00:00.000Z`);
      }

      // 金额或币种变了 → 必须重算折算快照（否则 amount_base 与 amount 不一致）
      const nextCurrency = (patch.currency ?? String(e['currency'])).toUpperCase();
      if (patch.amount !== undefined || patch.currency !== undefined) {
        const amountMinor =
          patch.amount !== undefined
            ? toMinorUnits(patch.amount, nextCurrency)
            : (e['amount'] as bigint);
        const dateForRate = patch.spentAt ?? ymd(e['spentAt']);
        const snap = await this.snapshotAmount(nextCurrency, amountMinor, dateForRate);

        data['amount'] = amountMinor;
        data['currency'] = nextCurrency;
        data['amountBase'] = snap.amountBase;
        data['exchangeRate'] = snap.exchangeRate;
        data['rateSource'] = snap.rateSource;
        data['tier'] = ACTIVE_RATE_TIER;
        data['rateBy'] = userId;
      }

      const affected = await tx.db.update(
        'expense',
        { id: expenseId, version: expectedVersion, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该笔花费已被他人修改，请刷新后重试');
      }

      await this.change(
        tx,
        'expense',
        expenseId,
        e['familyId'] as bigint,
        e['tripId'] as bigint,
        'UPDATE',
        now,
      );

      const row = await tx.db.findUnique('expense', { id: expenseId });
      return serializeRow(row ?? {}, EXPENSE_BIGINT_FIELDS);
    });
  }

  /** 删除（记账者或主导者） */
  async remove(userId: bigint, expenseId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const e = await tx.db.findUnique('expense', { id: expenseId, deletedAt: null });
      if (!e) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const isCreator = e['createdBy'] === userId;
      if (!isCreator) {
        const t = await tx.db.findUnique('trip', { id: e['tripId'], deletedAt: null });
        if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
        await this.assertLeaderOrCreator(tx, t, userId);
      }

      const now = await tx.db.dbNow();
      await tx.db.update('expense', { id: expenseId }, { deletedAt: now, updatedAt: now });
      await this.change(
        tx,
        'expense',
        expenseId,
        e['familyId'] as bigint,
        e['tripId'] as bigint,
        'DELETE',
        now,
      );
      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 折算快照。
   *
   * 同币种 → rate=1，不查源（避免无谓的汇率依赖与 M4 一致性风险）。
   * 跨币种 → 查 `SPOT_SELL` 档位；查不到**直接失败**（5006），
   * 不静默退化成 1:1 —— 那会造成账目系统性错误且无人察觉。
   */
  private async snapshotAmount(
    currency: string,
    amountMinor: bigint,
    date: string,
  ): Promise<{ amountBase: bigint; exchangeRate: Decimal | null; rateSource: string }> {
    const cur = currency.toUpperCase();
    if (cur === 'CNY') {
      return { amountBase: amountMinor, exchangeRate: null, rateSource: 'SAME_CURRENCY' };
    }

    const got = await this.o.resolveRate({ base: cur, quote: 'CNY', tier: ACTIVE_RATE_TIER, date });
    if (!got) {
      throw new AppError(
        ErrorCode.FX_SOURCE_MISCONFIGURED,
        `缺少 ${cur}/CNY 的 ${ACTIVE_RATE_TIER} 汇率（${date}），无法完成折算`,
      );
    }

    // convertToBase 语义：amount / rate（rate 是「1 外币 = ? 本币」的现钞卖出价的反比处理）
    const rate = new Decimal(got.rate);
    if (!rate.isFinite() || rate.isZero() || rate.isNegative()) {
      throw new AppError(ErrorCode.FX_SOURCE_MISCONFIGURED, `汇率非法：${got.rate}`);
    }
    const baseFloat = new Decimal(amountMinor.toString()).div(rate);
    const amountBase = BigInt(baseFloat.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));

    return { amountBase, exchangeRate: rate, rateSource: got.source };
  }

  /** 以落库的 amount_base 为锚，反算展示币种（不查汇率） */
  private displayConvert(e: Row, display: string): { amount: string; derived: boolean } {
    const base = (e['amountBase'] ?? null) as bigint | null;
    const rate =
      e['exchangeRate'] === null || e['exchangeRate'] === undefined
        ? null
        : new Decimal(decimalString(e['exchangeRate']));
    if (base === null) return { amount: String(e['amount']), derived: false };
    if (display === 'CNY')
      return { amount: base.toString(), derived: String(e['currency']) !== 'CNY' };
    if (rate === null) return { amount: base.toString(), derived: false };
    const conv = new Decimal(base.toString()).times(rate);
    return { amount: conv.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0), derived: true };
  }

  /** 汇总时把一条记录折算到展示币种（用快照锚点） */
  private baseOf(e: Row, display: string): bigint {
    const base = (e['amountBase'] ?? null) as bigint | null;
    if (base !== null) {
      if (display === 'CNY') return base;
      const rate =
        e['exchangeRate'] === null || e['exchangeRate'] === undefined
          ? null
          : new Decimal(decimalString(e['exchangeRate']));
      if (rate === null) return base;
      return BigInt(
        new Decimal(base.toString())
          .times(rate)
          .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
          .toFixed(0),
      );
    }
    return (e['amount'] ?? 0n) as bigint;
  }

  private async visibleTripIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('tripMember', {
      where: { userId, deletedAt: null },
    });
    const managed = await this.o.ctx.read.findMany('tripMember', {
      where: { managedBy: userId, deletedAt: null },
    });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['tripId'] as bigint);
    for (const m of managed) s.add(m['tripId'] as bigint);
    return s;
  }

  private async assertTripWritable(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const m = await tx.db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (m) {
      if (m['accessLevel'] === 'HISTORICAL_READONLY') {
        throw new AppError(ErrorCode.FORBIDDEN, '该出行已归档，仅可查看');
      }
      return;
    }
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async assertLeaderOrCreator(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const leader = await tx.db.findUnique('tripMember', {
      tripId: t['id'],
      userId,
      role: 'LEADER',
      deletedAt: null,
    });
    if (leader) return;
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.FORBIDDEN, '仅主导者可执行该操作');
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    familyId: bigint | null,
    tripId: bigint | null,
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId,
      tripId,
      op,
      changedAt: at,
      createdAt: at,
    });
  }
}

function push<K>(m: Map<K, bigint[]>, k: K, v: bigint): void {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

/**
 * 读 DECIMAL 列并归一化成十进制字符串。
 *
 * ⚠️ 三条信息来源都可能出现，且不能混：
 *   · MySQL DECIMAL → Prisma 默认回 `Decimal` 对象（有 toString）
 *   · 内存驱动 / 快照 → `string`
 *   · 某些驱动 → `number`
 * `String(value)` 对任意对象都能编译通过，但会把 `Decimal` 的内部对象
 * 变成 `"[object Object]"` —— 汇率一旦被这么读出来，后续换算全错。
 * 因此逐类型显式分支。
 */
function decimalString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return '';
  // Prisma.Decimal / decimal.js 实例：`toFixed` 存在且是函数
  if (typeof value === 'object' && typeof (value as { toFixed?: unknown }).toFixed === 'function') {
    return (value as { toFixed(dp: number): string }).toFixed(20);
  }
  return '';
}

function ymd(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // 显式分支：只有 string 才可能已是 yyyy-MM-dd；其余类型走 toKeyString 会抛错，
  // 这里作为「日期列」的容错，非 string 一律返回空串交由上层判定。
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : '';
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

/** 缺省版本号时不强制 CAS，但用当前值继续（由 update 的零行判定兜底） */
function requireVersionOrSkip(raw: unknown, current: unknown): number {
  if (raw === undefined || raw === null) return Number(current ?? 0);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'version 非法');
  return n;
}
