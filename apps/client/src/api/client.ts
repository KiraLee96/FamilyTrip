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
  ItineraryItem,
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  MemoryType,
  PresignUploadResult,
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

  // ---- expense ----
  /** GET /expenses */
  listExpenses(tripId: string): Promise<Expense[]>;
  /** GET /expenses/summary */
  expenseSummary(tripId: string): Promise<ExpenseSummary>;

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
