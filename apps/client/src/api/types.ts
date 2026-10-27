/**
 * 后端契约类型（与 apps/server 对齐）
 * ============================================================================
 * 唯一真相来源是后端 `src/common/envelope/envelope.ts` 与各域 `*.schema.ts`。
 * 这里只声明原型用得到的子集，字段名/取值必须与后端一字不差，
 * 否则后续切真接口时会出现「看起来能跑、实际字段对不上」的隐性 bug。
 */

/** 统一响应信封：成功与失败同形，客户端只需一套解析逻辑 */
export interface Envelope<T> {
  code: number;
  message: string;
  data: T | null;
  meta?: ResponseMeta;
}

export interface ResponseMeta {
  updatedAt?: string;
  serverTime?: string;
  page?: number;
  pageSize?: number;
  total?: number;
  /** 增量同步游标（服务端签发的不透明串，客户端只回传不解析） */
  cursor?: string;
  [k: string]: unknown;
}

/** 用户 */
export interface User {
  id: string;
  nickname: string;
  avatarUrl?: string;
  homeTimezone?: string;
}

/**
 * 登录会话（POST /auth/login 的 data，对齐后端 auth.service.ts 的 AuthSession）。
 * 🔴 ApiClient.login 的返回契约为 User（原型接口一字不改）—— token 的持久化
 *    由 http 实现层在收到本结构后内部完成，界面层不感知，见 api/session.ts。
 */
export interface AuthSession {
  token: string;
  expiresIn: number;
  user: User;
  /** 是否新注册 —— 客户端据此决定是否走 onboarding */
  isNewUser: boolean;
}

/** 家庭 */
export interface Family {
  id: string;
  name: string;
  ownerUserId: string;
  memberCount: number;
  /** 邀请码（建家庭时自动生成；邀请家人加入用） */
  inviteCode?: string;
}

/** 家庭成员 */
export interface FamilyMember {
  id: string;
  familyId: string;
  /** 虚拟成员（无微信账号的家人，如幼儿/老人）为 null */
  userId: string | null;
  role: 'OWNER' | 'MEMBER';
  isVirtual: boolean;
  /** 代管人 memberId（虚拟成员必有；真实成员为 null） */
  managedBy: string | null;
  displayName: string;
  joinedAt: string;
}

/** 家庭详情（GET /families/:id 的 data：家庭 + 成员列表） */
export interface FamilyDetail {
  family: Family;
  members: FamilyMember[];
}

/** 凭邀请码加入家庭的结果（POST /families/join 的 data） */
export interface JoinFamilyResult {
  family: Family;
  /** 已是成员时幂等返回 true（不重复插入） */
  alreadyMember: boolean;
}

/** 出行状态机 */
export type TripStatus = 'DRAFT' | 'PLANNED' | 'ONGOING' | 'FINISHED' | 'CANCELLED';

/** 交通方式（行程安排内选择；地图连线按此着色） */
export type TransportMode = 'WALK' | 'BIKE' | 'CAR' | 'BUS' | 'TRAIN' | 'FLIGHT';

/** 出行成员角色（LEADER=主导者；经 addTripMember 加入的只能是 MEMBER） */
export type TripMemberRole = 'LEADER' | 'MEMBER';

/** 出行成员访问级别（出行结束后转 HISTORICAL_READONLY，历史只读保留，B6） */
export type TripAccessLevel = 'ACTIVE' | 'HISTORICAL_READONLY';

/**
 * 出行成员（对齐后端 tripMember 行 + MEMBER_BIGINT_FIELDS 序列化）。
 * 虚拟成员（无微信账号的家人）userId 为 null；外部同行者 isExternal=true。
 */
