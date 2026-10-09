/**
 * M2 · 盲索引（Blind Index）
 * ---------------------------------------------------------------------------
 * 关系型栈下，密文列无法建索引，等值检索只能靠盲索引。
 *
 * 🔴 盲索引 4 条硬规则（派发单 §3.1，违反= 越权或数据不一致）：
 *
 *   规则 1  仅用于**等值检索**。不得用于范围查询、排序、模糊匹配。
 *   规则 2  计算式固定 `sha256(低基数字段 + 主键)`，低基数字段必须**全部**参与。
 *   规则 3  命中后**仍走完整鉴权**。盲索引命中 ≠ 有权访问。
 *   规则 4  不得单独建索引。必须与加密列在**同一事务**内写入。
 *
 * 规则 2 的「必须全部参与」是重点：漏掉任一低基数字段，
 * 同一主键在不同租户/家庭下会算出相同摘要，退化为全局唯一值，
 * 跨家庭碰撞即可枚举出他人记录。
 */

import { createHash } from 'node:crypto';
import type { Buffer } from 'node:buffer';
import type { SnowflakeId } from './to-buffer.js';

/** 盲索引列固定 32B（sha256 摘要长度） */
export const BLIND_INDEX_LENGTH = 32;

/** 字段分隔符：选控制字符，避免与业务值里的分隔符混淆 */
const FIELD_SEPARATOR = '';

export interface BlindIndexInput {
  /**
   * 低基数字段 —— 如 `{ familyId, contactType }`。
   * ⛔ 全部必须参与计算；缺一个即破坏规则 2。
   */
  lowCardinality: Record<string, string | number | null | undefined>;
  /** 记录主键 */
  primaryKey: SnowflakeId;
  /** 可选：额外的、必须参与的低基数字段（如租户） */
  extra?: string | number | null;
}

/**
 * 计算盲索引。
 *
 * 固定计算式：
 *   `sha256( join(sortedLowCardKeys, FIELD_SEPARATOR) ‖ FIELD_SEPARATOR ‖ primaryKey )`
 *
 * 键名排序 —— 保证 `familyId` 与 `contactType` 无论以何种顺序传入，
 * 只要键集合相同就得到相同摘要（否则同一逻辑值会出现两个摘要，检索必漏）。
 */
export function computeBlindIndex(input: BlindIndexInput): Buffer {
  const { lowCardinality, primaryKey } = input;

  const parts: string[] = Object.keys(lowCardinality)
    .sort()
    .map((k) => {
      const v = lowCardinality[k];
      if (v === null || v === undefined || v === '') {
        throw new TypeError(
          `盲索引低基数字段 "${k}" 为空。规则 2 要求低基数字段必须全部参与计算，` +
            '否则退化为全局唯一值，可跨家庭枚举。',
        );
      }
      return `${k}=${String(v)}`;
    });

  if (parts.length === 0) {
    throw new TypeError('盲索引至少需要 1 个低基数字段');
  }
  if (primaryKey === null || primaryKey === undefined || primaryKey === '') {
    throw new TypeError('盲索引 primaryKey 不得为空');
  }

  const material = [...parts, String(primaryKey)].join(FIELD_SEPARATOR);
  return createHash('sha256').update(material, 'utf8').digest();
}

/** 盲索引的十六进制形态 —— 用于日志与等值查询参数（不落日志，仅调试） */
export function blindIndexHex(input: BlindIndexInput): string {
  return computeBlindIndex(input).toString('hex');
}

/**
 * 盲索引只能做等值匹配。
 *
 * 本函数是「规则 1」的运行时护栏：任何试图拿盲索引做范围/排序/模糊的调用
 * 都会在此被拒。DAO 层只允许把盲索引传给 Prisma 的 `equals` 过滤。
 */
export type BlindIndexMatcher =
  { kind: 'equals'; value: Buffer } | { kind: 'in'; values: Buffer[] };

export function equals(value: Buffer): BlindIndexMatcher {
  assertLength(value);
  return { kind: 'equals', value };
}

export function inList(values: Buffer[]): BlindIndexMatcher {
  values.forEach(assertLength);
  return { kind: 'in', values };
}

function assertLength(v: Buffer): void {
  if (v.length !== BLIND_INDEX_LENGTH) {
    throw new TypeError(`盲索引必须 ${BLIND_INDEX_LENGTH}B，实际 ${v.length}B`);
  }
}

/** ⛔ 明确拒绝的检索形态，调用即抛 */
export function rejectNonEquality(matcher: string): never {
  throw new Error(
    `盲索引不支持「${matcher}」检索（规则 1：仅等值）。` +
      '范围查询、排序、模糊匹配必须改用明文字段或业务维度列。',
  );
}
