/**
 * 分页助手（技术方案 §1.1 · common/ 公共层要求「分页」）
 * ---------------------------------------------------------------------------
 * 两种模式，与 `ResponseMeta` 对齐：
 *   1. 页码模式（page / pageSize）：适用于稳定、量小的列表（如成员、心愿）
 *   2. 游标模式（cursor）：适用于增量同步 / 大数据量（如回忆、行程流水）
 *
 * 🔴 红线：
 *   - `pageSize` 必须收敛到 [1, MAX_PAGE_SIZE]，禁止客户端传超大值拖垮 DB
 *   - 游标是**服务端签发的不透明串**，客户端只回传不解析（信封 meta.cursor 约定）
 *   - 分页信息一律写进 `meta`，不得塞进 `data`，保持 data 形状纯粹
 */

/** 单页上限，防止客户端传 pageSize=100000 打爆内存 */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

/** 页码分页入参（已归一化） */
export interface PageQuery {
  page: number;
  pageSize: number;
  /** Prisma skip */
  skip: number;
  /** Prisma take */
  take: number;
}

/** 游标分页入参（已归一化） */
export interface CursorQuery {
  cursor: string | null;
  take: number;
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
}

export interface CursorMeta {
  cursor?: string;
}

/** 收敛分页大小到合法区间；非法输入不抛错，按默认值兜底（列表读取不应因分页参数失败） */
export function clampPageSize(raw: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  // null / undefined / '' 一律视为「未提供」→ 兜底。
  // 注意：Number(null) === 0、Number('') === 0，若不先排除会被误判为「0 → 收敛到 1」。
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return i;
}

/**
 * 归一化页码分页参数。
 * @param rawPage     请求里的 page（从 1 开始）
 * @param rawPageSize 请求里的 pageSize
 */
export function normalizePageQuery(rawPage: unknown, rawPageSize: unknown): PageQuery {
  const p = typeof rawPage === 'number' ? rawPage : Number(rawPage);
  const page = Number.isFinite(p) && p >= 1 ? Math.floor(p) : 1;
  const pageSize = clampPageSize(rawPageSize);
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * 归一化游标分页参数。
 * @param rawCursor 请求回传的游标（不透明串，服务端不解析其内容）
 */
export function normalizeCursorQuery(rawCursor: unknown): CursorQuery {
  const cursor = typeof rawCursor === 'string' && rawCursor.length > 0 ? rawCursor : null;
  return { cursor, take: DEFAULT_PAGE_SIZE };
}

/** 由总数与页码参数构造 meta 片段 */
export function buildPageMeta(q: PageQuery, total: number): PageMeta {
  return { page: q.page, pageSize: q.pageSize, total };
}

/**
 * 由「多取一条」的结果判断是否还有下一页，并返回服务端签发的下一页游标。
 *
 * 约定：调用方按 `take + 1` 查询，把结果整体传入本函数。
 * 若返回条数 > take，说明还有下一页 —— 截断到 take，
 * 以最后一条的 `cursorOf` 结果作为下一页游标。
 *
 * @param rows     按 take+1 查询得到的结果集
 * @param take     期望页大小
 * @param cursorOf 从一条记录取游标的函数（通常为 id 或 updatedAt+id 编码）
 */
export function paginateByCursor<T>(
  rows: readonly T[],
  take: number,
  cursorOf: (row: T) => string,
): { items: T[]; meta: CursorMeta } {
  if (rows.length > take) {
    const items = rows.slice(0, take);
    // slice 后仍非空（因 rows.length > take >= 0），末元素必存在
    const last = items[items.length - 1] as T;
    return { items, meta: { cursor: cursorOf(last) } };
  }
  return { items: [...rows], meta: {} };
}
