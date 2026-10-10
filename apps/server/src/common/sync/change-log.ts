/**
 * 多端同步（技术方案 §4.6 / TP-02B · 组 B1 + 组 E）
 * ============================================================================
 * 设计要点（逐条对应清单项）：
 *
 *   B1   change_log 缺可靠游标，存在漏单风险
 *        → 游标 = `(changed_at, id)` **复合键**，不是单列 changed_at。
 *          同一毫秒内多条变更时，只按 changed_at 分页会在边界处漏单/重单。
 *          复合键保证全序：`ORDER BY changed_at ASC, id ASC`。
 *
 *   E1   change_log 一期就建（原定二期）→ 见 prisma ChangeLog
 *   E2   服务端时间源：changed_at 取 **DB 时间**，⛔ 禁用应用服务器 new Date()
 *        → 同步游标跨实例必须单调，应用服务器时钟漂移会撕裂游标。
 *   E3   短轮询接口：`GET /sync/changes?cursor=...`
 *   E4   受限快照：首次全量 bootstrap 也走 change_log 受限裁剪（不返回他人私有）
 *   E5   增量合并：客户端按 op 应用（INSERT/UPDATE/DELETE 幂等）
 *   E6   游标签发：服务端签发不透明串，客户端只回传不解析
 *   E7   并发写保护（CAS 乐观锁）→ 见 common/concurrency/optimistic-lock.ts
 *   E8   行锁增量 + 退位判定 → 见 domains/trip
 *
 * 🔴 核心不变量：**同一条变更绝不重复下发、也绝不下发两次不同内容**。
 *    游标单调 + 严格 > 比较，是这条不变量的全部依据。
 */

/** 变更操作类型 */
export type ChangeOp = 'INSERT' | 'UPDATE' | 'DELETE';

/** 一条变更记录（change_log 行） */
export interface ChangeRecord {
  /** 雪花 ID（同一 changed_at 内的次排序键） */
  id: bigint;
  entityType: string;
  entityId: bigint;
  familyId: bigint | null;
  tripId: bigint | null;
  op: ChangeOp;
  /** 🔴 服务端时间源（DB 时间） */
  changedAt: Date;
}

/**
 * 同步游标 —— `(changedAt, id)` 复合。
 *
 * ⛔ 不允许把游标简化成 base64(changedAt) 单值：
 * 同一毫秒内的多条变更会共享 changedAt，翻页边界处必然漏单。
 */
export interface SyncCursor {
  changedAt: Date;
  id: bigint;
}

/** 游标编码形态：`<epochMillis>:<id>` —— 对客户端不透明 */
const CURSOR_SEP = ':';

/**
 * 编码游标。
 *
 * @throws 非法游标直接抛错 —— 宁可让客户端重置全量，也不要用半个游标去查，
 *         那会导致「看起来成功、实际漏了一段时间的变更」。
 */
export function encodeCursor(cursor: SyncCursor): string {
  if (!(cursor.changedAt instanceof Date) || Number.isNaN(cursor.changedAt.getTime())) {
    throw new TypeError('encodeCursor: changedAt 非法');
  }
  if (typeof cursor.id !== 'bigint' || cursor.id < 0n) {
    throw new TypeError('encodeCursor: id 必须为非负 bigint');
  }
  return `${cursor.changedAt.getTime()}${CURSOR_SEP}${cursor.id.toString()}`;
}

/** 解码游标；非法（含被篡改）一律返回 null，由调用方决定是否回落全量 */
export function decodeCursor(raw: string | null | undefined): SyncCursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const idx = raw.indexOf(CURSOR_SEP);
  if (idx <= 0) return null;

  const millisPart = raw.slice(0, idx);
  const idPart = raw.slice(idx + 1);

  // 严格数字校验：`Number('1e5')` 会通过，故用正则先卡住
  if (!/^\d+$/.test(millisPart) || !/^\d+$/.test(idPart)) return null;

  const millis = Number(millisPart);
  if (!Number.isSafeInteger(millis) || millis < 0) return null;

  try {
    return { changedAt: new Date(millis), id: BigInt(idPart) };
  } catch {
    return null;
  }
}

