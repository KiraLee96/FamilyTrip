/**
 * E8 · 并发写保护 —— 行锁增量更新 + 退位判定
 * ============================================================================
 * 两个独立问题，共用「行锁」这一基础设施：
 *
 *   ① `trip.actual_json` 行锁增量更新
 *      actual_json 是结构化大 JSON，两个成员同时编辑不同日程节点。
 *      若用「读-改-写」整字段覆盖，后写者会静默吃掉前写者的改动（lost update）。
 *      处置：先在事务内 `SELECT ... FOR UPDATE` 锁住 trip 行，
 *            再把「增量 patch」应用到磁盘上的最新 JSON，最后写回。
 *
 *      ⚠️ 行锁只解决「同一行」的并发。跨行一致性仍靠事务边界。
 *
 *   ② 主导者退位防「主导者数 = 0」
 *      trip.leader_id 可空。成员退出时若退出者恰是唯一主导者，
 *      直接把 leader_id 置空 → 出行进入「无主」状态，后续管理操作无人有权。
 *      处置：退位前在同一事务内**统计剩余 ACTIVE 成员数**；
 *            > 0 ⇒ 递补一人为主导者；= 0 ⇒ 拒绝退出并提示「先解散或转让」。
 *
 * 🔴 顺序同样重要：**先锁定 trip 行，再统计成员**。
 *    反过来的话，统计与锁定之间有窗口，两个成员可同时退出并互相认为
 *    「对方还在」，最终两人都退出、主导者数为 0。
 */

import { badRequest, versionConflict } from '../errors/error-code.js';

/** 行锁获取失败（锁等待超时 / 死锁回滚） */
export class RowLockTimeoutError extends Error {
  readonly code = 5005; // 复用跨表事务超限语义：可重试
  constructor(entity: string, id: bigint) {
    super(`锁定 ${entity}#${id} 超时（可能存在长事务或死锁），请重试`);
    this.name = 'RowLockTimeoutError';
  }
}

/**
 * 行锁执行器 —— 由 Prisma 适配层注入。
 *
 * Prisma 实现示例：
 * ```ts
 * const runner: RowLockRunner = (entity, id, fn) =>
 *   prisma.$transaction(async (tx) => {
 *     await tx.$queryRaw`SELECT id FROM trip WHERE id=${id} AND deleted_at IS NULL FOR UPDATE`;
 *     return fn({ client: tx });
 *   });
 * ```
 */
export type RowLockRunner = <T>(
  entity: string,
  id: bigint,
  fn: (tx: LockedTx) => Promise<T>,
) => Promise<T>;

export interface LockedTx {
  readonly client: unknown;
}

/** JSON Patch 风格的增量操作（只支持对象键级路径） */
export interface JsonPatchOp {
  /** `points.3.title` 形式的点分路径；不允许 `..`、不允许数组下标越界 */
  path: string;
  op: 'set' | 'remove';
  value?: unknown;
}

/**
 * 把增量 patch 应用到最新 JSON（E8 ①）。
 *
 * ⚠️ 这个是**纯函数**，必须在事务内、读回最新值之后立即调用并把结果写回。
 *    在事务外调用等价于「读-改-写」，lost update 照旧发生。
 *
 * @param current 事务内 SELECT FOR UPDATE 读回的最新 JSON
 * @param patches 客户端提交的增量
 * @returns 新 JSON（不修改入参，深拷贝修改路径上的节点）
 */
export function applyJsonPatch(
  current: Record<string, unknown>,
  patches: readonly JsonPatchOp[],
): Record<string, unknown> {
  // 浅拷贝根 + 逐层拷贝修改路径，避免污染 current
  const root: Record<string, unknown> = { ...current };

  for (const patch of patches) {
    const segments = parsePath(patch.path);
    if (segments.length === 0) {
      // 空路径：整对象替换
      if (patch.op === 'remove') {
        throw badRequest('不支持删除根对象；请提交具体字段路径');
      }
      if (typeof patch.value !== 'object' || patch.value === null || Array.isArray(patch.value)) {
        throw badRequest('根对象替换要求 value 为对象');
      }
      Object.assign(root, patch.value as Record<string, unknown>);
      continue;
    }

    applyAtPath(root, segments, patch);
  }

  return root;
}

function parsePath(path: string): string[] {
  if (typeof path !== 'string') throw badRequest('patch.path 必须为字符串');
  const trimmed = path.trim();
  if (trimmed === '') return [];
  if (trimmed.includes('..')) throw badRequest(`非法路径 "${path}"（不允许连续点）`);
  const segs = trimmed.split('.');
  for (const s of segs) {
    // 拒绝原型污染路径
    if (s === '__proto__' || s === 'constructor' || s === 'prototype') {
      throw badRequest(`非法路径 "${path}"（禁止原型链污染）`);
    }
  }
  return segs;
}

