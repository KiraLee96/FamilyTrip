import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPageMeta,
  clampPageSize,
  normalizeCursorQuery,
  normalizePageQuery,
  paginateByCursor,
} from './pagination.js';

describe('pagination · clampPageSize', () => {
  it('收敛到 [1, MAX] 区间', () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(10)).toBe(10);
    expect(clampPageSize(MAX_PAGE_SIZE)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(clampPageSize(99999)).toBe(MAX_PAGE_SIZE);
  });

  it('非法输入兜底到默认值', () => {
    expect(clampPageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(null)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize('abc')).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('字符串数字可解析', () => {
    expect(clampPageSize('15')).toBe(15);
    expect(clampPageSize('7.9')).toBe(7);
  });
});

describe('pagination · normalizePageQuery', () => {
  it('计算 skip/take', () => {
    expect(normalizePageQuery(1, 20)).toEqual({ page: 1, pageSize: 20, skip: 0, take: 20 });
    expect(normalizePageQuery(3, 10)).toEqual({ page: 3, pageSize: 10, skip: 20, take: 10 });
  });

  it('非法 page 兜底为 1', () => {
    expect(normalizePageQuery(0, 20).page).toBe(1);
    expect(normalizePageQuery(-3, 20).page).toBe(1);
    expect(normalizePageQuery('x', 20).page).toBe(1);
  });

  it('pageSize 走 clamp', () => {
    expect(normalizePageQuery(1, 100000).take).toBe(MAX_PAGE_SIZE);
    expect(normalizePageQuery(1, undefined).take).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe('pagination · normalizeCursorQuery', () => {
  it('空游标 → null', () => {
    expect(normalizeCursorQuery(undefined).cursor).toBeNull();
    expect(normalizeCursorQuery('').cursor).toBeNull();
    expect(normalizeCursorQuery(123).cursor).toBeNull();
  });

  it('非空字符串游标保留', () => {
    expect(normalizeCursorQuery('abc123').cursor).toBe('abc123');
  });
});

describe('pagination · buildPageMeta', () => {
  it('产出 meta 片段', () => {
    const q = normalizePageQuery(2, 10);
    expect(buildPageMeta(q, 35)).toEqual({ page: 2, pageSize: 10, total: 35 });
  });
});

describe('pagination · paginateByCursor', () => {
  const rows = [1, 2, 3, 4].map((n) => ({ id: `id-${n}` }));

  it('多取一条（take+1）→ 截断并给下一页游标', () => {
    // 期望页大小 3，查询取了 4 条 → 说明还有下一页
    const { items, meta } = paginateByCursor(rows, 3, (r) => r.id);
    expect(items).toHaveLength(3);
    expect(items.map((r) => r.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(meta.cursor).toBe('id-3');
  });

  it('不足 take+1 → 无下一页游标', () => {
    const { items, meta } = paginateByCursor(rows.slice(0, 3), 3, (r) => r.id);
    expect(items).toHaveLength(3);
    expect(meta.cursor).toBeUndefined();
    expect('cursor' in meta).toBe(false);
  });

  it('空结果 → 空数组 + 无游标', () => {
    const empty: { id: string }[] = [];
    const { items, meta } = paginateByCursor(empty, 10, (r) => r.id);
    expect(items).toEqual([]);
    expect(meta.cursor).toBeUndefined();
  });
});
