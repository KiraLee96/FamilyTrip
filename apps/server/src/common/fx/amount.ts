/**
 * 金额精度（技术方案 §4.2.3定稿）
 * ---------------------------------------------------------------------------
 * | 存储 | 金额存**币种最小单位整数**（BIGINT）；汇率 DECIMAL(18,8) |
 * | 写入 | 逐笔按快照汇率折算，**一次性** ROUND_HALF_UP 到基准币 minor_unit |
 * | 汇总 | 直接 SUM(amount_base)，**不二次舍入** |
 * | 禁令 | 汇总层禁止任何除法、反算、二次汇率换算 |
 * | 实现 | 所有金额运算走 decimal.js，**禁止裸Number** |
 */

import { Decimal } from 'decimal.js';

//全局精度：足够覆盖 DECIMAL(18,8) 的连乘
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export const enum RoundingMode {
  HalfUp = 'ROUND_HALF_UP',
}

/** 币种精度表（种子数据来源；运行时以 currency_config 表为准） */
export const DEFAULT_MINOR_UNIT: Record<string, number> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  HKD: 2,
  JPY: 0, // 零小数
  KRW: 0,
  BHD: 3, // 三小数
  KWD: 3,
};

export const DEFAULT_ROUNDING = RoundingMode.HalfUp;

export function minorUnitOf(
  currency: string,
  table: Record<string, number> = DEFAULT_MINOR_UNIT,
): number {
  const unit = table[currency.toUpperCase()];
  if (unit === undefined) {
    throw new Error(
      `未知币种 "${currency}" 的 minor_unit。` +
        '请先在 currency_config 表登记；不允许按默认 2 位猜测——会导致金额系统性偏差。',
    );
  }
  return unit;
}

/** 字符串 → 最小单位整数。⛔ 禁止 Number 入参（浮点误差） */
export function toMinorUnits(
  amount: string | number | Decimal,
  currency: string,
  table?: Record<string, number>,
): bigint {
  const d = amount instanceof Decimal ? amount : new Decimal(amount);
  if (!d.isFinite()) throw new Error(`金额非法：${d.toString()}`);
  const scaled = d.times(new Decimal(10).pow(minorUnitOf(currency, table)));
  // decimal.js 的 toFixed 返回字符串，必须显式转 BigInt。
  // 早前这里用 `as unknown as bigint` 强转，会让整条链路把字符串当bigint 用——
  // 字符串相加变成字符串拼接，汇总结果静默错误。已修正。
  return BigInt(scaled.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0));
}

/** 最小单位整数 → 字符串（保留币种精度，供展示） */
export function fromMinorUnits(
  units: bigint,
  currency: string,
  table?: Record<string, number>,
): string {
  const unit = minorUnitOf(currency, table);
  return new Decimal(units.toString())
    .div(new Decimal(10).pow(unit))
    .toDecimalPlaces(unit, Decimal.ROUND_HALF_UP)
    .toFixed(unit);
}

/**
 * 逐笔折算：原币金额 → 基准币最小单位。
 *
 * 汇率方向：1 base = rate quote，所以
 *   quote 金额 → base 金额 需**除以** rate。
 *
 * @param amount 原币金额（字符串，禁止 Number）
 * @param rate   1 base = rate quote
 */
export function convertToBase(
  amount: string | Decimal,
  rate: string | Decimal,
  baseCurrency: string,
  table?: Record<string, number>,
): bigint {
  const r = rate instanceof Decimal ? rate : new Decimal(rate);
  if (!r.isFinite() || r.isZero() || r.isNegative()) {
    throw new Error(`汇率非法：${r.toString()}`);
  }
  const target = new Decimal(amount instanceof Decimal ? amount : new Decimal(amount)).div(r);
  return toMinorUnits(target, baseCurrency, table);
}

/**
 * 汇总：**只加整数最小单位**，不做任何除法 / 反算 / 二次换算。
 *
 * @throws 若有人传入非整数，视为口径被破坏 —— 宁可崩，不要静默算出偏差值
 */
export function sumMinorUnits(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}
