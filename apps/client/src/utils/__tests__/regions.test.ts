/**
 * 地区数据与检索（2026-10-22 验收反馈「允许用户选择地区」的回归基线）
 * ============================================================================
 * 这里锁三件事：
 *   1. 省份覆盖度（34 个省级行政区，少一个用户就选不到）；
 *   2. 城市 → 省份的反查（用于打开选择器时定位到用户已选目的地所在省）；
 *   3. 搜索排序（搜「大理」时城市命中必须排在整个云南省前面，否则一屏都是无关城市）。
 */

import { describe, expect, it } from 'vitest';

import { PROVINCES, REGIONS, citiesOf, provinceOfCity, searchRegions } from '../regions';

describe('regions · 数据完整性', () => {
  it('覆盖 34 个省级行政区', () => {
    expect(PROVINCES).toHaveLength(34);
  });

  it('每个省至少有一个城市，且省内无重复城市', () => {
    for (const r of REGIONS) {
      expect(r.cities.length, `${r.province} 应有城市`).toBeGreaterThan(0);
      expect(new Set(r.cities).size, `${r.province} 城市不应重复`).toBe(r.cities.length);
    }
  });

  it('典型目的地可查到（覆盖常用出行城市）', () => {
    for (const city of ['大理', '青岛', '西安', '三亚', '喀什', '林芝']) {
      const hit = REGIONS.find((r) => r.cities.includes(city));
      expect(hit, `${city} 应存在于内置表`).toBeDefined();
    }
  });
});

describe('citiesOf / provinceOfCity', () => {
  it('按省取城市', () => {
    expect(citiesOf('云南省')).toContain('大理');
    expect(citiesOf('山东省')).toContain('青岛');
  });

  it('未知省份返回空数组（调用方据此降级，而不是崩）', () => {
    expect(citiesOf('不存在省')).toEqual([]);
  });

  it('城市反查省份', () => {
    expect(provinceOfCity('大理')).toBe('云南省');
    expect(provinceOfCity('青岛')).toBe('山东省');
  });

  it('传入省级名称本身也能反查（直辖市场景）', () => {
    expect(provinceOfCity('北京市')).toBe('北京市');
  });

  it('查不到返回 null', () => {
    expect(provinceOfCity('马里亚纳')).toBeNull();
  });
});

describe('searchRegions · 检索', () => {
  it('空关键词返回空（浏览模式由调用方决定，不在这里兜）', () => {
    expect(searchRegions('')).toEqual([]);
    expect(searchRegions('   ')).toEqual([]);
  });

  it('搜「大理」时城市命中排第一，不被整省结果盖住', () => {
    const hits = searchRegions('大理');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.city).toBe('大理');
    expect(hits[0]?.province).toBe('云南省');
  });

  it('搜省名会带出该省城市（用于「云南」这类模糊输入）', () => {
    const hits = searchRegions('云南');
    expect(hits.some((h) => h.city === '丽江')).toBe(true);
    expect(hits.every((h) => h.province === '云南省')).toBe(true);
  });

  it('搜不到时返回空数组，由界面提供「用原文」兜底', () => {
    expect(searchRegions('zzz不存在')).toEqual([]);
  });
});
