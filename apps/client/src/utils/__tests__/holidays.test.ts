/**
 * 假期 / 调休字典（2026-10-27 需求⑤的回归基线；2026-11-06 补 2027）
 * ============================================================================
 * 锁的是**数据口径**与**边界**，不是像素：
 *   · 放假的最后一天算假期（含头含尾），次日不能再标「休」；
 *   · 调休补班日必须标「班」—— 这是用户最容易踩的坑（以为是个普通周末）；
 *   · 跨月的假期区间要能被两个月的月历都查出来（国庆 10/1–10/7 在本月内，
 *     但春节 2/15–2/23 也可能被月份边界切开）；
 *   · **单日假**（2027 端午 6/9、中秋 9/15）走 `from === to`，不能被吞掉；
 *   · 没有数据的年份（如 2029 国办尚未发布）返回 null，**不能抛错**——
 *     日历组件对任何日期都会问一次。
 *
 * 🔴 每年补数据后，请顺手核一遍这里的「星期几」断言：
 *    国办通知把每个假期都标了星期，抄错一天（比如把 2/13 写成 2/12）
 *    在 UI 上只表现为「少标一天」，靠肉眼极难发现，靠断言一秒暴露。
 */

import { describe, expect, it } from 'vitest';

import { dayMarkOf, holidayRangesOfMonth, knownHolidayYears } from '../holidays';

/** 'YYYY-MM-DD' → 0=周日 … 6=周六（与日历组件的 UTC 口径一致） */
function dowOf(ds: string): number {
  return new Date(`${ds}T00:00:00.000Z`).getUTCDay();
}

describe('dayMarkOf —— 休假与调休（2026）', () => {
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
});

describe('dayMarkOf —— 2027（国办 2026-11-05 通知）', () => {
  it('元旦 1/1–1/3 三天，跨年前一天不标', () => {
    expect(dayMarkOf('2026-12-31')).toBeNull();
    for (const ds of ['2027-01-01', '2027-01-02', '2027-01-03']) {
      expect(dayMarkOf(ds)?.kind, ds).toBe('HOLIDAY');
      expect(dayMarkOf(ds)?.name, ds).toBe('元旦');
    }
    expect(dayMarkOf('2027-01-04')).toBeNull();
  });

  it('春节 2/5（除夕）~2/13 共 9 天，首日就是除夕', () => {
    const days = Array.from({ length: 9 }, (_, i) => `2027-02-${String(5 + i).padStart(2, '0')}`);
    expect(days).toHaveLength(9);
    for (const ds of days) expect(dayMarkOf(ds)?.name, ds).toBe('春节');
    // 边界：2/4 还没放，2/14 是补班
    expect(dayMarkOf('2027-02-04')).toBeNull();
    expect(dayMarkOf('2027-02-14')?.kind).toBe('MAKEUP');
    expect(dayMarkOf('2027-02-15')).toBeNull();
  });

  it('端午 / 中秋是单日假（from === to 也要标出来）', () => {
    expect(dayMarkOf('2027-06-09')).toMatchObject({ kind: 'HOLIDAY', name: '端午节' });
    expect(dayMarkOf('2027-06-08')).toBeNull();
    expect(dayMarkOf('2027-06-10')).toBeNull();

    expect(dayMarkOf('2027-09-15')).toMatchObject({ kind: 'HOLIDAY', name: '中秋节' });
    expect(dayMarkOf('2027-09-14')).toBeNull();
    expect(dayMarkOf('2027-09-16')).toBeNull();
  });

  it('清明 4/3–4/5、劳动 5/1–5/5、国庆 10/1–10/7 的首尾都对得上通知', () => {
    expect(dayMarkOf('2027-04-03')?.name).toBe('清明节');
    expect(dayMarkOf('2027-04-05')?.name).toBe('清明节');
    expect(dayMarkOf('2027-04-06')).toBeNull();

    expect(dayMarkOf('2027-05-01')?.name).toBe('劳动节');
    expect(dayMarkOf('2027-05-05')?.name).toBe('劳动节');
    expect(dayMarkOf('2027-05-06')).toBeNull();

    expect(dayMarkOf('2027-10-01')?.name).toBe('国庆节');
    expect(dayMarkOf('2027-10-07')?.name).toBe('国庆节');
    expect(dayMarkOf('2027-10-08')).toBeNull();
  });

  it('2027 全年 5 个调休日全部标「班」，且都落在周末', () => {
    const makeup = ['2027-01-31', '2027-02-14', '2027-05-08', '2027-09-26', '2027-10-09'];
    for (const ds of makeup) {
      expect(dayMarkOf(ds)?.kind, `${ds} 应为调休上班`).toBe('MAKEUP');
      expect([0, 6], `${ds} 调休日必须落在周末（否则是抄错日期）`).toContain(dowOf(ds));
    }
    // 通知原文：1/31、2/14、9/26 是周日；5/8、10/9 是周六
    expect([dowOf('2027-01-31'), dowOf('2027-02-14'), dowOf('2027-09-26')]).toEqual([0, 0, 0]);
    expect([dowOf('2027-05-08'), dowOf('2027-10-09')]).toEqual([6, 6]);
  });

  it('通知标注的「周几」与数据一致（防抄错一天）', () => {
    expect(dowOf('2027-01-01'), '元旦 1/1 应为周五').toBe(5);
    expect(dowOf('2027-02-05'), '春节 2/5 应为周五（除夕）').toBe(5);
    expect(dowOf('2027-04-03'), '清明 4/3 应为周六').toBe(6);
    expect(dowOf('2027-05-01'), '劳动节 5/1 应为周六').toBe(6);
    expect(dowOf('2027-06-09'), '端午 6/9 应为周三').toBe(3);
    expect(dowOf('2027-09-15'), '中秋 9/15 应为周三').toBe(3);
    expect(dowOf('2027-10-01'), '国庆 10/1 应为周五').toBe(5);
  });
});

describe('dayMarkOf —— 无数据 / 非法输入', () => {
  it('无数据年份返回 null（不抛错）', () => {
    expect(dayMarkOf('2029-10-01')).toBeNull();
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
    expect(holidayRangesOfMonth(2029, 10)).toEqual([]);
  });

  it('2027 单日假返回 from === to（渲染层据此只显示一个日期）', () => {
    const dragon = holidayRangesOfMonth(2027, 6);
    expect(dragon).toHaveLength(1);
    expect(dragon[0]).toMatchObject({ name: '端午节', from: '2027-06-09', to: '2027-06-09' });

    const moon = holidayRangesOfMonth(2027, 9);
    expect(moon[0]).toMatchObject({ name: '中秋节', from: '2027-09-15', to: '2027-09-15' });
  });
});

describe('knownHolidayYears —— 数据到哪一年', () => {
  it('已内置 2026 与 2027，且按年份升序', () => {
    const years = knownHolidayYears();
    expect(years).toContain(2026);
    expect(years).toContain(2027);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(Math.max(...years)).toBeGreaterThanOrEqual(2027);
  });
});