export interface TripMember {
  id: string;
  tripId: string;
  /** 真实用户为用户 id；虚拟成员为 null */
  userId: string | null;
  role: TripMemberRole;
  /** 外部同行者（如朋友），不属家庭（PRD §2.6 临时家庭模型） */
  isExternal: boolean;
  accessLevel: TripAccessLevel;
  displayName: string;
  /** 代管人 memberId（虚拟成员必有；真实成员为 null） */
  managedBy: string | null;
  joinedAt: string;
}

/** 行程邀请码（GET /trips/:id/invite 的 data；新端点见后端派发单） */
export interface TripInvite {
  tripId: string;
  /** 邀请码（建行程时按需生成；重置后旧码作废） */
  inviteCode: string;
  /** 码最近重置时间（无重置记录时等于行程创建时间） */
  updatedAt: string;
}

/** 凭行程邀请码加入的结果（POST /trips/join 的 data） */
export interface JoinTripResult {
  trip: Trip;
  member: TripMember;
  /** 已是成员时幂等返回 true（不重复插入） */
  alreadyMember: boolean;
}

/** 目的地 */
export interface Destination {
  name: string;
  note?: string;
}

/** 出行 */
export interface Trip {
  id: string;
  familyId: string;
  title: string;
  status: TripStatus;
  startDate?: string | null;
  endDate?: string | null;
  timezone?: string;
  destinations?: Destination[];
  /** E7 CAS 乐观锁版本号；更新时必须原样回传 */
  version: number;
  /**
   * 本趟同行人数（后端 D-2026-10-26-02 P1-1 已补，`GET /trips` 与 `GET /trips/:id` 都带）。
   * 🔴 与 `Family.memberCount`（**家庭**总人数）不是一回事 —— 家庭 4 人、本趟只去 3 人时
   *    列表曾误用家庭人数显示「4 人同行」。缺省表示老后端没给，界面不显示（不编数据）。
   */
  memberCount?: number;
  /**
   * 出行预算（最小货币单位整数字符串，如 CNY 的「分」）。
   * 2026-10-27 需求③：花销页要能记录预算。
   * `null` / `undefined` 一律视为「未设预算」—— 不显示进度条，也不编造 0。
   */
  budgetMinor?: string | null;
}

/** 心愿（愿望池条目） */
export interface Wish {
  id: string;
  tripId?: string;
  familyId: string;
  title: string;
  note?: string;
  /** 投票数 */
  votes: number;
  /** 当前用户是否已投票 */
  votedByMe: boolean;
  status: 'OPEN' | 'ADOPTED' | 'ARCHIVED';
  tags?: string[];
}

/**
 * 安排内容块（v2 富文本卡片 —— 对齐 2026-10-14 参考截图）
 * ============================================================================
 * 参考截图里同一张安排卡内混排了多种形态：机票截图（图片）、灰底多行说明
 * （引用）、等宽蓝色酒店地址（代码）、可点开的外链（链接）。
 * 因此把「卡片正文」从单行 note 升级为**有序块列表**，块与块之间顺序即渲染顺序。
 *
 * 🔴 与后端的对齐口径（见派发单 D-2026-10-15-01）：
 *   - 服务端字段 `blocks`（DB 列 `blocks_json`，TEXT，可空）；老数据缺省 = 无正文块。
 *   - `note` 保留不动（纯文本兜底）：老数据仍只有 note，渲染时作为首个 text 块显示。
 *   - image 块只存 `assetId`（media 域资产 id）。URL **由服务端解析**后在读接口
 *     直接回填到 `url`（方案 A，同 MEDIA_PUBLIC_BASE_URL 拼接口径），前端零拼接。
 *     Mock 模式下 url 为空串，界面按占位/本会话本地路径降级，不破图。
 */
