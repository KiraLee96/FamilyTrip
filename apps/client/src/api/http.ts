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
  AuthSession,
  ChecklistItem,
  ConfirmMediaAssetInput,
  Envelope,
  Expense,
  Family,
  FamilyDetail,
  FamilyMember,
  ItineraryBlock,
  ItineraryItem,
  Item,
  JoinFamilyResult,
  JoinTripResult,
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  PresignUploadResult,
  TransportMode,
  Trip,
  TripAccessLevel,
  TripInvite,
  TripMember,
  TripMemberRole,
  User,
  Wish,
} from './types';

const BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:34570/api';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** token 持久化 key（A6：与 session.ts 共用，登出/401 时同步清除） */
export const TOKEN_KEY = 'auth_token';

/** 一次性 requestId（幂等键），后端要求写接口携带 */
function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let token: string | undefined;

export function setToken(t: string | undefined): void {
  token = t;
}

/** 登出 / 401 时调用：familyId 兜底缓存必须失效，否则换账号后仍解析到旧家庭 */
export function resetFamilyIdCache(): void {
  familyIdPromise = undefined;
}

/**
 * 401 恢复器（session.ts 注入）：凭证失效时强制静默重登。
 * 注入而非 import：session.ts 反向依赖本模块的 api，避免循环依赖。
 */
let sessionRecoverer: (() => Promise<void>) | undefined;

export function installSessionRecoverer(fn: () => Promise<void>): void {
  sessionRecoverer = fn;
}

/** 单航班重登：并发 401 只触发一次登录，其余请求复用同一 Promise */
let recovering: Promise<void> | undefined;

function recoverSession(): Promise<void> {
  if (sessionRecoverer === undefined) {
    return Promise.reject(new ApiError(401, '登录态已失效'));
  }
  recovering ??= sessionRecoverer().finally(() => {
    recovering = undefined;
  });
  return recovering;
}

/**
 * unknown → string 安全转换（标量直接转，对象/数组一律空串）：
 * 后端 user 行经 serializeRow 后是 Record<string, unknown>，直接 String()
 * 会触发 no-base-to-string 且可能漏出 '[object Object]'。
 */
function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

/**
 * 后端 user 行 → 客户端 User 投影。
 * 后端 serializeRow 后是 Record<string, unknown>（含 openid/status 等富字段），
 * 界面只认 id/nickname/avatarUrl/homeTimezone 四件套，这里做白名单裁剪，
 * 避免把服务端内部字段漏进界面层。
 */
function toUser(raw: Record<string, unknown>): User {
  return {
    id: asString(raw['id']),
    nickname: asString(raw['nickname']),
    ...(typeof raw['avatarUrl'] === 'string' ? { avatarUrl: raw['avatarUrl'] } : {}),
    ...(typeof raw['homeTimezone'] === 'string' ? { homeTimezone: raw['homeTimezone'] } : {}),
  };
}

/**
 * ─── 后端行 → 客户端模型投影（真后端形状适配层） ───
 * 服务端各域返回存储行（bigint 序列化 + 领域字段名 + 日期 ISO 全串），
 * 界面层只认 api/types.ts 的契约模型。适配全部收敛在本实现层：
 * ApiClient 接口签名、mock 实现、页面三者零改动（红线 #1）。
 */

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

