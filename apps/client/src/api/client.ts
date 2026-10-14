/**
 * API 客户端 —— 可切换 adapter
 * ============================================================================
 * 设计要点（🔴 这是整个原型最重要的架构决定）：
 *
 *   界面层只依赖 `ApiClient` 接口，不关心数据从哪来。
 *   于是「Mock 数据」与「真实后端」是同一条接口的两个实现：
 *     - `createMockClient()`  —— 原型阶段，浏览器直接看效果
 *     - `createHttpClient()`  —— 切真后端，改一个环境变量即可
 *
 *   这样界面代码零改动就能从 Mock 切到真后端，
 *   且信封解析、错误码处理逻辑在两处完全一致。
 *
 *   后端真实契约：路由前缀 `/api`，信封 `{code,message,data,meta}`。
 *   99 条路由清单见 apps/server/src/domains/* /*.controller.ts。
 */

import type {
  ChecklistItem,
  ConfirmMediaAssetInput,
  Expense,
  ExpenseSummary,
  Family,
  FamilyDetail,
  FamilyMember,
  ItineraryItem,
  Item,
  JoinFamilyResult,
  JoinTripResult,
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  MemoryType,
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

/** 业务错误（携带后端错误码，供界面分支处理） */
export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * 客户端接口 —— 界面层唯一依赖。
 * 方法名与后端路由一一对应，便于对照排查。
 */
export interface ApiClient {
  // ---- auth ----
  /** POST /auth/login */
  login(code: string): Promise<User>;
  /** GET /auth/me */
  me(): Promise<User>;

  // ---- family ----
  /** GET /families */
  listFamilies(): Promise<Family[]>;
  /** GET /families/:id（家庭 + 成员列表；family 行带 inviteCode） */
  getFamily(id: string): Promise<FamilyDetail>;
  /** POST /families（创建者自动成为户主） */
  createFamily(input: { name: string; timezone?: string }): Promise<Family>;
  /** PATCH /families/:id（改名/换时区，仅户主） */
  updateFamily(id: string, input: { name?: string; timezone?: string }): Promise<Family>;
  /** DELETE /families/:id（解散家庭，仅户主） */
  dissolveFamily(id: string): Promise<void>;
  /** POST /families/join（凭邀请码加入） */
  joinFamily(input: { inviteCode: string; displayName?: string }): Promise<JoinFamilyResult>;
  /** POST /families/:id/members（新增成员；无微信账号的家人用虚拟成员 displayName） */
  addFamilyMember(
    familyId: string,
    input: { displayName: string; isVirtual?: boolean },
  ): Promise<FamilyMember>;
  /** DELETE /families/members/:id（移除成员；本人即退出） */
  removeFamilyMember(memberId: string): Promise<void>;

  // ---- trip ----
  /** GET /trips */
  listTrips(familyId?: string): Promise<Trip[]>;
  /** GET /trips/:id */
  getTrip(id: string): Promise<Trip>;
  /** POST /trips */
  createTrip(input: {
    familyId: string;
    title: string;
    startDate?: string;
    endDate?: string;
  }): Promise<Trip>;
  /**
   * POST /trips/:id/members —— 加出行成员（PRD GRP-02：创建行程时可邀请
   * 家庭成员或外部用户）。家庭成员传 userId；无账号家人（虚拟成员）传
   * displayName + isVirtual + managedBy（代管人 memberId）。
   * 🔴 role 经本接口只能是 MEMBER，设主导者走 setLeader（后端 403 拒绝）。
   */
  addTripMember(
    tripId: string,
    input: {
      userId?: string;
      displayName?: string;
      isVirtual?: boolean;
      /** 外部同行者（如朋友），不属家庭 */
      isExternal?: boolean;
      role?: TripMemberRole;
      managedBy?: string;
      accessLevel?: TripAccessLevel;
    },
  ): Promise<TripMember>;
  /** PATCH /trips/members/:id（改角色/访问级别/昵称/代管；仅主导者） */
  updateTripMember(
    id: string,
    input: {
      role?: TripMemberRole;
      accessLevel?: TripAccessLevel;
      displayName?: string;
      managedBy?: string | null;
    },
  ): Promise<TripMember>;
  /** DELETE /trips/members/:id（移除出行成员） */
  removeTripMember(id: string): Promise<void>;
  /**
   * GET /trips/:id/invite —— 取行程邀请码（外部成员凭码加入）。
   * 🆕 新端点（后端派发单 D-2026-10-14-02 待落地）；Mock 已就绪。
   */
  getTripInvite(tripId: string): Promise<TripInvite>;
  /**
   * POST /trips/:id/invite/reset —— 重置行程邀请码（旧码作废；仅主导者/创建者）。
   * 🆕 新端点（后端派发单 D-2026-10-14-02 待落地）；Mock 已就绪。
   */
  resetTripInvite(tripId: string): Promise<TripInvite>;
  /**
   * POST /trips/join —— 凭行程邀请码加入出行（外部同行者）。
   * 幂等：已是成员直接返回（alreadyMember=true）。
   * 🆕 新端点（后端派发单 D-2026-10-14-02 待落地）；Mock 已就绪。
   */
  joinTrip(input: { inviteCode: string; displayName?: string }): Promise<JoinTripResult>;

  // ---- wish ----
  /** GET /wishes */
  listWishes(familyId?: string): Promise<Wish[]>;
  /** POST /wishes/:id/vote */
  voteWish(id: string): Promise<Wish>;

  // ---- itinerary ----
  /** GET /itineraries */
  listItineraries(tripId: string): Promise<ItineraryItem[]>;
  /** POST /itineraries（新增安排；startAt 为本地时间 YYYY-MM-DDTHH:mm） */
  createItineraryItem(input: {
    tripId: string;
    familyId: string;
    title: string;
    /** 本地时间 YYYY-MM-DDTHH:mm */
    startAt: string;
    endAt?: string;
    location?: string;
    note?: string;
    sort?: number;
    /** 地图标记坐标（chooseLocation 带回；不传则该安排不参与地图标记） */
    lat?: number;
    lng?: number;
    transport?: TransportMode;
  }): Promise<ItineraryItem>;
  /** PATCH /itineraries/:id（CAS：version 必传） */
  updateItineraryItem(
    id: string,
    input: {
      version: number;
      title?: string;
      startAt?: string;
      endAt?: string | null;
      location?: string | null;
      note?: string | null;
      sort?: number;
      lat?: number | null;
      lng?: number | null;
      transport?: TransportMode | null;
    },
  ): Promise<ItineraryItem>;
  /** DELETE /itineraries/:id */
  deleteItineraryItem(id: string): Promise<void>;

  // ---- checklist ----
  /** GET /checklists/items */
  listChecklist(scope?: 'SHARED' | 'PERSONAL'): Promise<ChecklistItem[]>;
  /** POST /checklists/items（新增物品） */
  createChecklistItem(input: {
    tripId: string;
    familyId: string;
    /** 后端字段名为 name（对齐 createChecklistItemSchema） */
    name: string;
    quantity?: number;
    scope?: 'SHARED' | 'PERSONAL';
  }): Promise<ChecklistItem>;
  /** POST /checklists/items/:id/toggle */
  toggleChecklistItem(id: string): Promise<ChecklistItem>;
  /**
   * GET /checklists/items?tripId=...
   * 按出行查清单（修复「清单默认是之前一个」的跨行程串数据问题）。
   * 不传 scope 时返回「共享 + 我自己可见的私有」。
   */
  listTripChecklist(tripId: string, scope?: 'SHARED' | 'PERSONAL'): Promise<ChecklistItem[]>;
  /** DELETE /checklists/items/:id */
  deleteChecklistItem(id: string): Promise<void>;

  // ---- expense ----
  /** GET /expenses */
  listExpenses(tripId: string): Promise<Expense[]>;
  /** GET /expenses/summary */
  expenseSummary(tripId: string): Promise<ExpenseSummary>;
  /** POST /expenses（记一笔；amount 为主单位字符串如 "8600.00"） */
  createExpense(input: {
    tripId: string;
    familyId: string;
    title: string;
    /** 主单位金额字符串，如 "368.00"（后端落库前转最小货币单位） */
    amount: string;
    currency?: string;
    category?: string;
    /** YYYY-MM-DD，缺省为今天 */
    spentAt?: string;
    note?: string;
  }): Promise<Expense>;
  /** PATCH /expenses/:id */
  updateExpense(
    id: string,
    input: {
      title?: string;
      amount?: string;
      currency?: string;
      category?: string | null;
      spentAt?: string | null;
      note?: string | null;
    },
  ): Promise<Expense>;
  /** DELETE /expenses/:id */
  deleteExpense(id: string): Promise<void>;

  // ---- item（个人物品库，PRIVATE 域） ----
  /** GET /items（默认只看本人；mineOnly=false 时代管成员的也可见） */
  listItems(query?: { category?: string; mineOnly?: boolean }): Promise<Item[]>;
  /** POST /items */
  createItem(input: {
    familyId: string;
    name: string;
    category?: string;
    quantity?: number;
    note?: string;
  }): Promise<Item>;
  /** PATCH /items/:id（CAS：version 必传） */
  updateItem(
    id: string,
    input: {
      version: number;
      name?: string;
      category?: string | null;
      quantity?: number;
      note?: string | null;
    },
  ): Promise<Item>;
  /** DELETE /items/:id */
  deleteItem(id: string): Promise<void>;

  // ---- media（用户上传的照片/视频） ----
  /** POST /media/presign —— 预签名上传位，客户端随后直传对象存储 */
  presignUpload(input: {
    fileName: string;
    mimeType: string;
    byteSize: number;
  }): Promise<PresignUploadResult>;
  /**
   * POST /media/confirm —— 上传完成后登记资产。
   * familyId 由实现层内部解析（Mock 取常量；HTTP 走 GET /families 首个家庭），
   * 界面层不感知 —— 与「界面只依赖接口契约」原则一致。
   */
  confirmMediaAsset(input: ConfirmMediaAssetInput): Promise<MediaAsset>;
  /** GET /media（默认按创建时间倒序；分页由后端 meta 承载，原型只取首页） */
  listMedia(query?: {
    tripId?: string;
    mimePrefix?: string;
    page?: number;
    pageSize?: number;
  }): Promise<MediaAsset[]>;
  /** DELETE /media/:id */
  deleteMediaAsset(id: string): Promise<void>;

  // ---- memory（回忆快照，只读 + 生成） ----
  /** GET /memories（列表项只含摘要） */
  listMemories(query?: { type?: MemoryType; year?: number }): Promise<MemoryArchive[]>;
  /** GET /memories/:id（含完整快照） */
  getMemory(id: string): Promise<{ memory: MemoryArchive; snapshot: MemorySnapshot }>;
  /**
   * POST /memories/generate-trip —— 生成出行回忆（出行结束后调用）。
   * 幂等：同年 TRIP 回忆已存在则直接返回既有快照（created=false），不覆盖。
   */
  generateTripMemory(tripId: string): Promise<{
    memory: MemoryArchive;
    snapshot: MemorySnapshot;
    created: boolean;
  }>;
  /** POST /memories/generate-annual —— 生成年度回忆（同样幂等） */
  generateAnnualMemory(year: number): Promise<{
    memory: MemoryArchive;
    snapshot: MemorySnapshot;
    created: boolean;
  }>;
}

/** 从信封中取 data；code 非 0 抛 ApiError */
export function unwrap<T>(env: { code: number; message: string; data: T | null }): T {
  if (env.code !== 0) throw new ApiError(env.code, env.message);
  if (env.data === null) throw new ApiError(-1, '响应 data 为空');
  return env.data;
}
