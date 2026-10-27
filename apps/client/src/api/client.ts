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
  ApplyTemplateResult,
  BatchExpenseResult,
  ChecklistItem,
  ChecklistTemplate,
  ChecklistTemplateItem,
  TemplateSyncResult,
  ConfirmMediaAssetInput,
  Destination,
  Expense,
  ExpenseSummary,
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
  MemoryType,
  PhotoMemoryGroup,
  PresignUploadResult,
  RateTier,
  TransportMode,
  Trip,
  TripAccessLevel,
  TripDetail,
  TripInvite,
  TripMember,
  TripMemberRole,
  TripUpdateInput,
  UpdateProfileInput,
  UploadPurpose,
  User,
  Wish,
  WishVoteResult,
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
  /**
   * PATCH /auth/me —— 更新本人资料（昵称 / 头像）。
   * 🆕 客户端新增方法：服务端路由早已存在（auth.controller.ts 的 PATCH /auth/me），
   *    此前 updateProfileSchema 未放行 avatarUrl（派发单 D-2026-10-16-01 推动补齐）。
   *    DB 列 user.avatar_url 已存在；头像 URL 须经媒体链路上传后由服务端校验归属。
   *    信封口径：data = { user, updatedAt }（与 GET /auth/me 的 { user } 不同，多拆一层）。
   */
  updateMe(input: UpdateProfileInput): Promise<User>;

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
  /** GET /trips/:id —— 只取行程本身（老的窄契约，保留给只关心 trip 的调用方） */
  getTrip(id: string): Promise<Trip>;
  /**
   * GET /trips/:id —— 取**完整**详情（行程 + 参与人 + 我的角色）。
   * 🆕 客户端新增方法（纯加法，不动 getTrip 签名）。
   * 🔴 为什么不直接改 getTrip 的返回类型：那是既有 21 处调用点的公共契约，
   *    单方面改签名会让所有调用方一起变，收益为零、风险不低。新增独立方法，
   *    只让「需要参与人」的界面走宽契约。
   */
  getTripDetail(id: string): Promise<TripDetail>;
  /** POST /trips */
  createTrip(input: {
    familyId: string;
    title: string;
    startDate?: string;
    endDate?: string;
    /**
     * 目的地（整体写入，服务端 createTripSchema 早已支持 `destinations`）。
     * 🆕 客户端新增字段：此前创建行程无处填目的地，只能建完再进详情页补，
     *    对应反馈「允许用户选择地区」。
     */
    destinations?: Destination[];
    /** 出行预算（最小货币单位整数字符串，如「分」）；不传 = 不设预算 */
    budgetMinor?: string;
  }): Promise<Trip>;
  /**
   * PATCH /trips/:id —— 改行程本身（标题 / 起止日期 / 目的地）。
   * 🔴 CAS：`version` 必传（拿列表或详情里的当前值原样回传），
   *    不一致时服务端回 409，界面提示刷新重试。
   * 🆕 客户端新增方法（服务端 PATCH 早已存在，此前只有服务端能力、无前端入口）。
   */
  updateTrip(id: string, input: TripUpdateInput): Promise<Trip>;
  /**
   * DELETE /trips/:id —— 删除整场行程。
   * 🆕 客户端新增方法（服务端 DELETE 早已存在）。
   */
  deleteTrip(id: string): Promise<void>;
  /**
   * POST /trips/:id/finish —— 标记行程「已完成」并归档（B6）。
   * ============================================================================
   * 🆕 客户端新增方法（服务端 2026-10-22 已有该端点，返回 data={trip,updatedAt}）。
   * 为什么前端需要它：日期过了但状态还停在 PLANNED 时，客户端不能替用户改库，
   * 只能提示 + 让用户点一下落库；真正的「到期自动完结」要后端定时/惰性流转
   * （见派发单 D-2026-10-26-02 P0-1）。
   * 🔴 CAS：version 必传；仅主导者/创建者可调（后端 403）。
   * 🔴 归档副作用：该行程所有成员 accessLevel → HISTORICAL_READONLY，
   *    之后 itinerary/checklist/expense/booking/media 的写接口一律 403。
   */
  finishTrip(id: string, version: number): Promise<Trip>;
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
  /**
   * POST /wishes —— 提一条心愿（全家投票用）。
   * 🆕 客户端新增方法：服务端 `createWishSchema` 与 POST 路由早已存在
   *    （domains/wish/wish.controller.ts），此前只有「投票」没有「新建」，
   *    界面上的「提心愿」按钮因此点了没反应。
   * 🔴 字段口径：服务端叫 `description`，客户端模型暴露为 `note`
   *    （投影在 api/http.ts 的 toWish 里统一做，界面只认知 note）。
   */
  createWish(input: {
    familyId: string;
    title: string;
    /** 服务端 description（客户端公开名 note） */
    description?: string;
    /** 可选：直接挂到某次出行下 */
    tripId?: string;
    /** 优先级，0-100，越大越靠前 */
    priority?: number;
  }): Promise<Wish>;
  /**
   * POST /wishes/:id/vote
   * 服务端返回 `{ wishId, voteCount, votedByMe }` —— 只回计票结果，不回整个 wish。
   */
  voteWish(id: string): Promise<WishVoteResult>;

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
    /** 富文本/图片正文块（有序；纯加法，老后端忽略未知键） */
    blocks?: ItineraryBlock[];
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
      /** 富文本/图片正文块（整体替换；传 [] 表示清空正文块） */
      blocks?: ItineraryBlock[];
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
    /** 清单分类：TODO = 要做的事 / PACK = 要带的东西（2026-10-27） */
    kind?: 'TODO' | 'PACK';
  }): Promise<ChecklistItem>;
  /**
   * POST /checklists/items/:id/toggle（E7 CAS）
   * @param checked 目标状态。不传 = 取反（老行为）；传了 = 幂等置位。
   * 🆕 新增可选参数：连点时「取反」会把两次点击抵销，客户端算好目标态传进来才稳。
   *    纯加法，后端 schema 本就要求 `checked` 必传，不缺字段。
   */
  toggleChecklistItem(id: string, checked?: boolean): Promise<ChecklistItem>;
  /**
   * GET /checklists/items?tripId=...
   * 按出行查清单（修复「清单默认是之前一个」的跨行程串数据问题）。
   * 不传 scope 时返回「共享 + 我自己可见的私有」。
   */
  listTripChecklist(tripId: string, scope?: 'SHARED' | 'PERSONAL'): Promise<ChecklistItem[]>;
  /** DELETE /checklists/items/:id */
  deleteChecklistItem(id: string): Promise<void>;

  // ---- checklist 模板（长期清单：家庭共享 / 本人私有） ----
  /**
   * GET /checklists/templates —— 列出可见模板（家庭共享 + 我的私有）。
   * 后端回 `{items: [...]}`，`items`（条目数组）在行里是 `itemsJson` 字符串，
   * 由实现层解析成 `ChecklistTemplateItem[]`，界面不感知。
   */
  listChecklistTemplates(familyId?: string): Promise<ChecklistTemplate[]>;
  /**
   * POST /checklists/templates —— 新建一套长期清单（条目一次写入）。
   * 🔴 PERSONAL 必须给 ownerId（后端 createTemplateSchema 的 refine 要求），
   *    缺省由实现层补成当前用户。
   */
  createChecklistTemplate(input: {
    familyId?: string;
    name: string;
    scope: 'SHARED' | 'PERSONAL';
    ownerId?: string;
    items: ChecklistTemplateItem[];
  }): Promise<ChecklistTemplate>;
  /**
   * PATCH /checklists/templates/:id —— 改模板（名称 / 条目整体替换）。
   * 🆕 契约新增；**后端尚未提供该路由**（派发单 P0-1），
   *    未上线前调用会拿到 404 同形错误，界面按「暂不可改」降级提示。
   */
  /**
   * PATCH /checklists/templates/:id
   * ============================================================================
   * 改条目时服务端会把变更**同步到引用了它、且尚未成行的行程**
   * （用户口径：未成行的要同步，已完成的不用改）。返回里的 `synced`
   * 就是这次同步的影响面，界面据此给一句人话提示；`synced` 缺省表示
   * 本次只改了名字、没有动条目。
   */
  updateChecklistTemplate(
    id: string,
    input: { version: number; name?: string; items?: ChecklistTemplateItem[] },
  ): Promise<{ template: ChecklistTemplate; synced?: TemplateSyncResult }>;
  /**
   * DELETE /checklists/templates/:id —— 删整套长期清单。
   * 🆕 契约新增；**后端尚未提供该路由**（派发单 P0-2）。
   */
  deleteChecklistTemplate(id: string): Promise<void>;
  /**
   * POST /checklists/templates/apply —— 把一套长期清单引用到某行程。
   * 幂等：同 (templateId, tripId) 已引用过则 alreadyApplied=true，不重复插入。
   */
  applyChecklistTemplate(input: {
    templateId: string;
    tripId: string;
    familyId: string;
  }): Promise<ApplyTemplateResult>;

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
  /**
   * 批量记账（账单导入专用）。
   * ============================================================================
   * 🆕 客户端新增方法。后端目前只有单笔 `POST /expenses`，所以实现层按行顺序
   *    投递（串行：逐行串行可保证「哪几笔失败」定位准确，且不打爆限流）；
   *    后端补 `POST /expenses/batch` 后只换实现，界面零改动（派发单 P1-1）。
   * 语义：**部分成功**——失败行不阻塞其余行，返回 created/failed/errors。
   */
  createExpensesBatch(
    input: { tripId: string; familyId: string },
    rows: Array<{
      title: string;
      amount: string;
      currency?: string;
      category?: string;
      /** YYYY-MM-DD */
      spentAt?: string;
      note?: string;
    }>,
  ): Promise<BatchExpenseResult>;

  // ---- fx（汇率） ----
  /**
   * GET /fx/rate —— 取某日汇率。
   *
   * 🔴 `date` 必传（YYYY-MM-DD）：汇率是快照型数据，不给日期就等于让后端
   *    猜口径。缺汇率时后端回 FX_SOURCE_MISCONFIGURED，界面应提示「暂无汇率」
   *    而不是回退成 1:1。
   * 🔴 返回里的 `tier` 是**实际口径**，调用方不得假设。
   */
  getFxRate(input: {
    base: string;
    quote: string;
    date: string;
    tier?: RateTier;
    /** 跳过服务端缓存强制回源（运维排查用，正常查询别开） */
    forceRefresh?: boolean;
  }): Promise<FxRate>;

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
    /** 上传用途：AVATAR = 头像（后端可走用户维度 fileKey 前缀；老后端忽略） */
    purpose?: UploadPurpose;
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
  /**
   * GET /media/memories —— 照片回忆聚合（2026-10-27）。
   * ==========================================================================
   * 服务端现算：有 tripId 的按行程成组、无 tripId 的按月份成组，按组内最新
   * 照片时间倒序。**照片一上传就自动出现**，不需要「生成回忆」动作；
   * 头像池（`a/` 前缀）已在服务端排除，不会混进旅行照片。
   */
  listPhotoMemories(query?: {
    familyId?: string;
    /** 最多几组（默认 12） */
    limit?: number;
    /** 每组带几张预览（默认 9） */
    previewSize?: number;
  }): Promise<PhotoMemoryGroup[]>;

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