function asBoolean(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/** ISO datetime → YYYY-MM-DD（界面日期组件只认短日期） */
function asDate(v: unknown): string | undefined {
  const s = asString(v);
  return s === '' ? undefined : s.slice(0, 10);
}

/** 分 → 元字符串（服务端金额一律最小货币单位整数，避免浮点误差） */
function minorToYuan(v: unknown): string {
  return (asNumber(v) / 100).toFixed(2);
}

/** destinationsJson 等 JSON 字符串列 → 数组 */
function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** 可选字符串：空串归一为 undefined（界面 `field &&` 判断更干净） */
function optString(v: unknown): string | undefined {
  const s = asString(v);
  return s === '' ? undefined : s;
}

/** 可选数字：null/undefined/空串归一为 undefined（区别于 asNumber 的 0 兜底） */
function optNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 安排正文块解析（白名单，容忍旧后端）。
 * ============================================================================
 * · 后端新契约直接回数组 `blocks`；旧后端/历史行回 `blocksJson` 字符串列，
 *   两者都走这里，界面层只见 ItineraryBlock[]。
 * · **白名单投影**：未知 type 与多余字段一律丢弃 —— 服务端将来加新块类型时，
 *   老客户端不会把未理解的块渲染成空白，也不会把内部字段漏进界面层。
 * · 空结果返回 undefined（而非 []），保持「老数据 = 无正文块」的单一口径，
 *   渲染层因此只需判断 `blocks` 是否存在。
 */
function toBlocks(v: unknown): ItineraryBlock[] | undefined {
  const rows = parseJsonArray(v);
  const out: ItineraryBlock[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const type = asString(r['type']);
    const text = asString(r['text']);
    if (type === 'text' || type === 'quote' || type === 'code') {
      if (text === '') continue;
      out.push({ type, text });
    } else if (type === 'link') {
      const url = asString(r['url']);
      if (text === '' || url === '') continue;
      out.push({ type: 'link', text, url });
    } else if (type === 'image') {
      const assetId = optString(r['assetId']);
      const url = optString(r['url']);
      const caption = optString(r['caption']);
      // 既无 assetId 又无 url 的图片块无处取图，直接丢弃（不渲染空占位）
      if (assetId === undefined && url === undefined) continue;
      out.push({
        type: 'image',
        ...(assetId !== undefined ? { assetId } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(caption !== undefined ? { caption } : {}),
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

function toTrip(raw: Record<string, unknown>): Trip {
  return {
    id: asString(raw['id']),
    familyId: asString(raw['familyId']),
    title: asString(raw['title']),
    status: asString(raw['status']) as Trip['status'],
    ...(asDate(raw['startDate']) !== undefined ? { startDate: asDate(raw['startDate']) } : {}),
    ...(asDate(raw['endDate']) !== undefined ? { endDate: asDate(raw['endDate']) } : {}),
    ...(optString(raw['timezone']) !== undefined ? { timezone: optString(raw['timezone']) } : {}),
    destinations: parseJsonArray(raw['destinationsJson']).map((d) => ({
      name: asString((d as Record<string, unknown>)?.['name']),
    })),
    version: asNumber(raw['version']),
  };
}

function toWish(raw: Record<string, unknown>): Wish {
  // 服务端状态机 WANT/PLANNED/DONE/DROPPED → 客户端 OPEN/ADOPTED/ARCHIVED
  const statusMap: Record<string, Wish['status']> = {
    WANT: 'OPEN',
    PLANNED: 'ADOPTED',
    DONE: 'ADOPTED',
    DROPPED: 'ARCHIVED',
  };
  return {
    id: asString(raw['id']),
    ...(optString(raw['tripId']) !== undefined ? { tripId: optString(raw['tripId']) } : {}),
    familyId: asString(raw['familyId']),
    title: asString(raw['title']),
    ...(optString(raw['description']) !== undefined ? { note: optString(raw['description']) } : {}),
    votes: asNumber(raw['voteCount']),
    votedByMe: asBoolean(raw['myVoted']),
    status: statusMap[asString(raw['status'])] ?? 'OPEN',
  };
}

function toItineraryItem(raw: Record<string, unknown>): ItineraryItem {
  const startAt = asString(raw['startAt']);
  const endAt = optString(raw['endAt']) ?? '';
  const transport = optString(raw['transport']);
  const lat = optNumber(raw['lat']);
  const lng = optNumber(raw['lng']);
  const blocks = toBlocks(raw['blocks'] ?? raw['blocksJson']);
  return {
    id: asString(raw['id']),
    tripId: asString(raw['tripId']),
    date: startAt.slice(0, 10),
    ...(startAt.length >= 16 ? { startTime: startAt.slice(11, 16) } : {}),
    ...(endAt.length >= 16 ? { endTime: endAt.slice(11, 16) } : {}),
    title: asString(raw['title']),
    ...(optString(raw['location']) !== undefined ? { location: optString(raw['location']) } : {}),
    ...(optString(raw['note']) !== undefined ? { note: optString(raw['note']) } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
    sortOrder: asNumber(raw['sort']),
    version: asNumber(raw['version']),
    ...(lat !== undefined ? { lat } : {}),
    ...(lng !== undefined ? { lng } : {}),
    ...(transport !== undefined ? { transport: transport as TransportMode } : {}),
  };
}

function toExpense(raw: Record<string, unknown>): Expense {
  return {
    id: asString(raw['id']),
    tripId: asString(raw['tripId']),
    title: asString(raw['title']),
    amount: minorToYuan(raw['amount']),
    currency: asString(raw['currency']) || 'CNY',
    ...(raw['amountBase'] !== undefined && raw['amountBase'] !== null
      ? { amountCny: minorToYuan(raw['amountBase']) }
      : {}),
    // 服务端行只存 ownerMemberId，未解析成员名；缺省空串由界面兜底
    payerName: asString(raw['payerName']),
    spentAt: asDate(raw['spentAt']) ?? asString(raw['spentAt']),
    ...(optString(raw['category']) !== undefined ? { category: optString(raw['category']) } : {}),
    ...(optString(raw['note']) !== undefined ? { note: optString(raw['note']) } : {}),
  };
}

function toFamily(raw: Record<string, unknown>): Family {
  return {
    id: asString(raw['id']),
    name: asString(raw['name']),
    // 服务端字段名 ownerId；客户端契约 ownerUserId
    ownerUserId: asString(raw['ownerId']),
    memberCount: asNumber(raw['memberCount']) || 1,
    ...(optString(raw['inviteCode']) !== undefined
      ? { inviteCode: optString(raw['inviteCode']) }
      : {}),
  };
}

function toMember(raw: Record<string, unknown>): FamilyMember {
  const userId = raw['userId'];
  const managedBy = raw['managedBy'];
  return {
    id: asString(raw['id']),
    familyId: asString(raw['familyId']),
    userId: userId === null || userId === undefined ? null : asString(userId),
    role: (asString(raw['role']) || 'MEMBER') as FamilyMember['role'],
    isVirtual: asBoolean(raw['isVirtual']),
    managedBy: managedBy === null || managedBy === undefined ? null : asString(managedBy),
    displayName: asString(raw['displayName']),
    joinedAt: asString(raw['joinedAt']),
  };
}

/** 后端 tripMember 行 → 客户端 TripMember（对齐 MEMBER_BIGINT_FIELDS 序列化） */
function toTripMember(raw: Record<string, unknown>): TripMember {
  const userId = raw['userId'];
  const managedBy = raw['managedBy'];
  return {
    id: asString(raw['id']),
    tripId: asString(raw['tripId']),
    userId: userId === null || userId === undefined ? null : asString(userId),
    role: (asString(raw['role']) || 'MEMBER') as TripMemberRole,
    isExternal: asBoolean(raw['isExternal']),
    accessLevel: (asString(raw['accessLevel']) || 'ACTIVE') as TripAccessLevel,
    displayName: asString(raw['displayName']),
    managedBy: managedBy === null || managedBy === undefined ? null : asString(managedBy),
    joinedAt: asString(raw['joinedAt']),
  };
}

/** 后端行程邀请码行 → 客户端 TripInvite */
function toTripInvite(raw: Record<string, unknown>): TripInvite {
  return {
    tripId: asString(raw['tripId']),
    inviteCode: asString(raw['inviteCode']),
    updatedAt: asString(raw['updatedAt']),
  };
}

function toItem(raw: Record<string, unknown>): Item {
  return {
    id: asString(raw['id']),
    familyId: asString(raw['familyId']),
    name: asString(raw['name']),
    ...(optString(raw['category']) !== undefined ? { category: optString(raw['category']) } : {}),
    quantity: asNumber(raw['quantity']) || 1,
    ...(optString(raw['note']) !== undefined ? { note: optString(raw['note']) } : {}),
    version: asNumber(raw['version']),
  };
}

function toChecklistItem(raw: Record<string, unknown>): ChecklistItem {
  // 服务端行同时带 name/checked（存储字段）与 title/done（别名，后端映射）；
  // 投影时别名优先、存储字段兜底——无论哪边定稿都不破界面
  return {
    id: asString(raw['id']),
    ...(optString(raw['tripId']) !== undefined ? { tripId: optString(raw['tripId']) } : {}),
    scope: (asString(raw['scope']) || 'SHARED') as ChecklistItem['scope'],
    title: asString(raw['title']) || asString(raw['name']),
    done: asBoolean(raw['done']) || asBoolean(raw['checked']),
    ...(optString(raw['assigneeName']) !== undefined
      ? { assigneeName: optString(raw['assigneeName']) }
      : {}),
  };
}

/**
 * 默认家庭 id 解析（media/memory/expense 写接口都要 familyId）。
 *
 * 登录链路（A6）未就位前，按「取家庭列表首个」兜底 —— 单家庭账号的既有假设。
 * A6 落地后改为「当前上下文家庭」，此处换成读登录态即可，接口签名不变。
 * 结果做模块级缓存，避免每次上传都打一遍 /families。
 */
let familyIdPromise: Promise<string> | undefined;

async function resolveFamilyId(): Promise<string> {
  if (familyIdPromise === undefined) {
    familyIdPromise = requestList<Record<string, unknown>>('GET', '/families').then((rows) => {
      const first = rows[0];
      if (!first) throw new ApiError(404, '尚未加入任何家庭');
      return asString(first['id']);
    });
    // 失败不缓存，下次可重试
    familyIdPromise.catch(() => {
      familyIdPromise = undefined;
    });
  }
  return familyIdPromise;
}

/**
 * 列表端点统一拆包：后端 list 信封为 `{items, meta}`。
 * （checklist 域例外——直接回裸数组，见 listChecklist）
 */
async function requestList<T>(method: HttpMethod, path: string): Promise<T[]> {
  const r = await request<{ items: T[] }>(method, path);
  return r.items;
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts: { retried?: boolean; requestId?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // 重试沿用同一 requestId：重试是同一逻辑操作的再次投递，幂等键必须不变
  const requestId = opts.requestId ?? (method !== 'GET' ? newRequestId() : undefined);
  if (requestId) headers['X-Request-Id'] = requestId;

  const res = await Taro.request({
    url: `${BASE}${path}`,
    method,
    header: headers,
    data: body,
  });

  // Taro.request 已按响应 Content-Type 自动解析 JSON
  const env = res.data as Envelope<T>;
  // 凭证失效（4010）/ 过期（4011）：清掉本地 token，静默重登后带新 token 重试一次。
  // 覆盖两种时序：① 冷启动竞态——页面请求早于 bootstrap 登录完成（H5 下子组件
  // effect 先于 App useLaunch 执行，必然发生）；② token 过期。单航班重登 +
  // 每请求至多重试一次，不会打爆后端也不会死循环。
  if ((env.code === 4010 || env.code === 4011) && !opts.retried && path !== '/auth/login') {
    setToken(undefined);
    Taro.removeStorageSync(TOKEN_KEY);
    try {
      await recoverSession();
      return request<T>(method, path, body, { retried: true, requestId });
    } catch {
      // 重登失败：落入下方 unwrap，把 401 抛给界面降级（错误态 + 手动重试入口）
    }
  }
  // 信封内 code 才是业务结果；HTTP 状态只作传输层参考
  return unwrap<T>(env);
}

export function createHttpClient(): ApiClient {
  return {
    login: async (code) => {
      // 后端返回 AuthSession；ApiClient 契约为 User，token 在此层落库
      const session = await request<AuthSession>('POST', '/auth/login', { code });
      setToken(session.token);
      Taro.setStorageSync(TOKEN_KEY, session.token);
      return toUser(session.user as unknown as Record<string, unknown>);
    },
    me: () =>
      request<User>('GET', '/auth/me').then((u) => toUser(u as unknown as Record<string, unknown>)),
    listFamilies: async () => {
      const rows = await requestList<Record<string, unknown>>('GET', '/families');
      return rows.map(toFamily);
    },
    getFamily: async (id) => {
      const r = await request<{
        family: Record<string, unknown>;
        members: Array<Record<string, unknown>>;
      }>('GET', `/families/${id}`);
      const detail: FamilyDetail = { family: toFamily(r.family), members: r.members.map(toMember) };
      return detail;
    },
    createFamily: async (input) => {
      const r = await request<{ family: Record<string, unknown> }>('POST', '/families', input);
      return toFamily(r.family);
    },
    updateFamily: async (id, input) => {
      const r = await request<{ family: Record<string, unknown> }>(
        'PATCH',
        `/families/${id}`,
        input,
      );
      return toFamily(r.family);
    },
    dissolveFamily: async (id) => {
      await request<null>('DELETE', `/families/${id}`);
      // 家庭解散后 familyId 兜底缓存必须失效，否则后续请求仍解析到已解散家庭
      resetFamilyIdCache();
    },
    joinFamily: async (input) => {
      const r = await request<{ family: Record<string, unknown>; alreadyMember: boolean }>(
        'POST',
        '/families/join',
        input,
      );
      const result: JoinFamilyResult = {
        family: toFamily(r.family),
        alreadyMember: asBoolean(r.alreadyMember),
      };
      return result;
    },
    addFamilyMember: async (familyId, input) => {
      const r = await request<{ member: Record<string, unknown> }>(
        'POST',
        `/families/${familyId}/members`,
        input,
      );
      return toMember(r.member);
    },
    removeFamilyMember: async (memberId) => {
      await request<null>('DELETE', `/families/members/${memberId}`);
    },
    listTrips: async (familyId) => {
      const rows = await requestList<Record<string, unknown>>(
        'GET',
        `/trips${familyId ? `?familyId=${familyId}` : ''}`,
      );
      return rows.map(toTrip);
    },
    getTrip: async (id) => {
      const r = await request<{ trip: Record<string, unknown> }>('GET', `/trips/${id}`);
      return toTrip(r.trip);
    },
    createTrip: async (input) => {
      const r = await request<{ trip: Record<string, unknown> }>('POST', '/trips', input);
      return toTrip(r.trip);
    },
    // PATCH /trips/:id —— 服务端早已存在（updateTripSchema，CAS version 必传），
    // 客户端此前缺方法缺入口。
    // 🔴 信封口径（对照 trip.service.ts 的 update 返回值 + controller 的 handler）：
    //    data = { trip, updatedAt }，**不是** 裸 trip 对象 —— 与 GET /trips/:id 同形，
    //    必须拆一层再投影；少拆会得到 id='' 的空行程（页面标题清空且不回显）。
    updateTrip: async (id, input) => {
      const r = await request<{ trip: Record<string, unknown> }>('PATCH', `/trips/${id}`, input);
      return toTrip(r.trip);
    },
    // DELETE /trips/:id —— 服务端早已存在；data 为 null，成功即返回。
    deleteTrip: async (id) => {
      await request<null>('DELETE', `/trips/${id}`);
    },
    addTripMember: async (tripId, input) => {
      // 信封 { member }；家庭成员传 userId，虚拟成员传 displayName+isVirtual+managedBy
      const r = await request<{ member: Record<string, unknown> }>(
        'POST',
        `/trips/${tripId}/members`,
        input,
      );
      return toTripMember(r.member);
    },
    updateTripMember: async (id, input) => {
      const r = await request<{ member: Record<string, unknown> }>(
        'PATCH',
        `/trips/members/${id}`,
        input,
      );
      return toTripMember(r.member);
    },
    removeTripMember: async (id) => {
      await request<null>('DELETE', `/trips/members/${id}`);
    },
    getTripInvite: async (tripId) => {
      // 🆕 新端点（派发单 D-2026-10-14-02）；后端未落地时此处 404，
      // 界面按「邀请功能未就绪」降级展示，不阻塞行程创建主流程
      const r = await request<Record<string, unknown>>('GET', `/trips/${tripId}/invite`);
      return toTripInvite(r);
    },
    resetTripInvite: async (tripId) => {
      const r = await request<Record<string, unknown>>('POST', `/trips/${tripId}/invite/reset`);
      return toTripInvite(r);
    },
    joinTrip: async (input) => {
      // 幂等：已是成员直接返回（alreadyMember=true），不重复插入
      const r = await request<{
        trip: Record<string, unknown>;
        member: Record<string, unknown>;
        alreadyMember: boolean;
      }>('POST', '/trips/join', input);
      const result: JoinTripResult = {
        trip: toTrip(r.trip),
        member: toTripMember(r.member),
        alreadyMember: asBoolean(r.alreadyMember),
      };
      return result;
    },
    listWishes: async (familyId) => {
      const rows = await requestList<Record<string, unknown>>(
        'GET',
        `/wishes${familyId ? `?familyId=${familyId}` : ''}`,
      );
      return rows.map(toWish);
    },
    voteWish: async (id) => {
      // 服务端 vote 幂等（同一用户重复投票只计一次），显式 vote:true
      const r = await request<{ wish: Record<string, unknown> }>('POST', `/wishes/${id}/vote`, {
        vote: true,
      });
      return toWish(r.wish);
    },
    listItineraries: async (tripId) => {
      const rows = await requestList<Record<string, unknown>>(
        'GET',
        `/itineraries?tripId=${tripId}`,
      );
      return rows.map(toItineraryItem);
    },
    createItineraryItem: async (input) => {
      // 后端 create 信封为 { item }；lat/lng/transport 为新增可空字段（老后端忽略未知键）
      const r = await request<{ item: Record<string, unknown> }>('POST', '/itineraries', input);
      return toItineraryItem(r.item);
    },
    updateItineraryItem: async (id, input) => {
      // E7 CAS：version 必传，冲突（409）由信封上抛，界面提示刷新重试
      const r = await request<{ item: Record<string, unknown> }>(
        'PATCH',
        `/itineraries/${id}`,
        input,
      );
      return toItineraryItem(r.item);
    },
    deleteItineraryItem: async (id) => {
      await request<null>('DELETE', `/itineraries/${id}`);
    },
    listChecklist: async (scope) => {
      // checklist 域直接回裸数组（不套 items），逐行投影取 title/done 别名
      const rows = await request<Array<Record<string, unknown>>>(
        'GET',
        `/checklists/items${scope ? `?scope=${scope}` : ''}`,
      );
      return rows.map(toChecklistItem);
    },
    // 后端现已对齐 mock：直接回裸 ChecklistItem（不再包裹 { item }）
    createChecklistItem: async (input) => {
      const r = await request<Record<string, unknown>>('POST', '/checklists/items', input);
      return toChecklistItem(r);
    },
    toggleChecklistItem: async (id) => {
      // E7 CAS：toggle 必传 {version, checked}。先取当前项拿版本号再投递，
      // 409（version 冲突）由信封上抛，界面据此提示刷新重试。
      const cur = await request<Record<string, unknown>>('GET', `/checklists/items/${id}`);
      const r = await request<Record<string, unknown>>('POST', `/checklists/items/${id}/toggle`, {
        version: asNumber(cur['version']),
        checked: !asBoolean(cur['checked']),
      });
      return toChecklistItem(r);
    },
    listTripChecklist: async (tripId, scope) => {
      // checklist 域直接回裸数组（不套 items）；必须带 tripId，否则跨行程全量返回
      const rows = await request<Array<Record<string, unknown>>>(
        'GET',
        `/checklists/items?tripId=${tripId}${scope ? `&scope=${scope}` : ''}`,
      );
      return rows.map(toChecklistItem);
    },
    deleteChecklistItem: async (id) => {
      await request<null>('DELETE', `/checklists/items/${id}`);
    },
    listExpenses: async (tripId) => {
      const rows = await requestList<Record<string, unknown>>('GET', `/expenses?tripId=${tripId}`);
      return rows.map(toExpense);
    },
    expenseSummary: async (tripId) => {
      const r = await request<{
        totalMinor: unknown;
        byOwner?: Array<{ ownerMemberId: unknown; totalMinor: unknown }>;
        byCategory?: Array<{ category: unknown; totalMinor: unknown }>;
      }>('GET', `/expenses/summary?tripId=${tripId}`);
      return {
        totalCny: minorToYuan(r.totalMinor),
        byMember: (r.byOwner ?? []).map((o) => ({
          memberName: asString(o.ownerMemberId) || '未分配',
          amountCny: minorToYuan(o.totalMinor),
        })),
        byCategory: (r.byCategory ?? []).map((c) => ({
          category: asString(c.category) || '未分类',
          amountCny: minorToYuan(c.totalMinor),
        })),
      };
    },
    createExpense: async (input) => {
      // 信封 { expense }；amount 为主单位字符串（后端 toMinorUnits 按币种精度换算）
      const r = await request<{ expense: Record<string, unknown> }>('POST', '/expenses', input);
      return toExpense(r.expense);
    },
    updateExpense: async (id, input) => {
      // version 缺省时服务端 requireVersionOrSkip 跳过 CAS 校验
      const r = await request<{ expense: Record<string, unknown> }>(
        'PATCH',
        `/expenses/${id}`,
        input,
      );
      return toExpense(r.expense);
    },
    deleteExpense: async (id) => {
      await request<null>('DELETE', `/expenses/${id}`);
    },
    listItems: async (query) => {
      // 信封 { items, meta }；mineOnly 服务端默认 true（PRIVATE 短路域只认 ownerId）
      const parts: string[] = [];
      if (query?.category !== undefined)
        parts.push(`category=${encodeURIComponent(query.category)}`);
      if (query?.mineOnly !== undefined) parts.push(`mineOnly=${query.mineOnly}`);
      const qs = parts.length > 0 ? `?${parts.join('&')}` : '';
      const rows = await requestList<Record<string, unknown>>('GET', `/items${qs}`);
      return rows.map(toItem);
    },
    createItem: async (input) => {
      const r = await request<{ item: Record<string, unknown> }>('POST', '/items', input);
      return toItem(r.item);
    },
    updateItem: async (id, input) => {
      // E7 CAS：version 必传，冲突（409）由信封上抛
      const r = await request<{ item: Record<string, unknown> }>('PATCH', `/items/${id}`, input);
      return toItem(r.item);
    },
    deleteItem: async (id) => {
      await request<null>('DELETE', `/items/${id}`);
    },

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
      const r = await requestList<MediaAsset>('GET', `/media?${parts.join('&')}`);
      return r;
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
      const r = await requestList<MemoryArchive>('GET', `/memories?${parts.join('&')}`);
      return r;
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
