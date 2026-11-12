/**
 * API 基址解析口径（2026-11-12）
 * ============================================================================
 * 锁定这次的决策：**默认全走真后端，不再有开发态 Mock 特例**。
 *
 * 为什么值得单测：这条规则被改回去不会报错、不会崩，只会让开发者工具里
 * 又出现「看起来功能好的假数据」，把真后端的字段缺失盖住 —— 属于静默回归。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_API_BASE_URL, hasBackend, resolveApiBaseUrl } from '../../../config/api-base-url';

describe('resolveApiBaseUrl · 默认连线上后端', () => {
  it('未注入（undefined）→ 线上后端，dev:weapp 也一樣', () => {
    expect(resolveApiBaseUrl(undefined)).toBe('https://api.familytripallinone.cn/api');
  });

  it('线上地址是 https 且带 /api 前缀（http.ts 会在此基础上拼路径）', () => {
    expect(DEFAULT_API_BASE_URL).toMatch(/^https:\/\/.+\/api$/);
  });

  it('显式指定本地/预发地址 → 原样透传', () => {
    expect(resolveApiBaseUrl('http://127.0.0.1:34570/api')).toBe('http://127.0.0.1:34570/api');
  });

  it('显式置空字符串 → 保留空串（Mock 逃生口），不被默认值吃掉', () => {
    expect(resolveApiBaseUrl('')).toBe('');
  });
});

describe('hasBackend · adapter 判定与解析规则一致', () => {
  it('默认地址 → http', () => {
    expect(hasBackend(resolveApiBaseUrl(undefined))).toBe(true);
  });

  it('显式空串 → mock（逃生口仍可用）', () => {
    expect(hasBackend(resolveApiBaseUrl(''))).toBe(false);
  });

  it('本地地址 → http', () => {
    expect(hasBackend(resolveApiBaseUrl('http://127.0.0.1:34570/api'))).toBe(true);
  });
});
