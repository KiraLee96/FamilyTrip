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
  ApplyTemplateResult,
  AuthSession,
  BatchExpenseResult,
  ChecklistItem,
  ChecklistTemplate,
  ChecklistTemplateItem,
  ConfirmMediaAssetInput,
  Envelope,
  Expense,
  Family,
  FamilyDetail,
  FamilyMember,
  FxRate,
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
  TripDetail,
  TripInvite,
  TripMember,
  TripMemberRole,
  UpdateProfileInput,
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
    // 同行人数：后端 list / detail 都带；老后端没有就不投影，界面据此不显示
    ...(raw['memberCount'] !== undefined && raw['memberCount'] !== null
      ? { memberCount: asNumber(raw['memberCount']) }
      : {}),
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
    // version 供 toggle 的 CAS 回传；老后端不带 version 时缺省（界面按 0 兜底）
    ...(raw['version'] !== undefined && raw['version'] !== null
      ? { version: asNumber(raw['version']) }
      : {}),
    // 数量：后端列 quantity（applyTemplate 从模板带过来）；缺省不投影，界面按 1 处理
    ...(raw['quantity'] !== undefined && raw['quantity'] !== null
      ? { quantity: asNumber(raw['quantity']) || 1 }
      : {}),
    ...(optString(raw['templateId']) !== undefined
      ? { templateId: optString(raw['templateId']) }
      : {}),
  };
}

/**
 * 后端 checklistTemplate 行 → 客户端 ChecklistTemplate。
 *
 * 🔴 条目字段名有两处不一致，必须在这一层吸收（界面只认 `items`）：
 *   · 落库列叫 `itemsJson`（TEXT，JSON 字符串）
 *   · 解析失败/为空时回空数组，绝不让一条脏数据把整页打挂
 *     （历史数据可能是 `[]`、`null` 或手写的非 JSON）
 */
function toChecklistTemplate(raw: Record<string, unknown>): ChecklistTemplate {
  const parsed = parseTemplateItems(raw['itemsJson'] ?? raw['items']);
  const scope = (asString(raw['scope']) || 'SHARED') as ChecklistTemplate['scope'];
  return {
    id: asString(raw['id']),
    familyId: optString(raw['familyId']) ?? null,
    scope,
    ownerId: optString(raw['ownerId']) ?? null,
    name: asString(raw['name']),
    items: parsed,
    version: asNumber(raw['version']),
    ...(optString(raw['updatedAt']) !== undefined
      ? { updatedAt: optString(raw['updatedAt']) }
      : {}),
  };
}