/**
 * 变更查询条件 —— **严格大于**游标。
 *
 * 为什么必须严格 `>`（而不是 `>=`）：
 *   若用 `>=`，客户端每次重传同一个游标都会再次收到游标处那一条，
 *   虽然「重复下发」对幂等客户端无害，但会让「是否还有更多」的判定失真，
 *   表现为客户端停不下来地拉取最后一条。
 *
 * 复合条件展开（与 idx_cursor (changed_at, id) 索引对位）：
 *   `changed_at > c.changed_at`
 *      OR (`changed_at = c.changed_at` AND `id > c.id`)
 */
export interface ChangeQuery {
  /** 严格大于该游标；null 表示从头（但受 lookback 限制，见下） */
  after: SyncCursor | null;
  /** 作用域：家庭（B1 同步按家庭隔离，⛔ 不跨家庭下发） */
  familyIds: readonly bigint[];
  /** 作用域：出行（可选收窄） */
  tripId?: bigint | null;
  /** 只订阅这些实体类型；空数组 = 全部 */
  entityTypes?: readonly string[];
  /** 单页条数（take+1 由调用方处理） */
  limit: number;
}

/**
 * 首次同步（无游标）时的起点。
 *
 * 🔴 不能从「时间零点」开始 —— 那会把历史全库变更下发一遍，
 *    既慢又可能命中已删除的实体。约定：无游标时由调用方先做
 *    受限快照 bootstrap（E4），再以「快照时刻」作为游标起点。
 */
export function initialCursorFrom(snapshotAt: Date): SyncCursor {
  return { changedAt: snapshotAt, id: 0n };
}

/** 变更页 */
export interface ChangePage {
  items: ChangeRecord[];
  /** 服务端签发的下一页游标；null = 已追平 */
  nextCursor: string | null;
  /** 是否还有更多（服务端据此判定，客户端不自行推断） */
  hasMore: boolean;
}

/**
 * 把 `take+1` 条查询结果切成页。
 *
 * 判据：返回条数 > take ⇒ 还有下一页。此时**末条游标作为下一页游标**。
 *
 * ⚠️ 注意末条语义：因为查询是严格 `>`，末条本身就是「已消费到」的位置，
 *    所以下一页游标 = 末条游标，这样不会重复下发末条。
 */
export function paginateChanges(rows: readonly ChangeRecord[], take: number): ChangePage {
  if (take < 1) throw new RangeError(`paginateChanges: take 必须 ≥1，实际 ${take}`);

  if (rows.length > take) {
    const items = rows.slice(0, take);
    const last = items[items.length - 1] as ChangeRecord;
    return {
      items: [...items],
      nextCursor: encodeCursor({ changedAt: last.changedAt, id: last.id }),
      hasMore: true,
    };
  }

  return { items: [...rows], nextCursor: null, hasMore: false };
}

/**
 * 把一页变更按客户端已持有状态做**增量合并**（E5）。
 *
 * 语义（对同一 entityId 的多条变更，按游标顺序依次应用）：
 *   INSERT  → 新增（本地已存在则覆盖，容忍重复下发）
 *   UPDATE  → 覆盖（本地不存在则视为「先漏了 INSERT」→ 标记需回补）
 *   DELETE  → 移除（本地不存在则忽略，容忍重复下发）
 *
 * 🔴 返回 `needsBackfill`：出现「本地没有却被 UPDATE」的实体。
 *    这正是漏单的**检测器** —— 客户端据此触发单实体回补，而不是装作没发生。
 */
export interface MergeState<T> {
  /** 客户端本地状态：entityId → 实体 */
  local: Map<string, T>;
}

export interface MergeOutcome<T> {
  state: Map<string, T>;
  /** 需回补的 entityId（收到 UPDATE 但本地不存在） */
  needsBackfill: string[];
  /** 实际变动条数（排除重复下发） */
  applied: number;
}

/**
 * @param local     客户端本地状态（不修改入参，返回新 Map）
 * @param changes   按游标顺序排列的变更
 * @param revive    从 change_log 记录 + 额外载荷取回完整实体；
 *                  DELETE 时不会被调用
 */
export function mergeChanges<T>(
  local: ReadonlyMap<string, T>,
  changes: readonly ChangeRecord[],
  revive: (change: ChangeRecord) => T | Promise<T>,
): Promise<MergeOutcome<T>>;

