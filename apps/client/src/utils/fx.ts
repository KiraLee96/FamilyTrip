/**
 * 汇率换算（前端展示精度）
 * ============================================================================
 * 🔴 定位：**只做界面展示**。真正落库的金额折算走服务端
 *    `POST /fx/convert-batch`（decimal.js + 最小货币单位整数），
 *    这里不参与任何记账写路径。
 *
 * 为什么不用 `Number(amount) * Number(rate)`：
 *   0.1 + 0.2 那套老问题会在「20.85 × 368.00」这类换算上直接露头，
 *   界面显示 7672.800000000001 比显示错误更让人不信任。所以这里用
 *   BigInt 定点运算，内部统一 12 位小数（覆盖 DECIMAL(18,8) 的汇率）。
 */

/** 内部运算精度（小数位） */
const SCALE = 12;
const SCALE_DIGITS = 10n ** BigInt(SCALE);

/**
 * 币种小数位。
 * 与后端 `common/fx/amount.ts` 的 DEFAULT_MINOR_UNIT 对齐；
 * 差异点：后端遇未知币种**抛错**（怕系统性偏差），前端只展示、不落库，
 * 故回落 2 位 —— 抛错会让整块 UI 白屏，代价不成比例。
 */
const MINOR_UNIT: Record<string, number> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  HKD: 2,
  SGD: 2,
  AUD: 2,
  THB: 2,
  MYR: 2,
  TWD: 2,
  JPY: 0,
  KRW: 0,
  VND: 0,
  BHD: 3,
  KWD: 3,
};

export function minorUnitOf(currency: string): number {
  return MINOR_UNIT[currency.toUpperCase()] ?? 2;
}

/** 十进制字符串 → 指定精度的定点整数（超出的位数四舍五入） */
function parseFixed(input: string, digits: number): bigint {
  const text = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`金额 / 汇率格式非法：${input}`);
  }
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const [intPart = '0', fracPart = ''] = body.split('.');
  const frac = (fracPart + '0'.repeat(digits)).slice(0, digits);
  const value = BigInt(intPart) * 10n ** BigInt(digits) + BigInt(frac === '' ? '0' : frac);
  return negative ? -value : value;
}

/** 定点整数 → 十进制字符串（保留固定小数位） */
function formatFixed(value: bigint, digits: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(digits);
  const intPart = abs / base;
  const fracPart = abs % base;
  const frac = digits === 0 ? '' : `.${fracPart.toString().padStart(digits, '0')}`;
  return `${negative ? '-' : ''}${intPart.toString()}${frac}`;
}

/** 正数除法四舍五入（ROUND_HALF_UP），与后端 decimal.js 配置一致 */
function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('除数必须为正');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const quotient = abs / denominator;
  const remainder = abs % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** 把 12 位定点值按目标币种精度输出 */
function toCurrencyString(value12: bigint, currency: string): string {
  const digits = minorUnitOf(currency);
  const scaled = divRound(value12, 10n ** BigInt(SCALE - digits));
  return formatFixed(scaled, digits);
}

/**
 * 基准币（人民币）→ 外币。
 *
 * @param amount 人民币金额，如 "368.00"
 * @param rate   `1 base = rate quote`
 * @param currency 外币代码（决定结果小数位，如 JPY 为 0 位）
 *
 * @example cnyToForeign('368.00', '20.85000000', 'JPY') // '7672'
 */
export function cnyToForeign(amount: string, rate: string, currency: string): string {
  const a = parseFixed(amount, SCALE);
  const r = parseFixed(rate, SCALE);
  if (r <= 0n) throw new Error(`汇率必须大于 0：${rate}`);
  return toCurrencyString(divRound(a * r, SCALE_DIGITS), currency);
}

/**
 * 外币 → 基准币（人民币）。
 *
 * 不需要传外币代码：入参按字符串精确解析（不做币种精度截断），
 * 输出固定人民币 2 位小数。外币精度只影响「能输入几位」，
 * 那是输入控件的事，不该在这一层静默截断用户填的值。
 *
 * @param amount 外币金额，如 "7672"
 * @param rate   `1 base = rate quote`
 *
 * @example foreignToCny('7672', '20.85000000') // '368.01'
 */
export function foreignToCny(amount: string, rate: string): string {
  const a = parseFixed(amount, SCALE);
  const r = parseFixed(rate, SCALE);
  if (r <= 0n) throw new Error(`汇率必须大于 0：${rate}`);
  return toCurrencyString(divRound(a * SCALE_DIGITS, r), 'CNY');
}

/** 汇率展示：去掉尾随零，最多 4 位（"20.85000000" → "20.85"） */
export function formatRate(rate: string): string {
  const [intPart = '0', fracPart = ''] = rate.split('.');
  const frac = fracPart.slice(0, 4).replace(/0+$/, '');
  return frac === '' ? intPart : `${intPart}.${frac}`;
}

/** 本地时区的今天（YYYY-MM-DD）—— 与后端 rateDate 口径一致 */
export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