export type ItineraryBlock =
  | {
      /** 普通段落（多行用 \n 分隔，渲染保留换行） */
      type: 'text';
      text: string;
    }
  | {
      /** 引用块：灰底圆角，用于注意事项/攻略摘录（参考截图灰底多行块） */
      type: 'quote';
      text: string;
    }
  | {
      /** 代码/等宽块：地址、航班号、车次等需要逐字核对的内容 */
      type: 'code';
      text: string;
    }
  | {
      /** 链接块：正文 + 可点开的外链（参考截图抖音分享链接） */
      type: 'link';
      text: string;
      url: string;
    }
  | {
      /** 图片块：内嵌到安排卡里的截图/照片 */
      type: 'image';
      /** media 域资产 id（上传登记后回填；Mock 模式同样登记在内存 media 表） */
      assetId?: string;
      /** 服务端解析后的可访问 URL（读接口回填；Mock 为空串） */
      url?: string;
      /** 图注（选填） */
      caption?: string;
    };

/**
 * 行程更新入参（PATCH /trips/:id，E7 CAS）。
 * 🔴 `version` 必传：前后端并发保护靠它，缺了就拒（服务端 400）。
 */
export interface TripUpdateInput {
  version: number;
  title?: string;
  /** YYYY-MM-DD；传 null 清空 */
  startDate?: string | null;
  /** YYYY-MM-DD；传 null 清空 */
  endDate?: string | null;
  /** 整体替换目的地列表（非增量合并） */
  destinations?: Destination[];
  /** 出行预算（最小货币单位整数字符串）；传 null = 取消预算，不传 = 不改 */
  budgetMinor?: string | null;
}

/** 行程条目 */
export interface ItineraryItem {
  id: string;
  tripId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  startTime?: string;
  /** HH:mm（结束时间，选填；与服务端 endAt 对应，展示为时间段） */
  endTime?: string;
  title: string;
  location?: string;
  note?: string;
  /** 富文本/图片正文块（有序；缺省表示老数据，只有 note） */
  blocks?: ItineraryBlock[];
  sortOrder: number;
  /** CAS 乐观锁版本号；更新时必须原样回传 */
  version: number;
  /** 地图标记纬度（选点后由 chooseLocation 带回，未选点为空） */
  lat?: number;
  /** 地图标记经度 */
  lng?: number;
  /** 交通方式（前往/离开该安排的出行方式） */
  transport?: TransportMode;
}

/** 清单条目 */
export interface ChecklistItem {
  id: string;
  /** 所属出行（修复前跨行程串数据的根源：列表必须按 tripId 过滤） */
  tripId?: string;
  scope: 'SHARED' | 'PERSONAL';
  title: string;
  done: boolean;
  assigneeName?: string;
  /** CAS 乐观锁版本号（toggle 必须原样回传；缺省 = 老后端，按 0 处理） */
  version?: number;
  /** 数量（后端列 quantity，缺省 1）；引用长期清单时由模板带过来 */
  quantity?: number;
  /** 由哪套长期清单引用而来（templateId；手工加的个性化物品为空） */
  templateId?: string;
  /**
   * 清单分类（2026-10-27 需求③）：
   *   TODO = 要做的事（订门票、办签证、给猫找寄养）
   *   PACK = 要带的东西（身份证、充电宝 x2）
   * 两者在清单 tab 里是两个独立分区，勾选进度各自算。
   * 老后端 / 历史数据没有这个字段 → 按 PACK 处理（历史清单装的就是打包物品）。
   */
  kind?: 'TODO' | 'PACK';
}

/**
 * 长期清单条目（模板内的一条）。
 * 后端存储为 `checklistTemplate.items_json` 的数组元素，只有 name/quantity 两个字段。
 */
export interface ChecklistTemplateItem {
  name: string;
  quantity: number;
  /**
   * 类型（2026-10-27 反馈④第二次「条目要按类型分类」）。
   * 取值对齐 `ITEM_CATEGORIES`（证件/电子/衣物/洗护/药品/食品/母婴/其他），
   * 但不做枚举硬约束 —— 家庭自建分类不该被前端类型挡住。
   * 缺省 = 未分类（存量条目都没有这个字段）。
   */
  category?: string;
}

