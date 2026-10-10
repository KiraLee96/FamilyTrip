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
  Expense,
  ExpenseSummary,
  Family,
  ItineraryItem,
  Trip,
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

  // ---- wish ----
  /** GET /wishes */
  listWishes(familyId?: string): Promise<Wish[]>;
  /** POST /wishes/:id/vote */
  voteWish(id: string): Promise<Wish>;

  // ---- itinerary ----
  /** GET /itineraries */
  listItineraries(tripId: string): Promise<ItineraryItem[]>;

  // ---- checklist ----
  /** GET /checklists/items */
  listChecklist(scope?: 'SHARED' | 'PERSONAL'): Promise<ChecklistItem[]>;
  /** POST /checklists/items/:id/toggle */
  toggleChecklistItem(id: string): Promise<ChecklistItem>;

  // ---- expense ----
  /** GET /expenses */
  listExpenses(tripId: string): Promise<Expense[]>;
  /** GET /expenses/summary */
  expenseSummary(tripId: string): Promise<ExpenseSummary>;
}

/** 从信封中取 data；code 非 0 抛 ApiError */
export function unwrap<T>(env: { code: number; message: string; data: T | null }): T {
  if (env.code !== 0) throw new ApiError(env.code, env.message);
  if (env.data === null) throw new ApiError(-1, '响应 data 为空');
  return env.data;
}
