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
