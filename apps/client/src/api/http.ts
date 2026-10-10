/**
 * HTTP API 实现 —— 切换真后端时使用
 * ============================================================================
 * 与 Mock 实现共用 `ApiClient` 接口，界面层零改动即可切换：
 *   设 `VITE_API_BASE_URL=http://127.0.0.1:34570/api` 即走真后端。
 *
 * 契约要点（对齐 apps/server）：
 *   - 路由前缀 `/api`
 *   - 出参恒为信封 `{code,message,data,meta}`，成功失败同形
 *   - 鉴权走 `Authorization: Bearer <token>`
 *   - 写接口需带幂等 `requestId`（后端 TTL 24h 内重复提交返回首次结果）
 */

import { ApiError, unwrap, type ApiClient } from './client';
import type {
  ChecklistItem,
  Envelope,
  Expense,
  ExpenseSummary,
  Family,
  ItineraryItem,
  Trip,
  User,
  Wish,
} from './types';

const BASE =
  (import.meta.env['VITE_API_BASE_URL'] as string | undefined) ?? 'http://127.0.0.1:34570/api';

/** 一次性 requestId（幂等键），后端要求写接口携带 */
function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let token: string | undefined;

export function setToken(t: string | undefined): void {
  token = t;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (method !== 'GET') headers['X-Request-Id'] = newRequestId();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const env = (await res.json()) as Envelope<T>;
  // 信封内 code 才是业务结果；HTTP 状态只作传输层参考
  return unwrap<T>(env);
}

export function createHttpClient(): ApiClient {
  return {
    login: (code) => request<User>('POST', '/auth/login', { code }),
    me: () => request<User>('GET', '/auth/me'),
    listFamilies: () => request<Family[]>('GET', '/families'),
    listTrips: (familyId) =>
      request<Trip[]>('GET', `/trips${familyId ? `?familyId=${familyId}` : ''}`),
    getTrip: (id) => request<Trip>('GET', `/trips/${id}`),
    createTrip: (input) => request<Trip>('POST', '/trips', input),
    listWishes: (familyId) =>
      request<Wish[]>('GET', `/wishes${familyId ? `?familyId=${familyId}` : ''}`),
    voteWish: (id) => request<Wish>('POST', `/wishes/${id}/vote`),
    listItineraries: (tripId) => request<ItineraryItem[]>('GET', `/itineraries?tripId=${tripId}`),
    listChecklist: (scope) =>
      request<ChecklistItem[]>('GET', `/checklists/items${scope ? `?scope=${scope}` : ''}`),
    toggleChecklistItem: (id) => request<ChecklistItem>('POST', `/checklists/items/${id}/toggle`),
    listExpenses: (tripId) => request<Expense[]>('GET', `/expenses?tripId=${tripId}`),
    expenseSummary: (tripId) =>
      request<ExpenseSummary>('GET', `/expenses/summary?tripId=${tripId}`),
  };
}

export { ApiError };
