/**
 * API 入口 —— 按环境选择 adapter
 * ============================================================================
 * 规则：
 *   `process.env.API_BASE_URL` 非空 → 走真后端（http）
 *   显式为空字符串                 → 走 Mock（逃生口）
 *
 * 🔴 2026-11-12：`config/index.ts` 已把默认值改成线上后端，**所有构建默认走 http**，
 *    不再有「dev:weapp 自动落 Mock」的特例。示例数据会掩盖真实链路问题
 *    （昵称/称呼那次就是 Mock 正常、真后端白名单漏字段，排查被带偏）。
 *
 * 需要离线原型演示时，构建命令显式置空：`API_BASE_URL= pnpm dev:weapp`。
 * 判定仍用 `Boolean(...)`：与 `config/api-base-url.ts` 的 `??` 配合，
 * 空串不会被替换成默认地址，Mock 通道得以保留。
 */

import { createMockClient } from './mock';
import { createHttpClient } from './http';
import type { ApiClient } from './client';

const hasBackend = Boolean(process.env.API_BASE_URL);

/** 当前使用的数据源（界面右上角会显示，便于一眼区分 Mock / 真后端） */
export const DATA_SOURCE: 'mock' | 'http' = hasBackend ? 'http' : 'mock';

export const api: ApiClient = hasBackend ? createHttpClient() : createMockClient();

export { ApiError, type ApiClient } from './client';
export * from './types';
