/**
 * 区间日历的纯函数规则（2026-10-22 验收反馈「日历不好选」的回归基线）
 * ============================================================================
 * 这些用例锁的是**交互语义**，不是像素：
 *   · 点第二下晚于起点 = 成立区间；
 *   · 点第二下等于起点 = 单日出行；
 *   · 点第二下早于起点 = 以该天重开（不报错——日历上误点前一格是高频操作）；
 *   · 区间已成立后再点 = 以新起点重开；
 *   · 「共 N 天」含头含尾（10-01 ~ 10-05 = 5 天，不是 4 天）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildMonthCells,
  daysInMonth,
  inclusiveDays,
  nextRangeSelection,
  parseYmd,
  rangeText,
  yearOptionsOf,
} from '../calendar';
import { knownHolidayYears } from '../holidays';

describe('nextRangeSelection · 两次点选语义', () => {
  it('无起点时，点一下即为起点', () => {
    expect(nextRangeSelection('', '', '2026-10-01')).toEqual({ start: '2026-10-01', end: '' });
  });

  it('有起点无终点，点更晚的一天 → 成立区间', () => {
    expect(nextRangeSelection('2026-10-01', '', '2026-10-05')).toEqual({
      start: '2026-10-01',
      end: '2026-10-05',
    });
  });

  it('有起点无终点，点同一天 → 保持单日（终点留空）', () => {
    expect(nextRangeSelection('2026-10-01', '', '2026-10-01')).toEqual({
      start: '2026-10-01',
      end: '',
    });
  });

  it('有起点无终点，点更早的一天 → 以该天为新起点重开（不报错）', () => {
    expect(nextRangeSelection('2026-10-05', '', '2026-10-01')).toEqual({
      start: '2026-10-01',
      end: '',
    });
  });

  it('区间已成立后再点任意一天 → 以该天为新起点重开', () => {
    expect(nextRangeSelection('2026-10-01', '2026-10-05', '2026-11-11')).toEqual({
      start: '2026-11-11',
      end: '',
    });
  });

  it('跨月与跨年边界同样成立（字符串比较不跨界出错）', () => {
    expect(nextRangeSelection('2026-12-30', '', '2027-01-02')).toEqual({
      start: '2026-12-30',
      end: '2027-01-02',
    });
  });
});

describe('inclusiveDays / rangeText · 天数口径', () => {
  it('同一天算 1 天', () => {
    expect(inclusiveDays('2026-10-01', '2026-10-01')).toBe(1);
  });

  it('10-01 到 10-05 是 5 天（含头含尾）', () => {
    expect(inclusiveDays('2026-10-01', '2026-10-05')).toBe(5);
  });

  it('跨年区间天数正确（2026-12-30 ~ 2027-01-02 = 4 天）', () => {
    expect(inclusiveDays('2026-12-30', '2027-01-02')).toBe(4);
  });

  it('非法日期退化为 1 天，不抛异常也不返回 NaN', () => {
    expect(inclusiveDays('', '2026-10-05')).toBe(1);
    expect(inclusiveDays('abc', '2026-10-05')).toBe(1);
  });

  it('rangeText：空 → 空串；只有起点 → 只显示起点；两端 → 带天数', () => {
    expect(rangeText('', '')).toBe('');
    expect(rangeText('2026-10-01', '')).toBe('2026-10-01');
    expect(rangeText('2026-10-01', '2026-10-05')).toBe('2026-10-01 → 2026-10-05 · 5 天');
  });
});

describe('parseYmd / buildMonthCells · 网格构建', () => {
  it('parseYmd 只接受 YYYY-MM-DD，其余返回 null', () => {
    expect(parseYmd('2026-10-01')).toEqual({ y: 2026, m: 10, d: 1 });
    expect(parseYmd('2026-10-1')).toBeNull();
    expect(parseYmd('2026/10/01')).toBeNull();
    expect(parseYmd(undefined)).toBeNull();
  });

  it('网格行数补齐到整周，且当月的号数一个不少', () => {
    for (const [y, m] of [
      [2026, 10],
      [2027, 2],
      [2028, 2], // 闰年
      [2026, 12],
    ] as Array<[number, number]>) {
      const cells = buildMonthCells(y, m);
      expect(cells.length % 7, `${y}-${m} 应为整周`).toBe(0);
      expect(cells.length).toBeGreaterThanOrEqual(35);
      const days = cells.filter((c) => c !== null);
      expect(days).toHaveLength(daysInMonth(y, m));
      expect(days[0]?.day).toBe(1);
      expect(days[days.length - 1]?.day).toBe(daysInMonth(y, m));
    }
  });

  it('闰年 2 月有 29 天', () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
  });
});

describe('yearOptionsOf · 日历年份快捷条', () => {
  it('默认为当前年 ±2，升序且无重复', () => {
    expect(yearOptionsOf(2026)).toEqual([2024, 2025, 2026, 2027, 2028]);
    expect(yearOptionsOf(2027)).toEqual([2025, 2026, 2027, 2028, 2029]);
  });

  it('用户在 2026 年时，2027 必须是一键可达（本次需求的回归点）', () => {
    const options = yearOptionsOf(2026, knownHolidayYears());
    expect(options).toContain(2027);
    expect(options).toContain(2026);
  });

  it('翻到没有数据的年份后，仍能一键回到已收录节假日的年份', () => {
    const options = yearOptionsOf(2030, [2026, 2027]);
    expect(options).toContain(2026);
    expect(options).toContain(2027);
    expect(options).toEqual([...options].sort((a, b) => a - b));
    expect(new Set(options).size).toBe(options.length);
  });

  it('重复值与脏数据被静默丢弃，不会污染 UI', () => {
    expect(yearOptionsOf(2026, [2026, 2026, 2027])).toEqual([2024, 2025, 2026, 2027, 2028]);
    expect(yearOptionsOf(2026, [Number.NaN, 0, 99999, -1, 2027.5])).toEqual([
      2024, 2025, 2026, 2027, 2028,
    ]);
  });

  it('cursorYear 非法时仍返回合法字典年份，不抛错', () => {
    expect(yearOptionsOf(Number.NaN, [2026, 2027])).toEqual([2026, 2027]);
  });
});
