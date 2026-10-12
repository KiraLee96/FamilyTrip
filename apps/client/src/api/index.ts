/**
 * API 入口 —— 按环境选择 adapter
 * ============================================================================
 * 规则：
 *   有 `process.env.API_BASE_URL` → 走真后端（http）
 *   否则                         → 走 Mock（原型默认）
 *
 * 这也意味着：`pnpm dev:client` 打开即可看到完整界面，无需后端、无需 MySQL。
 * 切真后端只需在构建时注入 API_BASE_URL（见 config/index.ts 的 defineConstants）。
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