export function mergeChanges<T>(
  local: ReadonlyMap<string, T>,
  changes: readonly ChangeRecord[],
  revive: (change: ChangeRecord) => T | Promise<T>,
): Promise<MergeOutcome<T>> | MergeOutcome<T> {
  const state = new Map<string, T>(local);
  const needsBackfill: string[] = [];
  let applied = 0;

  const applyAll = async (): Promise<MergeOutcome<T>> => {
    for (const change of changes) {
      const key = `${change.entityType}:${change.entityId}`;

      if (change.op === 'DELETE') {
        if (state.delete(key)) applied += 1;
        continue;
      }

      if (change.op === 'UPDATE' && !state.has(key)) {
        // 断链：本地没有这个实体却收到 UPDATE → 之前漏了 INSERT
        needsBackfill.push(key);
      }

      state.set(key, await revive(change));
      applied += 1;
    }
    return { state, needsBackfill, applied };
  };

  // revive 可能是同步的，统一 return promise 让调用方 await 一致
  return applyAll();
}

/**
 * 合并同一实体的连续变更，减少下发量（服务端可选优化）。
 *
 * 🔴 折叠规则必须保守：**只折叠同实体、相邻、且中间无其他实体的变更**。
 *    更激进的折叠（如跨实体合并）会改变客户端观察到的中间态。
 */
export function coalesceChanges(rows: readonly ChangeRecord[]): ChangeRecord[] {
  const out: ChangeRecord[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.entityType === row.entityType &&
      prev.entityId === row.entityId &&
      // 连续两条同实体：保留**操作语义**，但用较晚的时间戳
      canCoalesce(prev.op, row.op)
    ) {
      out[out.length - 1] = { ...row, op: coalesceOp(prev.op, row.op) };
      continue;
    }
    out.push(row);
  }
  return out;
}

/** INSERT→UPDATE = INSERT；DELETE 后任何操作只有 DELETE 有意义（后续变更不会通过软删过滤器） */
function canCoalesce(prev: ChangeOp, next: ChangeOp): boolean {
  if (prev === 'DELETE') return false; // DELETE 之后应无同实体变更；若有，保守保留
  if (prev === 'INSERT' && next === 'UPDATE') return true;
  if (prev === 'UPDATE' && next === 'UPDATE') return true;
  // INSERT→DELETE 也可折叠为 DELETE（实体从未对客户端可见）
  if (prev === 'INSERT' && next === 'DELETE') return true;
  return false;
}

function coalesceOp(prev: ChangeOp, next: ChangeOp): ChangeOp {
  if (prev === 'INSERT' && next === 'DELETE') return 'DELETE';
  if (prev === 'INSERT') return 'INSERT';
  return next;
}

/**
 * 记录一次变更（写入 change_log）。
 *
 * 🔴 必须在**业务写事务内**调用 —— 变更日志与业务数据不同事务，
 *    会出现「数据写了但日志没写」（客户端永远看不到）或反之（客户端看到不存在的实体）。
 */
export interface ChangeLogWriter {
  append(input: {
    entityType: string;
    entityId: bigint;
    familyId: bigint | null;
    tripId: bigint | null;
    op: ChangeOp;
    /** 由 DB 提供（NOW(3)），⛔ 不传应用服务器时间 */
  }): Promise<void>;
}

/** 变更读取仓储 —— 生产用 Prisma；投影片段见注释里的复合条件 */
export interface ChangeLogReader {
  /**
   * 按复合游标取下一页。
   *
   * 实现须翻译为：
   * ```sql
   * WHERE (changed_at > :cAt) OR (changed_at = :cAt AND id > :cid)
   *   AND family_id IN (:familyIds)
   * ORDER BY changed_at ASC, id ASC
   * LIMIT :takePlus1
   * ```
   */
  fetchAfter(q: ChangeQuery): Promise<ChangeRecord[]>;
}

/**
 * 生产查询构造器 —— 单点收敛「复合游标」翻译。
 *
 * 单测覆盖本函数即可保证 SQL 语义正确；仓储实现只负责把返回值塞进 Prisma。
 */
export function buildCursorPredicate(after: SyncCursor | null): {
  OR?: Array<Record<string, unknown>>;
} {
  if (after === null) return {}; // 无游标 = 无下界（调用方须先 bootstrap）
  return {
    OR: [
      { changedAt: { gt: after.changedAt } },
      { changedAt: after.changedAt, id: { gt: after.id } },
    ],
  };
}