/**
 * 长期清单（模板）—— 「每次出门都带的东西」清单池，可被任意行程反复引用。
 * ============================================================================
 * 对齐后端 `checklistTemplate` 行（见 domains/checklist/checklist.service.ts）：
 *   · `scope = SHARED`   → 家庭共享清单，`familyId` 有值、`ownerId` 为 null
 *   · `scope = PERSONAL` → 我的私人清单，`ownerId` = 本人，仅本人可见
 * 🔴 后端 GET /checklists/templates 回的是原始行，`items` 藏在 `itemsJson` 字符串里，
 *    投影在 api/http.ts 的 toChecklistTemplate 统一解析，界面只认 `items` 数组。
 */
export interface ChecklistTemplate {
  id: string;
  familyId: string | null;
  scope: 'SHARED' | 'PERSONAL';
  ownerId: string | null;
  name: string;
  items: ChecklistTemplateItem[];
  /** CAS 乐观锁版本号；改模板时必须原样回传 */
  version: number;
  updatedAt?: string;
}

/**
 * 照片回忆组（2026-10-27 需求：像 iPhone 相册的回忆）
 * ============================================================================
 * 由服务端**现算**：有 tripId 的照片按行程成组，没 tripId 的按月份成组。
 * 照片一上传就自动出现在这里，不需要任何「生成回忆」的动作。
 *
 * 🔴 服务端已排除头像池（`fileKey` 以 `a/` 开头），
 *    否则换过的头像会被当成旅行照片混进回忆墙。
 */
export interface PhotoMemoryGroup {
  /** TRIP = 某次旅行；MONTH = 没挂行程的照片按月归档 */
  kind: 'TRIP' | 'MONTH';
  /** TRIP 时有值 */
  tripId: string | null;
  /** MONTH 时有值，格式 YYYY-MM */
  month: string | null;
  /** 标题：行程名 或「2026 年 10 月」 */
  title: string;
  /** 副标题：日期区间 或「N 张照片」 */
  subtitle: string;
  /** 封面图 URL（组内最新一张） */
  cover: string;
  photoCount: number;
  /** 前 N 张（默认 9，九宫格预览） */
  photos: string[];
  /** 组内最新一张的时间（排序用） */
  lastAt: string;
}

/** 把长期清单引用到行程的结果（幂等：同模板同行程重复引用不重复插入） */
export interface ApplyTemplateResult {
  created: number;
  skipped: number;
  alreadyApplied: boolean;
}

/**
 * 模板条目变更 → 同步到「未成行行程」的结果（2026-10-27）。
 * 已归档（FINISHED / CANCELLED）的行程不在同步范围内，那是历史快照。
 */
export interface TemplateSyncResult {
  /** 实际处理的行程数（只算未归档的） */
  trips: number;
  /** 补进行程的新条目数 */
  created: number;
  /** 数量被同步的条目数 */
  updated: number;
  /** 因模板删掉而同步删除的条目数 */
  removed: number;
  /** 模板删了但行程里已勾选、因此保留下来的条目数 */
  keptChecked: number;
}

/**
 * 行程详情（GET /trips/:id 的完整 data）。
 * ============================================================================
 * 🔴 后端该端点一直返回 `{trip, members, myRole, myAccessLevel}`，
 *    此前客户端 `getTrip()` 只投影了 trip、把 members 丢掉，
 *    于是「加入行程后看不到参与人」—— 是客户端裁剪造成的，不是后端缺能力。
 */
export interface TripDetail {
  trip: Trip;
  members: TripMember[];
  myRole: TripMemberRole | null;
  myAccessLevel: TripAccessLevel | null;
}

/**
 * 账单导入的一行（解析产物，尚未提交）。
 * 金额是**主单位字符串**（如 "38.50"），与 createExpense 的口径一致。
 */
