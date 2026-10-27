/**
 * 假期 / 调休字典（2026-10-27 需求⑤的回归基线）
 * ============================================================================
 * 锁的是**数据口径**与**边界**，不是像素：
 *   · 放假的最后一天算假期（含头含尾），次日不能再标「休」；
 *   · 调休补班日必须标「班」—— 这是用户最容易踩的坑（以为是个普通周末）；
 *   · 跨月的假期区间要能被两个月的月历都查出来（国庆 10/1–10/7 在本月内，
 *     但春节 2/15–2/23 也可能被月份边界切开）；
 *   · 没有数据的年份（如 2027 国办尚未发布）返回 null，**不能抛错**——
 *     日历组件对任何日期都会问一次。
 */

import { describe, expect, it } from 'vitest';

import { dayMarkOf, holidayRangesOfMonth, knownHolidayYears } from '../holidays';

describe('dayMarkOf —— 休假与调休', () => {
  it('假期的首尾都算假期（含头含尾）', () => {
    expect(dayMarkOf('2026-10-01')?.kind).toBe('HOLIDAY');
    expect(dayMarkOf('2026-10-07')?.kind).toBe('HOLIDAY');
    expect(dayMarkOf('2026-10-01')?.name).toBe('国庆节');
  });

  it('假期前一天 / 后一天不是假期', () => {
    expect(dayMarkOf('2026-09-30')).toBeNull();
    expect(dayMarkOf('2026-10-08')).toBeNull();
  });

  it('调休补班的周末标「班」，不标「休」', () => {
    for (const ds of [
      '2026-01-04',
      '2026-02-14',
      '2026-02-28',
      '2026-05-09',
      '2026-09-20',
      '2026-10-10',
    ]) {
      expect(dayMarkOf(ds)?.kind, `${ds} 应为调休上班`).toBe('MAKEUP');
    }
  });

  it('春节 9 天连休（2/15 ~ 2/23）逐日都是假期', () => {
    const days = [
      '2026-02-15',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
      '2026-02-23',
    ];
    for (const ds of days) expect(dayMarkOf(ds)?.name, ds).toBe('春节');
  });

  it('无数据年份返回 null（不抛错）', () => {
    expect(dayMarkOf('2027-10-01')).toBeNull();
    expect(dayMarkOf('2019-01-01')).toBeNull();
  });

  it('非法/空串不会崩', () => {
    expect(dayMarkOf('')).toBeNull();
    expect(dayMarkOf('2026-13-40')).toBeNull();
  });
});

describe('holidayRangesOfMonth —— 月历上方的一句话', () => {
  it('10 月能查到国庆节', () => {
    const list = holidayRangesOfMonth(2026, 10);
    expect(list.map((h) => h.name)).toEqual(['国庆节']);
    expect(list[0]?.from).toBe('2026-10-01');
  });

  it('没有假期的月份返回空数组', () => {
    expect(holidayRangesOfMonth(2026, 3)).toEqual([]);
    expect(holidayRangesOfMonth(2027, 10)).toEqual([]);
  });
});

describe('knownHolidayYears —— 数据到哪一年', () => {
  it('当前内置 2026', () => {
    expect(knownHolidayYears()).toContain(2026);
  });
});
