/**
 * 日期区间文案单测（2026-10-27 反馈第 4 条）
 * ============================================================================
 * 需求原话：「行程的时间加上年份，跨年的行程两年都要显示」。
 * 这两个变体（同年省略第二个年份 / 跨年两个年份都写）必须被锁住 ——
 * 它们属于「看着对但容易写错」的格式化逻辑，改一次就容易回归。
 *
 * 🔴 直接测 utils/dateRange，不经 components/shared：
 *    后者 import 了 @tarojs/components，vitest 里会炸 `ENABLE_INNER_HTML is not defined`。
 */

import { describe, expect, it } from 'vitest';

import { dateRange, formatDateRange, tripDays } from '../dateRange';
import type { Trip } from '../../api/types';

describe('formatDateRange 同年', () => {
  it('同年只在开始写年份，结束省略', () => {
    expect(formatDateRange('2026-10-22', '2026-10-25')).toBe('2026/10/22 - 10/25');
  });

  it('单天行程也成立', () => {
    expect(formatDateRange('2026-05-01', '2026-05-01')).toBe('2026/05/01 - 05/01');
  });
});

describe('formatDateRange 跨年', () => {
  it('跨年两个年份都要出现（否则会被误读成同一年）', () => {
    expect(formatDateRange('2026-12-30', '2027-01-02')).toBe('2026/12/30 - 2027/01/02');
  });

  it('跨年且只差一天也照样写两年', () => {
    expect(formatDateRange('2026-12-31', '2027-01-01')).toBe('2026/12/31 - 2027/01/01');
  });
});

describe('formatDateRange 缺一端', () => {
  it('只有开始', () => {
    expect(formatDateRange('2026-10-22', null)).toBe('2026/10/22 - 待定');
  });

  it('只有结束', () => {
    expect(formatDateRange(undefined, '2027-01-02')).toBe('待定 - 2027/01/02');
  });

  it('两端都空', () => {
    expect(formatDateRange(undefined, null)).toBe('待定');
  });
});

describe('dateRange 带天数', () => {
  const base = {
    id: '1',
    title: 't',
    status: 'PLANNED',
    version: 0,
  } as unknown as Trip;

  it('同年行程带天数', () => {
    const t = { ...base, startDate: '2026-10-22', endDate: '2026-10-25' } as Trip;
    expect(dateRange(t)).toBe('2026/10/22 - 10/25 · 4 天');
  });

  it('跨年行程带天数且两年可见', () => {
    const t = { ...base, startDate: '2026-12-30', endDate: '2027-01-02' } as Trip;
    expect(dateRange(t)).toBe('2026/12/30 - 2027/01/02 · 4 天');
  });

  it('无日期时给「日期待定」而不是空串', () => {
    expect(dateRange(base)).toBe('日期待定');
  });
});

describe('tripDays 天数', () => {
  it('含头含尾', () => {
    const t = { startDate: '2026-10-22', endDate: '2026-10-25' } as Trip;
    expect(tripDays(t)).toBe(4);
  });

  it('跨年不会算错', () => {
    const t = { startDate: '2026-12-30', endDate: '2027-01-02' } as Trip;
    expect(tripDays(t)).toBe(4);
  });

  it('缺日期返回 0', () => {
    expect(tripDays({} as Trip)).toBe(0);
  });
});