export interface BillImportRow {
  title: string;
  amount: string;
  /** YYYY-MM-DD */
  spentAt: string;
  category?: string;
  note?: string;
  currency?: string;
}

/**
 * 批量记账的**行级结果**（对齐后端 expense.service 的 BatchExpenseRowResult）。
 * `index` 是该行在请求 `rows` 数组里的下标 —— 客户端据此把失败行标回预览列表。
 */
export interface BatchExpenseRowResult {
  index: number;
  ok: boolean;
  /** 成功时为新账目 id */
  id?: string;
  /** 失败原因；成功时不存在 */
  error?: { code: number; message: string };
}

/**
 * 批量记账结果（客户端视图）。
 * ============================================================================
 * 🔴 后端回包是 `{created, failed, results}`（逐行结果），本结构是它的**投影**：
 *    `errors` 由实现层从 results 里取失败行的 message 拼成（最多 5 条供提示框展示）。
 *    界面只认 created/failed/errors 三个字段，不直接消费 results ——
 *    这样弹层文案逻辑不必关心后端行级结构的变化。
 */
export interface BatchExpenseResult {
  created: number;
  failed: number;
  errors: string[];
}

/** 记账 */
export interface Expense {
  id: string;
  tripId: string;
  title: string;
  /** 金额字符串，避免浮点误差（后端用 decimal.js） */
  amount: string;
  currency: string;
  /** 人民币折算额 */
  amountCny?: string;
  payerName: string;
  spentAt: string;
  category?: string;
  note?: string;
}

/** 记账汇总 */
export interface ExpenseSummary {
  totalCny: string;
  byMember: Array<{ memberName: string; amountCny: string }>;
  byCategory: Array<{ category: string; amountCny: string }>;
}

// ─── 汇率（对齐 fx 域 RateView / FxRate） ──────────────────────────

/**
 * 汇率档位。
 * 🔴 本期唯一口径是 `SPOT_SELL`（现汇卖出价），其余枚举仅保留占位，
 *    后端 `resolveTier()` 会直接拒绝。
 */
export type RateTier = 'SPOT_SELL' | 'MIDDLE' | 'CASH_BUY';

/**
 * 汇率视图（`GET /fx/rate` 的 `data.rate`）。
 *
 * `rate` 是字符串不是 number —— 与后端一致，避免浮点误差；
 * 换算请走 `utils/fx.ts` 的 `convertAmount()`，不要自己 `Number()` 后乘。
 */
export interface FxRate {
  base: string;
  quote: string;
  /** 方向：1 base = rate quote */
  rate: string;
  rateDate: string;
  tier: RateTier;
  /** 取数时刻（ISO 8601） */
  rateTime: string;
  /** 来源标识；`IDENTITY` 表示同币种恒等 1 */
  source: string;
  fromCache: boolean;
}

/** 个人物品（物品库条目 —— PRIVATE 域，仅本人/代管人可见） */
export interface Item {
  id: string;
  familyId: string;
  name: string;
  /** 分类（证件必带/衣物/电子/洗护/母婴/药品/食品/其他） */
  category?: string;
  quantity: number;
  note?: string;
  /** CAS 乐观锁版本号；更新时必须原样回传 */
  version: number;
}

// ─── 媒体资产（对齐 media 域 mediaAsset 行） ───────────────────────

/** 存储分级 */
export type StorageClass = 'STANDARD' | 'IA' | 'ARCHIVE';

/**
 * 媒体资产（照片/视频登记行）。
 * 字段与后端 serializeRow(mediaAsset, MEDIA_BIGINT_FIELDS) 一字不差。
 * ✅ 方案 A（已落地）：后端 list / confirm / stripExif 响应已直接带回 `url`
 *   （= 公网基址 MEDIA_PUBLIC_BASE_URL + fileKey），前端零拼接可直接用。
 *   fileKey 仍保留，便于做缓存 key 或二次拼接。
 */
