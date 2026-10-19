/**
 * 汇率 hook
 * ============================================================================
 * 一次取「某外币 ↔ 人民币」的当日汇率，之后所有换算都在本地做 ——
 * 汇率是日更快照，输入金额时不该每敲一个字符就打一次接口。
 *
 * 用法：
 * ```tsx
 * const { rate, loading, error, missing, toForeign, toBase } = useFxRate({ quote: 'JPY' });
 * toForeign('368.00');  // → '7672'（人民币 → 日元）
 * toBase('7672');       // → '368.01'（日元 → 人民币）
 * ```
 *
 * 🔴 取不到汇率时 `toForeign/toBase` 返回 `undefined`，**绝不回退 1:1**
 *    —— 与后端「汇率缺失 → amount_base = null」同一条原则。
 */

import { useCallback } from 'react';
import { api } from '../api/index';
import type { FxRate } from '../api/types';
import { cnyToForeign, foreignToCny, todayLocal } from '../utils/fx';
import { useAsync } from './useAsync';

export interface UseFxRateOptions {
  /** 外币代码（ISO 4217，如 JPY / USD / THB） */
  quote: string;
  /** 基准币，默认 CNY */
  base?: string;
  /** 汇率日期，默认本地今天（YYYY-MM-DD） */
  date?: string;
  /** 条件请求：false 时不发请求（如弹窗未打开） */
  enabled?: boolean;
}

export interface UseFxRateResult {
  rate: FxRate | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
  /** 汇率缺失（后端 5006）—— 与「网络失败」区分开，UI 文案不同 */
  missing: boolean;
  /** 人民币 → 外币；无汇率时 undefined */
  toForeign: (amount: string) => string | undefined;
  /** 外币 → 人民币；无汇率时 undefined */
  toBase: (amount: string) => string | undefined;
}

export function useFxRate(options: UseFxRateOptions): UseFxRateResult {
  const base = (options.base ?? 'CNY').toUpperCase();
  const quote = options.quote.toUpperCase();
  const date = options.date ?? todayLocal();
  const enabled = options.enabled ?? true;

  const state = useAsync<FxRate | undefined>(
    async () => (enabled ? api.getFxRate({ base, quote, date }) : undefined),
    [base, quote, date, enabled],
  );

  const rate = state.data;

  const toForeign = useCallback(
    (amount: string): string | undefined => {
      if (rate === undefined) return undefined;
      try {
        return cnyToForeign(amount, rate.rate, rate.quote);
      } catch {
        return undefined;
      }
    },
    [rate],
  );

  const toBase = useCallback(
    (amount: string): string | undefined => {
      if (rate === undefined) return undefined;
      try {
        return foreignToCny(amount, rate.rate);
      } catch {
        return undefined;
      }
    },
    [rate],
  );

  return {
    rate,
    loading: state.loading,
    error: state.error,
    reload: state.reload,
    // useAsync 把 ApiError 拍平成「message（code xxxx）」字符串，
    // 这里按错误码判断，避免再写一套请求逻辑
    missing: state.error !== undefined && state.error.includes('5006'),
    toForeign,
    toBase,
  };
}
