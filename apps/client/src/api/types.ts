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
}

/** 出行状态机 */
export type TripStatus = 'DRAFT' | 'PLANNED' | 'ONGOING' | 'FINISHED' | 'CANCELLED';

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

/** 行程条目 */
export interface ItineraryItem {
  id: string;
  tripId: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  startTime?: string;
  title: string;
  location?: string;
  note?: string;
  sortOrder: number;
}

/** 清单条目 */
export interface ChecklistItem {
  id: string;
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
}

/** 记账汇总 */
export interface ExpenseSummary {
  totalCny: string;
  byMember: Array<{ memberName: string; amountCny: string }>;
  byCategory: Array<{ category: string; amountCny: string }>;
}

// ─── 媒体资产（对齐 media 域 mediaAsset 行） ───────────────────────

/** 存储分级 */
export type StorageClass = 'STANDARD' | 'IA' | 'ARCHIVE';

/**
 * 媒体资产（照片/视频登记行）。
 * 字段与后端 serializeRow(mediaAsset, MEDIA_BIGINT_FIELDS) 一字不差。
 * 注意：后端只存 fileKey，不返回访问 URL —— 展示地址由前端按存储规则拼接。
 */
export interface MediaAsset {
  id: string;
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
