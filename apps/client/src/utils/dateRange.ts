/**
 * 日期文案与计算（纯函数，不依赖 Taro）
 * ============================================================================
 * 🔴 为什么单独成文件：这些函数原先住在 `components/shared.tsx` 里，而那个文件
 *    import 了 `@tarojs/components`，导致单测加载时触发 `ENABLE_INNER_HTML is
 *    not defined`（Taro 编译期常量在 vitest 里不存在）——纯逻辑被组件依赖绑死，
 *    测都测不了。搬到 utils 后既可直接单测，也让组件层只负责渲染。
 *
 * 对外的 `dateRange` / `tripDays` / `shortDate` 仍从 `components/shared` 转出，
 * 现有引用不需要改。
 */

import type { Trip } from '../api/types';

/** 2026-10-01 → 10/01 */
export function shortDate(d?: string | null): string {
  if (!d) return '待定';
  const [, m, day] = d.split('-');
  return m && day ? `${m}/${day}` : d;
}

/** 2026-10-01 → 2026/10/01（不合法时原样返回） */
export function fullDate(d?: string | null): string {
  const v = typeof d === 'string' ? d.trim() : '';
  if (v === '') return '待定';
  return v.length >= 10 ? `${v.slice(0, 4)}/${v.slice(5, 7)}/${v.slice(8, 10)}` : v;
}

/**
 * 日期区间文案：**同年共享年份，跨年两年都写**（2026-10-27 反馈第 4 条）。
 * ============================================================================
 * 用户原话：「行程的时间加上年份，跨年的行程两年都要显示」。
 *
 * 为什么不是「两个日期都带年份」：同年时 `2026/10/22 - 2026/10/25` 第二个年份
 * 是纯冗余，短卡片上会挤成两行。所以：
 *   同年 → `2026/10/22 - 10/25`
 *   跨年 → `2026/12/30 - 2027/01/02`   ← 两年年份都必须出现，否则会被误读成同一年
 * 缺一端时另一端保持完整（`2026/10/22 - 待定`）。
 */
export function formatDateRange(a?: string | null, b?: string | null): string {
  const norm = (v?: string | null): string => (typeof v === 'string' ? v.trim() : '');
  const sa = norm(a);
  const sb = norm(b);

  const year = (v: string): string => (v.length >= 4 ? v.slice(0, 4) : '');

  if (sa === '' && sb === '') return '待定';
  if (sa === '') return `待定 - ${fullDate(sb)}`;
  if (sb === '') return `${fullDate(sa)} - 待定`;

  // 同年：结束日期省略年份
  if (year(sa) === year(sb) && year(sa) !== '') {
    return `${fullDate(sa)} - ${sb.slice(5, 7)}/${sb.slice(8, 10)}`;
  }
  return `${fullDate(sa)} - ${fullDate(sb)}`;
}

/** 含头含尾天数 */
export function tripDays(t: Trip): number {
  if (!t.startDate || !t.endDate) return 0;
  const a = Date.parse(`${t.startDate}T00:00:00Z`);
  const b = Date.parse(`${t.endDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** 出行日期区间文案（带天数） */
export function dateRange(t: Trip): string {
  if (!t.startDate && !t.endDate) return '日期待定';
  const days = tripDays(t);
  const base = formatDateRange(t.startDate, t.endDate);
  return days > 0 ? `${base} · ${days} 天` : base;
}