export interface MediaAsset {
  id: string;
  /** 可访问 URL（后端拼接，方案 A）；Mock 联调置空串 */
  url: string;
  familyId: string;
  tripId: string | null;
  ownerId: string;
  fileKey: string;
  mimeType: string;
  /** 字节数（后端 bigint 序列化为字符串） */
  byteSize: string;
  compressed: boolean;
  /** 是否已剥离 EXIF（M6 隐私红线） */
  exifStripped: boolean;
  /** 原图是否含 GPS（供审计告警） */
  hadGps: boolean;
  storageClass: StorageClass;
  width: number | null;
  height: number | null;
  createdAt: string;
  updatedAt: string;
}

/** 预签名上传位（POST /media/presign 返回） */
export interface PresignUploadResult {
  /** 对象存储直传地址（PUT） */
  uploadUrl: string;
  headers?: Record<string, string>;
  /** 有效期（秒） */
  expiresIn: number;
  /** 服务端生成的文件 key，登记时原样回传 */
  fileKey: string;
}

/**
 * 上传用途（presign/confirm 的可选声明）。
 * · MEDIA —— 家庭照片/安排图片（默认）
 * · AVATAR —— 用户头像（fileKey 走用户维度前缀；老后端忽略未知键，退回 MEDIA 路径）
 */
export type UploadPurpose = 'MEDIA' | 'AVATAR';

/** 登记媒体资产入参（POST /media/confirm） */
export interface ConfirmMediaAssetInput {
  tripId?: string;
  fileKey: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
  /** 上传用途（AVATAR = 头像；老后端忽略，纯加法字段） */
  purpose?: UploadPurpose;
}

/** 更新本人资料入参（PATCH /auth/me；后端 updateProfileSchema 纯加法放行） */
export interface UpdateProfileInput {
  nickname?: string;
  /** 头像可访问 URL（须为服务端媒体基址拼接结果，由服务端校验归属） */
  avatarUrl?: string;
}

// ─── 回忆归档（对齐 memory 域 MemorySnapshot） ─────────────────────

/** 回忆类型 */
export type MemoryType = 'TRIP' | 'ANNUAL';

/** 回忆快照中的出行摘要 */
export interface MemoryTripBrief {
  id: string;
  title: string;
  status: string;
  startDate: string | null;
  endDate: string | null;
  timezone: string;
  memberCount: number;
  memberNames: string[];
}

/** 回忆快照中的行程条目 */
export interface MemoryItineraryBrief {
  date: string | null;
  title: string;
  location: string | null;
}

/** 回忆快照中的花销汇总 */
export interface MemoryExpenseSummary {
  currency: string;
  /** 总额（最小货币单位字符串，避免浮点误差） */
  totalMinor: string;
  /** 待补汇率条数（不计入 total） */
  pendingRateCount: number;
  byCategory: Record<string, string>;
}

/**
 * 回忆快照（写入时刻的完整副本，不可变）。
 * 后端只含共享域数据（PERSONAL 清单绝不写入，D4 隐私）。
 */
export interface MemorySnapshot {
  schemaVersion: number;
  type: MemoryType;
  year: number;
  familyId: string;
  trip?: MemoryTripBrief;
  itinerary?: MemoryItineraryBrief[];
  expenseSummary?: MemoryExpenseSummary;
  mediaCount?: number;
  generatedAt: string;
}

/** 回忆列表项（后端 toListItem：只回摘要，不回整个快照） */
export interface MemoryArchive {
  id: string;
  familyId: string;
  year: number;
  type: MemoryType;
  /** 生成来源（TRIP 回忆为 tripId；ANNUAL 为 null） */
  refId: string | null;
  createdAt: string;
  summary: {
    tripTitle: string | null;
    memberCount: number | null;
    itineraryCount: number;
    totalMinor: string | null;
    pendingRateCount: number;
    mediaCount: number;
  };
}
