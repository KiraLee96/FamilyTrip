/**
 * 行值 → 字符串的**显式**归一化（红线级工具）
 * ============================================================================
 * 为什么必须单独抽一个文件、而不是随手写模板字符串：
 *
 *   1. `String(x)` / `` `${x}` `` 对 `object` 走的是 `Object.prototype.toString`，
 *      结果是 `"[object Object]"` —— 编译期不报错、运行期静默错值。
 *      这类写法在「审计日志拼接」「盲索引计算」「缓存 key 组装」里一旦出现，
 *      后果是**同类不同值的行被判成同一行**，属于数据正确性事故。
 *   2. TypeScript 的 `Row = Record<string, unknown>` 让 `row[k]` 天然是
 *      `unknown`，随手拼串就会踩上面那个坑，且任何 lint 都没拦住它。
 *
 * 本文件的契约：**只有这里允许把 unknown 转成 string**，且每个分支都是
 * 确定性的、无歧义的一对一映射。
 *
 * 🔴 不变量：
 *   · `bigint` 走十进制（与 Snowflake 的 JSON 编码一致，禁止走 Number 中间态，
 *     否则 2^53 以上会静默丢精度）。
 *   · `Date` 走 ISO8601 / epoch 双出口，**绝不允许**落到默认 `toString()`
 *     （本地时区格式无法跨端比较、无法进游标）。
 *   · `object` / `symbol` / `function` 一律**显式抛错**，不做任何「兜底字符串化」。
 *     宁可炸在写入点，也不要产出 `"[object Object]"` 这种毒值落库。
 */

/** 可用于 key 的标量集合 */
export type KeyScalar = string | number | bigint | boolean;

/**
 * 行值 → 字符串（严格模式）。遇到不可安全字符串化的类型直接抛错。
 *
 * 用于：主键归一化、唯一键拼装、盲索引入参、缓存键 —— 任何「值即身份」的场景。
 */
export function toKeyString(value: unknown, context = 'value'): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) {
    throw new TypeError(`[row-key] ${context} 为 ${String(value)}，不可用于身份归一化`);
  }
  if (Array.isArray(value)) {
    throw new TypeError(`[row-key] ${context} 是数组，不可用于身份归一化`);
  }
  throw new TypeError(
    `[row-key] ${context} 是 ${typeof value}（${Object.prototype.toString.call(value)}），` +
      `不可安全字符串化；若确需，请显式选字段。`,
  );
}

/**
 * 行值 → 字符串（宽松模式，**仅用于日志 / 报错文案**）。
 *
 * 与 `toKeyString` 的区别：不抛错，对复杂类型返回可读摘要而非 `"[object Object]"`。
 * 禁止用于任何身份归一化 / 盲索引 / 唯一键场景。
 */
export function toDisplayString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === 'object') {
    return `[object:${Object.keys(value).join(',')}]`;
  }
  return `[${typeof value}]`;
}

/**
 * 从行里取主键并归一化成字符串。行主键缺失时抛错 —— 缺主键的行不该存在，
 * 静默用 `"undefined"` 当 key 会让所有缺键行互相覆盖。
 */
export function rowKeyOf(row: Record<string, unknown>, keyField = 'id'): string {
  const raw = row[keyField];
  if (raw === undefined || raw === null) {
    throw new TypeError(`[row-key] 行缺少主键字段 "${keyField}"`);
  }
  return toKeyString(raw, `row.${keyField}`);
}

/**
 * 读行里一个**应当为字符串**的单元格。
 *
 * 非 string 一律返回 `undefined`（视作缺失），**绝不**做 `String(...)` 兜底 ——
 * 否则对象值会变成 `"[object Object]"` 并被当成合法业务值使用。
 * 适用于 VARCHAR / TEXT / ENUM(映射为 TEXT) 列。
 */
export function stringCell(row: Record<string, unknown>, field: string): string | undefined {
  const raw = row[field];
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * 读行里一个 **BIGINT** 列并归一化成 `bigint`。
 *
 * 三种来源都要接：MySQL BIGINT → 驱动可能给 `bigint` / `string` / `number`；
 * 内存驱动 → `bigint`。非整数形态一律抛错，避免 `BigInt("[object Object]")` 之类
 * 的静默 NaN 化（`BigInt` 会直接抛，这里是给出**带字段名**的明确报错）。
 */
export function bigIntCell(row: Record<string, unknown>, field: string): bigint {
  const raw = row[field];
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'string') {
    if (!/^-?\d+$/.test(raw)) {
      throw new TypeError(`[row-key] 行字段 "${field}" 值 "${raw}" 不是合法整数`);
    }
    return BigInt(raw);
  }
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw)) {
      throw new TypeError(`[row-key] 行字段 "${field}" 值 ${raw} 不是整数`);
    }
    return BigInt(raw);
  }
  throw new TypeError(`[row-key] 行字段 "${field}" 为 ${typeof raw}，无法当作 BIGINT 读取`);
}

/** `bigIntCell` 的可空版本：null / undefined → null */
export function bigIntCellOrNull(row: Record<string, unknown>, field: string): bigint | null {
  const raw = row[field];
  if (raw === null || raw === undefined) return null;
  return bigIntCell(row, field);
}
