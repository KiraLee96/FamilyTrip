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
  ConfirmMediaAssetInput,
  Envelope,
  Expense,
  ExpenseSummary,
  Family,
  ItineraryItem,
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  PresignUploadResult,
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

/**
 * 默认家庭 id 解析（media/memory 写接口都要 familyId）。
 *
 * 登录链路（A6）未就位前，按「取家庭列表首个」兜底 —— 单家庭账号的既有假设。
 * A6 落地后改为「当前上下文家庭」，此处换成读登录态即可，接口签名不变。
 * 结果做模块级缓存，避免每次上传都打一遍 /families。
 */
let familyIdPromise: Promise<string> | undefined;

async function resolveFamilyId(): Promise<string> {
  if (familyIdPromise === undefined) {
    familyIdPromise = request<Family[]>('GET', '/families').then((list) => {
      const first = list[0];
      if (!first) throw new ApiError(404, '尚未加入任何家庭');
      return first.id;
    });
    // 失败不缓存，下次可重试
    familyIdPromise.catch(() => {
      familyIdPromise = undefined;
    });
  }
  return familyIdPromise;
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

    // ---- media ----
    presignUpload: async (input) => {
      const familyId = await resolveFamilyId();
      return request<PresignUploadResult>('POST', '/media/presign', {
        familyId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
      });
    },
    confirmMediaAsset: async (input: ConfirmMediaAssetInput) => {
      const familyId = await resolveFamilyId();
      // compressed：chooseImage 以 compressed 尺寸取图；exifStripped/hadGps 前端
      // 无法确认，保守按未剥离/未检测登记（hadGps && !exifStripped 才会触发
      // 服务端审计 ALERT；真联调时如需服务端兜底剥离再调 /media/strip-exif）。
      const body = {
        familyId,
        ...(input.tripId !== undefined ? { tripId: input.tripId } : {}),
        fileKey: input.fileKey,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        compressed: true,
        exifStripped: false,
        hadGps: false,
        storageClass: 'STANDARD',
        ...(input.width !== undefined ? { width: input.width } : {}),
        ...(input.height !== undefined ? { height: input.height } : {}),
      };
      const r = await request<{ asset: MediaAsset }>('POST', '/media/confirm', body);
      return r.asset;
    },
    listMedia: async (query) => {
      const familyId = await resolveFamilyId();
      // 手写 query 串（不用 URLSearchParams —— 小程序端兼容性更稳）
      const parts = [`familyId=${familyId}`];
      if (query?.tripId !== undefined) parts.push(`tripId=${query.tripId}`);
      if (query?.mimePrefix !== undefined) parts.push(`mimePrefix=${query.mimePrefix}`);
      if (query?.page !== undefined) parts.push(`page=${query.page}`);
      if (query?.pageSize !== undefined) parts.push(`pageSize=${query.pageSize}`);
      const r = await request<{ items: MediaAsset[]; meta: unknown }>(
        'GET',
        `/media?${parts.join('&')}`,
      );
      return r.items;
    },
    deleteMediaAsset: async (id) => {
      await request<null>('DELETE', `/media/${id}`);
    },

    // ---- memory ----
    listMemories: async (query) => {
      const familyId = await resolveFamilyId();
      const parts = [`familyId=${familyId}`];
      if (query?.type !== undefined) parts.push(`type=${query.type}`);
      if (query?.year !== undefined) parts.push(`year=${query.year}`);
      const r = await request<{ items: MemoryArchive[]; meta: unknown }>(
        'GET',
        `/memories?${parts.join('&')}`,
      );
      return r.items;
    },
    getMemory: (id) =>
      request<{ memory: MemoryArchive; snapshot: MemorySnapshot }>('GET', `/memories/${id}`),
    generateTripMemory: (tripId) =>
      request<{ memory: MemoryArchive; snapshot: MemorySnapshot; created: boolean }>(
        'POST',
        '/memories/generate-trip',
        { tripId, rebuild: false },
      ),
    generateAnnualMemory: async (year) => {
      const familyId = await resolveFamilyId();
      return request<{ memory: MemoryArchive; snapshot: MemorySnapshot; created: boolean }>(
        'POST',
        '/memories/generate-annual',
        { familyId, year, rebuild: false },
      );
    },
  };
}

export { ApiError };
