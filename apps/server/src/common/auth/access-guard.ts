/**
 * A2 · 权限 Guard（D1–D8 运行时执行点）
 * ============================================================================
 * 职责：把「@RequireAccess 声明的意图」翻译成「requireAccess() 的运行时裁决」。
 *
 * 链路位置：8 段中间件链的第 5 段（withOwner）之后、validate 之前。
 * 为什么必须在 validate 之前：未鉴权请求不应打到校验器（浪费 CPU，且
 * 校验错误信息本身可能泄漏字段存在性）。
 *
 * 🔴 三条硬约束：
 *   1. 未标注且非 @Public 的路由 → **默认拒绝**（fail-closed），不是放行。
 *   2. 资源 ID 取不到 / 非法 → 与「不存在」同形 404（D8）。
 *   3. 私有资源（PRIVATE 域）不得因为「传了 familyId」而被放行 ——
 *      ResourceRef 的 familyId 由**资源行**决定，不由请求参数决定。
 */

import type { AccessLevel, ResourceRef, ResourceType } from './access-policy.js';
import { AccessLevel as AccessLevelEnum } from './access-policy.js';
import { getRequireAccessMeta, isPublicHandler } from './require-access.js';
import type {
  RequestScopedDecisionCache} from './access-framework.js';
import {
  requireAccess,
  type AccessSnapshot,
} from './access-framework.js';
import { notFoundIndistinguishable, unauthorized } from '../errors/error-code.js';

/** 资源行（由数据层加载）—— 决定 familyId / tripId / ownerId 的**唯一**来源 */
export interface ResourceRow {
  id: bigint;
  familyId?: bigint | null;
  tripId?: bigint | null;
  ownerId?: bigint | null;
  managedBy?: bigint | null;
  scope?: string;
}

export interface GuardDeps {
  /** 加载资源行；返回 null = 不存在 */
  loadResourceRow(type: ResourceType, id: bigint): Promise<ResourceRow | null>;
  /** 构造当前请求的权限快照（来自链路 3/4 段） */
  snapshot(): AccessSnapshot;
  /** 请求级决策缓存（可选） */
  cache?: RequestScopedDecisionCache;
}

export interface GuardInput {
  /** handler 方法引用（用于读装饰器元数据） */
  handler: object;
  /** 从请求中取资源 ID 的原始值 */
  rawId?: string;
}

/**
 * 执行权限 Guard。
 *
 * @throws AppError 401（未登录）/ 404（越权或不存在，同形）
 */
export async function runAccessGuard(deps: GuardDeps, input: GuardInput): Promise<void> {
  // 显式公开路由：放行（登录、健康检查等）
  if (isPublicHandler(input.handler)) return;

  const meta = getRequireAccessMeta(input.handler);
  if (!meta) {
    // 🔴 fail-closed：未声明的路由默认拒绝。
    // 若这里放行，任何漏标注的新接口都会变成公开接口 —— 越权就从「漏洞」变成「默认行为」。
    throw unauthorized('该接口未声明访问策略，已拒绝（fail-closed）');
  }

  // 无资源 ID：集合类接口（列表/创建），权限由作用域过滤而非单资源裁决
  if (input.rawId === undefined || input.rawId === '') return;

  const id = parseId(input.rawId);
  if (id === null) throw notFoundIndistinguishable();

  const row = await deps.loadResourceRow(meta.resource, id);
  if (row === null) throw notFoundIndistinguishable();

  const ref = toResourceRef(meta.resource, row);
  requireAccess(deps.snapshot(), ref, meta.mode, deps.cache);
}

/**
 * 🔴 资源行 → ResourceRef 的唯一转换点。
 *
 * 关键：familyId / tripId / ownerId **全部来自资源行**，不接受请求参数。
 * 若从请求参数取 familyId，攻击者只要传一个自己所属的 familyId，
 * 就能让任意资源「看起来属于我的家庭」—— 这是最经典的越权写法。
 */
export function toResourceRef(type: ResourceType, row: ResourceRow): ResourceRef {
  return {
    type,
    id: row.id,
    familyId: row.familyId ?? null,
    tripId: row.tripId ?? null,
    ownerId: row.ownerId ?? null,
    managedBy: row.managedBy ?? null,
    // 双语义表的 scope 也必须来自资源行
    ...(row.scope !== undefined ? { scope: row.scope } : {}),
  };
}

/** 严格十进制 ID 解析；非法返回 null（由调用方转 404 同形） */
export function parseId(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const id = BigInt(raw);
    return id > 0n ? id : null;
  } catch {
    return null;
  }
}

/**
 * 构造「集合接口」的作用域过滤条件。
 *
 * 列表接口不走单资源裁决，但**必须**按调用者可见范围过滤，
 * 否则会退化成「列出全库」。
 *
 * ⚠️ 返回的是**并集**条件：家庭维度 ∪ 出行维度。
 *    私有资源（个人清单/物品/穿搭）另由 `privateOwnerFilter` 处理，
 *    它的语义是「等于我 or 我代管的虚拟成员」，**不参与并集**。
 */
export interface ScopeFilter {
  familyIds: bigint[];
  tripIds: bigint[];
}

export function buildScopeFilter(snap: AccessSnapshot): ScopeFilter {
  return {
    familyIds: [...snap.familyIds, ...snap.managedFamilyIds],
    tripIds: [...snap.tripAccess.keys()],
  };
}

/**
 * 私有资源的 owner 过滤条件（D4 短路的数据层表达）。
 *
 * @param userId         当前用户
 * @param managedOwnerIds 该用户代管的虚拟成员行 ID（见 access-framework.expandManagedOwnerIds）
 */
export function privateOwnerFilter(userId: bigint, managedOwnerIds: readonly bigint[]): {
  ownerId: { in: bigint[] };
} {
  return { ownerId: { in: [userId, ...managedOwnerIds] } };
}

/**
 * 历史只读：给查询附加 access_level 限制。
 *
 * 用于「成员退出后仍可读其历史贡献」的场景（B6 / C15）。
 */
export function historicalReadableLevels(mode: 'READ' | 'WRITE' | 'DELETE'): readonly AccessLevel[] {
  return mode === 'READ'
    ? ([AccessLevelEnum.Active, AccessLevelEnum.HistoricalReadOnly] as const)
    : ([AccessLevelEnum.Active] as const);
}
