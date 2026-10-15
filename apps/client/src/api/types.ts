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

/** 登记媒体资产入参（POST /media/confirm） */
export interface ConfirmMediaAssetInput {
  tripId?: string;
  fileKey: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
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