/** itemsJson → ChecklistTemplateItem[]；任何异常形态一律降级为空数组 */
function parseTemplateItems(src: unknown): ChecklistTemplateItem[] {
  let arr: unknown = src;
  if (typeof src === 'string') {
    const t = src.trim();
    if (t === '') return [];
    try {
      arr = JSON.parse(t) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out: ChecklistTemplateItem[] = [];
  for (const it of arr) {
    if (typeof it !== 'object' || it === null) continue;
    const row = it as Record<string, unknown>;
    const name = asString(row['name']).trim();
    if (name === '') continue;
    const q = asNumber(row['quantity']);
    out.push({ name, quantity: q >= 1 ? q : 1 });
  }
  return out;
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
  opts: { retried?: boolean; requestId?: string; allowNullData?: boolean } = {},
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
  // 写路径（DELETE 等无返回体接口）成功时 data 恒为 null，**不能**走 unwrap 的
  // 「data 为空即异常」判据 —— 见 requestVoid 的注释（2026-10-15 修复的删除失效根因）。
  if (opts.allowNullData === true) {
    if (env.code !== 0) throw new ApiError(env.code, env.message);
    return env.data as T;
  }
  return unwrap<T>(env);
}

/**
 * 无返回体的写操作（DELETE）专用：code=0 即成功，**允许 data 为 null**。
 * ============================================================================
 * 🔴 为什么不能写成 `request<null>('DELETE', url)`：
 *    它最终调用 `unwrap()`，而 `unwrap` 把 `env.data === null` 判为异常
 *    （`ApiError(-1, '响应 data 为空')`）。这条判据对「读单个实体」是有效的
 *    （防止后端把 204/空体当成功返回），但 DELETE 的成功响应 `data` **按契约就是 null**。
 *    后果（2026-10-15 用户反馈「行程还是无法删除」的根因）：
 *    真后端模式下 9 个 DELETE 端点全部「服务端已删成功、客户端抛异常」，
 *    界面提示失败且停留在原页；Mock 模式不复现（mock 不经信封），故此前全绿验收漏掉。
 *    回归用例见 `src/api/__tests__/envelope.test.ts`。
 */
async function requestVoid(method: HttpMethod, path: string, body?: unknown): Promise<void> {
  await request<unknown>(method, path, body, { allowNullData: true });
}

/**
 * 批量记账 · 正规通道 —— `POST /expenses/batch`（一次提交，后端逐行返回结果）。
 * ============================================================================
 * 后端信封：`data = { created, failed, results: [{ index, ok, id?, error? }] }`。
 * 这里把「行级结果」投影成界面认的 `{created, failed, errors}`：errors 取失败行
 * 的 message，最多 5 条（100 行全挂时提示框不能被撑爆）。
 */
async function postBatch(
  input: { tripId: string; familyId: string },
  rows: Array<{
    title: string;
    amount: string;
    currency?: string;
    category?: string;
    spentAt?: string;
    note?: string;
  }>,
): Promise<BatchExpenseResult> {
  const r = await request<{
    created?: unknown;
    failed?: unknown;
    results?: Array<{ index: number; ok: boolean; error?: { message?: string } }>;
  }>('POST', '/expenses/batch', {
    tripId: input.tripId,
    familyId: input.familyId,
    requestId: newRequestId(),
    rows: rows.map((row) => ({
      title: row.title,
      amount: row.amount,
      currency: row.currency ?? 'CNY',
      ...(row.category !== undefined ? { category: row.category } : {}),
      ...(row.spentAt !== undefined ? { spentAt: row.spentAt } : {}),
      ...(row.note !== undefined ? { note: row.note } : {}),
    })),
  });

  const results = r.results ?? [];
  const errors = results
    .filter((x) => !x.ok)
    .slice(0, 5)
    .map((x) => {
      const title = rows[x.index]?.title ?? `第 ${x.index + 1} 行`;
      return `${title}：${x.error?.message ?? '写入失败'}`;
    });

  return { created: asNumber(r.created), failed: asNumber(r.failed), errors };
}

/**
 * 批量记账 · 降级通道 —— 逐行 `POST /expenses`。
 * ============================================================================
 * 仅在「后端还没部署批量端点」时走这条（探测到 4040）。串行而非并发：
 * 失败行要能精确归因，且后端有限流，几十个并发写容易半死不活。
 * 🔴 有明确撤销条件，别让它变成常驻双实现（见调用处注释）。
 */
async function postRowByRow(
  input: { tripId: string; familyId: string },
  rows: Array<{
    title: string;
    amount: string;
    currency?: string;
    category?: string;
    spentAt?: string;
    note?: string;
  }>,
): Promise<BatchExpenseResult> {
  let created = 0;
  const errors: string[] = [];
  for (const row of rows) {
    try {
      await request<{ expense: Record<string, unknown> }>('POST', '/expenses', {
        tripId: input.tripId,
        familyId: input.familyId,
        title: row.title,
        amount: row.amount,
        ...(row.currency !== undefined ? { currency: row.currency } : {}),
        ...(row.category !== undefined ? { category: row.category } : {}),
        ...(row.spentAt !== undefined ? { spentAt: row.spentAt } : {}),
        ...(row.note !== undefined ? { note: row.note } : {}),
      });
      created += 1;
    } catch (e: unknown) {
      if (errors.length < 5) {
        errors.push(`${row.title}：${e instanceof Error ? e.message : '写入失败'}`);
      }
    }
  }
  return { created, failed: rows.length - created, errors };
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
    // PATCH /auth/me —— 更新本人资料（昵称 / 头像）。
    // 🔴 信封口径（对照 auth.controller.ts 的 handler）：
    //    data = { user, updatedAt } —— 不是裸 user 对象，必须拆一层再投影；
    //    与 GET /auth/me 的 data = { user } 同形（恰好都是 { user } 包裹）。
    updateMe: async (input: UpdateProfileInput) => {
      const r = await request<{ user: Record<string, unknown> }>('PATCH', '/auth/me', input);
      return toUser(r.user);
    },
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
      await requestVoid('DELETE', `/families/${id}`);
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
      await requestVoid('DELETE', `/families/members/${memberId}`);
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
    /**
     * GET /trips/:id 的完整投影。
     * 🔴 后端一直回 members/myRole/myAccessLevel，是客户端此前只取了 trip
     *    （反馈「加入行程后看不到参与人」的直接原因）。
     */
    getTripDetail: async (id) => {
      const r = await request<{
        trip: Record<string, unknown>;
        members?: Array<Record<string, unknown>>;
        myRole?: unknown;
        myAccessLevel?: unknown;
      }>('GET', `/trips/${id}`);
      const detail: TripDetail = {
        trip: toTrip(r.trip),
        members: (r.members ?? []).map(toTripMember),
        myRole: (optString(r.myRole) as TripMemberRole | undefined) ?? null,
        myAccessLevel: (optString(r.myAccessLevel) as TripAccessLevel | undefined) ?? null,
      };
      return detail;
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
      await requestVoid('DELETE', `/trips/${id}`);
    },
    finishTrip: async (id, version) => {
      // 信封：data = { trip, updatedAt }（见 trip.controller 的 finish handler）
      const r = await request<{ trip: Record<string, unknown> }>('POST', `/trips/${id}/finish`, {
        version,
      });
      return toTrip(r.trip);
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
      await requestVoid('DELETE', `/trips/members/${id}`);
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
    createWish: async (input) => {
      // 服务端 createWishSchema：familyId / tripId / title / description / priority
      const r = await request<{ wish: Record<string, unknown> }>('POST', '/wishes', input);
      return toWish(r.wish);
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
      await requestVoid('DELETE', `/itineraries/${id}`);
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
    toggleChecklistItem: async (id, checked) => {
      // E7 CAS：toggle 必传 {version, checked}。先取当前项拿版本号再投递，
      // 409（version 冲突）由信封上抛，界面据此提示刷新重试。
      // checked 显式传入时直接置位（连点场景：取反会把两次点击抵销）。
      const cur = await request<Record<string, unknown>>('GET', `/checklists/items/${id}`);
      const r = await request<Record<string, unknown>>('POST', `/checklists/items/${id}/toggle`, {
        version: asNumber(cur['version']),
        checked: checked ?? !asBoolean(cur['checked']),
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
      await requestVoid('DELETE', `/checklists/items/${id}`);
    },

    // ---- checklist 模板（长期清单）----
    listChecklistTemplates: async (familyId) => {
      // 后端 handler 返回 { data: { items: [...] } }，不是裸数组
      const r = await request<{ items?: Array<Record<string, unknown>> }>(
        'GET',
        `/checklists/templates${familyId ? `?familyId=${familyId}` : ''}`,
      );
      return (r.items ?? []).map(toChecklistTemplate);
    },
    createChecklistTemplate: async (input) => {
      const r = await request<{ template: Record<string, unknown> }>(
        'POST',
        '/checklists/templates',
        input,
      );
      return toChecklistTemplate(r.template);
    },
    /**
     * PATCH /checklists/templates/:id —— 后端尚未实现（派发单 P0-1）。
     * 这里按最终契约定稿：条目整体替换（items 传数组 = 覆盖），version 走 CAS。
     * 未上线时后端 dispatcher 回 4040「资源不存在」，界面按不可用降级提示。
     */
    updateChecklistTemplate: async (id, input) => {
      const r = await request<{ template: Record<string, unknown> }>(
        'PATCH',
        `/checklists/templates/${id}`,
        input,
      );
      return toChecklistTemplate(r.template);
    },
    /** DELETE /checklists/templates/:id —— 后端尚未实现（派发单 P0-2） */
    deleteChecklistTemplate: async (id) => {
      await requestVoid('DELETE', `/checklists/templates/${id}`);
    },
    applyChecklistTemplate: async (input) => {
      const r = await request<{
        created?: unknown;
        skipped?: unknown;
        alreadyApplied?: unknown;
      }>('POST', '/checklists/templates/apply', input);
      const result: ApplyTemplateResult = {
        created: asNumber(r.created),
        skipped: asNumber(r.skipped),
        alreadyApplied: asBoolean(r.alreadyApplied),
      };
      return result;
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
      await requestVoid('DELETE', `/expenses/${id}`);
    },
    /**
     * 批量记账 —— `POST /expenses/batch` 一次提交（后端 D-2026-10-26-01 P1-1 已上线）。
     * ============================================================================
     * 信封：`data = { created, failed, results: [{ index, ok, id?, error? }] }`。
     * 这里的职责就是把「行级结果」投影成界面认的 `{created, failed, errors}`：
     *   · errors 取失败行的 message，**最多 5 条**（100 行全挂时提示框不能被撑爆）；
     *   · 后端是「部分成功」语义，失败行不回滚已成功行。
     * 幂等：body 带 requestId，后端按 `scope + requestId` 重放首次结果，
     * 弱网重试不会重复记账。
     */
    createExpensesBatch: async (input, rows) => {
      try {
        return await postBatch(input, rows);
      } catch (e: unknown) {
        // 过渡兼容（2026-10-26）：生产后端尚未部署 `POST /expenses/batch`，
        // 探测到 4040「资源不存在」就退回「逐行 POST /expenses」。
        // 🔴 撤销条件：后端部署完成、`POST /expenses/batch` 在生产返回 4010（而非 4040）后，
        //    删掉这个 try/catch 与 postRowByRow 即可 —— 见派发单 D-2026-10-26-03 §6。
        if (!(e instanceof ApiError) || e.code !== 4040) throw e;
        return await postRowByRow(input, rows);
      }
    },

    // ---- fx ----
    // 后端信封：data = { rate }。汇率本身是只读配置，无写接口暴露给客户端
    //（录入走运维 / 服务端人工路径，客户端只读）。
    getFxRate: async (input) => {
      const parts = [
        `base=${encodeURIComponent(input.base)}`,
        `quote=${encodeURIComponent(input.quote)}`,
        `date=${encodeURIComponent(input.date)}`,
      ];
      if (input.tier !== undefined) parts.push(`tier=${input.tier}`);
      if (input.forceRefresh === true) parts.push('forceRefresh=true');
      const r = await request<{ rate: FxRate }>('GET', `/fx/rate?${parts.join('&')}`);
      return r.rate;
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
      await requestVoid('DELETE', `/items/${id}`);
    },

    // ---- media ----
    presignUpload: async (input) => {
      const familyId = await resolveFamilyId();
      return request<PresignUploadResult>('POST', '/media/presign', {
        familyId,
        fileName: input.fileName,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        // purpose 为纯加法字段：老后端 Zod 默认 strip 未知键，忽略后走 MEDIA 路径
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
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
        ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
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
      await requestVoid('DELETE', `/media/${id}`);
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
