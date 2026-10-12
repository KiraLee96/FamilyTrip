/**
 * HTTP API 实现 —— 切换真后端时使用（Taro 同构版）
 * ============================================================================
 * 与 Mock 实现共用 `ApiClient` 接口，界面层零改动即可切换。
 * 唯一改动：网络层从浏览器原生 `fetch` 换成 Taro 的 `Taro.request`，
 * 这样同一份代码在小程序（wx.request）与 H5 下都能跑，无需 fork。
 *
 * 契约要点（对齐 apps/server）：
 *   - 路由前缀 `/api`
 *   - 出参恒为信封 `{code,message,data,meta}`，成功失败同形
 *   - 鉴权走 `Authorization: Bearer <token>`
 *   - 写接口需带幂等 `requestId`（后端 TTL 24h 内重复提交返回首次结果）
 *
 * 数据源切换：构建时通过 `process.env.API_BASE_URL` 注入
 *   （见 config/index.ts 的 defineConstants）；为空走 Mock。
 */

import Taro from '@tarojs/taro';
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

const BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:34570/api';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** 一次性 requestId（幂等键），后端要求写接口携带 */
function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let token: string | undefined;

export function setToken(t: string | undefined): void {
  token = t;
}

async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (method !== 'GET') headers['X-Request-Id'] = newRequestId();

  const res = await Taro.request({
    url: `${BASE}${path}`,
    method,
    header: headers,
    data: body,
  });

  // Taro.request 已按响应 Content-Type 自动解析 JSON
  const env = res.data as Envelope<T>;
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
    // 后端返回 { item }；item 行字段为 name/checked/quantity/scope（与 listChecklist
    // 同样存在既有字段差异），真联调时与 list 走同一适配层，本次不扩散处理
    createChecklistItem: (input) =>
      request<{ item: ChecklistItem }>('POST', '/checklists/items', input).then((r) => r.item),
    toggleChecklistItem: (id) => request<ChecklistItem>('POST', `/checklists/items/${id}/toggle`),
    listExpenses: (tripId) => request<Expense[]>('GET', `/expenses?tripId=${tripId}`),
    expenseSummary: (tripId) =>
      request<ExpenseSummary>('GET', `/expenses/summary?tripId=${tripId}`),
  };
}

export { ApiError };