function applyAtPath(root: Record<string, unknown>, segments: string[], patch: JsonPatchOp): void {
  let cursor: unknown = root;

  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i] as string;

    if (Array.isArray(cursor)) {
      const idx = arrayIndex(key, cursor.length);
      if (cursor[idx] === undefined) {
        cursor[idx] = {};
      }
      cursor = cursor[idx];
      continue;
    }

    if (isPlainObject(cursor)) {
      const next = cursor[key];
      if (Array.isArray(next)) {
        // 拷贝该层，保持函数纯净
        cursor[key] = [...(next as unknown[])];
      } else if (isPlainObject(next)) {
        cursor[key] = { ...next };
      } else {
        // 路径不存在 → 按「向上生长」处理（增量 patch 常见语义）
        cursor[key] = {};
      }
      cursor = cursor[key];
      continue;
    }

    throw badRequest(`路径 "${segments.join('.')}" 中途遇到非容器节点，无法下钻`);
  }

  const leaf = segments[segments.length - 1] as string;

  if (patch.op === 'remove') {
    if (Array.isArray(cursor)) {
      // 数组删除用 splice，避免留洞（delete 会留下 undefined，JSON 序列化成 null）
      cursor.splice(arrayIndex(leaf, cursor.length), 1);
      return;
    }
    if (isPlainObject(cursor)) {
      delete cursor[leaf];
      return;
    }
    throw badRequest('remove 的目标必须是对象或数组');
  }

 // set
  if (Array.isArray(cursor)) {
    const idx = arrayIndex(leaf, cursor.length, /* allowAppend */ true);
    if (idx === cursor.length) cursor.push(patch.value);
    else cursor[idx] = patch.value;
    return;
  }
  if (isPlainObject(cursor)) {
    cursor[leaf] = patch.value;
    return;
  }
  throw badRequest('set 的目标必须是对象或数组');
}

function arrayIndex(key: string, length: number, allowAppend = false): number {
  if (!/^\d+$/.test(key)) throw badRequest(`数组路径段 "${key}" 必须为非负整数`);
  const idx = Number(key);
  const max = allowAppend ? length : length - 1;
  if (idx > max) throw badRequest(`数组下标 ${idx} 越界（当前长度 ${length}）`);
  return idx;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── E8 ② 主导者退位 ────────────────────────────────────────────

/** 成员退出时对主导者的处置 */
export type LeaderSuccession =
  | { action: 'KEEP'; leaderId: bigint; reason: '退位者不是主导者' }
  | { action: 'PROMOTE'; leaderId: bigint; reason: '唯一主导者退出，递补一名 ACTIVE 成员' }
  | { action: 'REFUSE'; reason: '退位者是最后一名成员，无法递补主导者' };

/**
 * 决定成员退出时主导者如何处置。
 *
 * 🔴 必须在**同一事务内、且已锁定 trip 行之后**调用（见文件头注释）。
 *
 * @param leavingUserId  退出的用户
 * @param currentLeaderId 当前主导者（可空：出行本就无主）
 * @param remainingActiveUserIds 除退位者外，仍为 ACTIVE 的成员（按加入时间升序）
 */
export function decideLeaderSuccession(params: {
  leavingUserId: bigint;
  currentLeaderId: bigint | null;
  remainingActiveUserIds: readonly bigint[];
}): LeaderSuccession {
  const { leavingUserId, currentLeaderId, remainingActiveUserIds } = params;

  // 退位者不是主导者（或本就没主导者）→ 不变量不涉及，保持
  if (currentLeaderId === null || currentLeaderId !== leavingUserId) {
    if (currentLeaderId === null) {
      // 无主状态：若仍有成员，本次顺带递补一个（自愈）
      const heir = remainingActiveUserIds[0];
      if (heir !== undefined) {
        return { action: 'PROMOTE', leaderId: heir, reason: '唯一主导者退出，递补一名 ACTIVE 成员' };
      }
      return { action: 'REFUSE', reason: '退位者是最后一名成员，无法递补主导者' };
    }
    return { action: 'KEEP', leaderId: currentLeaderId, reason: '退位者不是主导者' };
  }

  // 退位者就是主导者 → 必须保证退出后主导者数 ≥ 1
  const heir = remainingActiveUserIds[0];
  if (heir === undefined) {
    // 没有可递补的人 → 拒绝退出，客户端应提示「先转让或解散」
    return { action: 'REFUSE', reason: '退位者是最后一名成员，无法递补主导者' };
  }
  return { action: 'PROMOTE', leaderId: heir, reason: '唯一主导者退出，递补一名 ACTIVE 成员' };
}

/** 退位被拒时抛的业务错误（HTTP 409，提示走转让/解散） */
export function leaderAbdicationRefused(remainingActive: number): Error {
  if (remainingActive > 0) {
    // 理论上不该走到这里；留作防御
    return versionConflict();
  }
  return badRequest(
    '你是该出行的最后一名成员，无法直接退出。请先「转让主导者」或「解散出行」。',
    { code: 'LAST_MEMBER_CANNOT_LEAVE' },
  );
}

/**
 * 行锁 + patch 的应用入口（E8 ① 的编排骨架）。
 *
 * 语义：
 *   1. 在 runner 提供的事务 + 行锁内执行
 *   2. `readCurrent` 必须走 SELECT ... FOR UPDATE 读到的行
 *   3. patch 应用到最新值 → `writeBack` 写回
 *
 * ⛔ readCurrent / writeBack 都**不得**做网络 I/O（见 transaction.ts 红线）。
 */
export async function withJsonPatch<T>(
  runner: RowLockRunner,
  entity: string,
  id: bigint,
  readCurrent: (tx: LockedTx) => Promise<Record<string, unknown>>,
  writeBack: (tx: LockedTx, next: Record<string, unknown>) => Promise<T>,
  patches: readonly JsonPatchOp[],
): Promise<T> {
  return runner(entity, id, async (tx) => {
    const current = await readCurrent(tx);
    const next = applyJsonPatch(current, patches);
    return writeBack(tx, next);
  });
}
