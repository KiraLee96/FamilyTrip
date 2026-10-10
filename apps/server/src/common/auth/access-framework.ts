/**
 * A2 · 权限判定框架（技术方案 §4.7 / TP-02C 组 C1 + 组 D）
 * ============================================================================
 * 组 D 逐条落地：
 *   D1  资源域分派 Policy —— 由 ResourceType 推导，调用方不传维度（消除传错维度越权）
 *   D2  @RequireAccess 装饰器 —— 声明式挂权限要求
 *   D3  判定结果缓存键须纳入 role 与 access_level
 *   D4  私有资源短路：owner_id / managed_by，不回落家庭维度
 *   D5  列表层带锁占位（每人最多 1 条、不携带私有字段）
 *   D6  虚拟成员代管链：managed_by 传导（虚拟成员无 user_id）
 *   D7  历史只读：access_level=HISTORICAL_READONLY 仅可读
 *   D8  越权与不存在**逐字节一致** 404，防 ID 枚举
 *
 * 本文件是「访问控制的唯一裁决层」。域 handler 不得自行写 if 判断归属，
 * 必须经 requireAccess() / @RequireAccess 出决策 —— 否则会出现裁决口径分裂。
 */

import type {
  AccessMode,
  Identity,
  PermissionContext,
  ResourceRef,
  ResourceType,
} from './access-policy.js';
import {
  AccessDomain,
  AccessLevel,
  Decision,
  checkAccess,
  resolveChecklistDomain,
} from './access-policy.js';
import { notFoundIndistinguishable } from '../errors/error-code.js';

/**
 * 请求上下文内的权限快照（由 8 段链路的 3/4 段填充）。
 *
 * 🔴 与 access-policy.PermissionContext 的区别：
 *    PermissionContext 是**判定输入**（纯数据）；
 *    AccessSnapshot 是**运行时容器**，额外带缓存与「已加载」标记。
 */
export interface AccessSnapshot {
  identity: Identity;
  familyIds: ReadonlySet<bigint>;
  managedFamilyIds: ReadonlySet<bigint>;
  tripAccess: ReadonlyMap<bigint, AccessLevel>;
}

/** D3：缓存键 —— 必须纳入 role 与 access_level，否则权限变更后命中陈旧决策 */
export function decisionCacheKey(
  snap: AccessSnapshot,
  res: ResourceRef,
  mode: AccessMode,
): string {
  const tripLevel = res.tripId !== null && res.tripId !== undefined
    ? (snap.tripAccess.get(res.tripId) ?? 'NONE')
    : 'NONE';
  const familyRole = res.familyId !== null && res.familyId !== undefined
    ? (snap.familyIds.has(res.familyId) ? 'MEMBER' : snap.managedFamilyIds.has(res.familyId) ? 'MANAGED' : 'NONE')
    : 'NONE';
  // 关键：把 access_level 与 role 编进键
  return [
    'acl',
    snap.identity.userId.toString(),
    res.type,
    res.id.toString(),
    mode,
    `fam=${familyRole}`,
    `trip=${tripLevel}`,
    `owner=${res.ownerId ?? 'x'}`,
    `mgr=${res.managedBy ?? 'x'}`,
    `scope=${res.scope ?? 'x'}`,
  ].join('|');
}

export interface DecisionCache {
  get(key: string): boolean | undefined;
  set(key: string, allow: boolean): void;
}

/**
 * D3 决策缓存 —— 请求级（单次请求内复用，跨请求必须失效）。
 *
 * ⛔ 只做**请求内**缓存。跨请求缓存需要事件驱动失效，
 *    而权限变更（成员退出、角色调整）的失效路径尚未落地 —— 宁可多算，不可误放。
 */
export class RequestScopedDecisionCache implements DecisionCache {
  private readonly map = new Map<string, boolean>();

  get(key: string): boolean | undefined {
    return this.map.get(key);
  }

  set(key: string, allow: boolean): void {
    this.map.set(key, allow);
  }

  /** 权限变更后清空（同一请求内改了成员关系时调用） */
  invalidateAll(): void {
    this.map.clear();
  }
}

/**
 * 权限裁决入口 —— 域 handler **唯一**允许的判定调用。
 *
 * @throws AppError(4040) 越权与不存在逐字节一致（D8）
 */
export function requireAccess(
  snap: AccessSnapshot,
  res: ResourceRef,
  mode: AccessMode,
  cache?: DecisionCache,
): void {
  const key = cache ? decisionCacheKey(snap, res, mode) : null;

  if (cache && key) {
    const cached = cache.get(key);
    if (cached === true) return;
    if (cached === false) throw notFoundIndistinguishable();
  }

  const pctx: PermissionContext = {
    identity: snap.identity,
    familyIds: snap.familyIds,
    managedFamilyIds: snap.managedFamilyIds,
    tripAccess: snap.tripAccess,
  };

  const { decision } = checkAccess(pctx, res, mode);
  const allow = decision === Decision.Allow;

  if (cache && key) cache.set(key, allow);
  if (!allow) throw notFoundIndistinguishable();
}

/** 只判不抛（用于列表过滤：需要保留/剔除行） */
export function canAccess(
  snap: AccessSnapshot,
  res: ResourceRef,
  mode: AccessMode,
  cache?: DecisionCache,
): boolean {
  try {
    requireAccess(snap, res, mode, cache);
    return true;
  } catch {
    return false;
  }
}

// ── D6 虚拟成员代管链 ─────────────────────────────────────────

/**
 * 把虚拟成员的资源归属**传导到代管人**（D6 / B5）。
 *
 * 场景：虚拟成员没有 user_id，其名下的清单项 / 心愿无法通过 user_id 判定。
 * 处置：虚拟成员的私有资源，owner_id 记虚拟成员标识，
 *      同时 managed_by 记代管人 → 代管人凭 managed_by 短路通过。
 *
 * 🔴 本函数只做**归属归一化**，不做放行决策。
 *    放行仍走 requireAccess，避免「代管即越权」被写死在数据层。
 */
export interface VirtualMemberLink {
  /** 虚拟成员在 family_member / trip_member 中的行 ID */
  memberRowId: bigint;
  /** 代管人 user_id */
  managedBy: bigint;
}

/**
 * 解析「当前用户可代管的虚拟成员」集合（用于查询时展开 owner_id 的 IN 条件）。
 */
export function expandManagedOwnerIds(
  userId: bigint,
  links: readonly VirtualMemberLink[],
): bigint[] {
  const out: bigint[] = [];
  for (const link of links) {
    if (link.managedBy === userId) out.push(link.memberRowId);
  }
  // 去重：同一虚拟成员可能同时出现在 family 与 trip 两处
  return [...new Set(out)];
}

// ── D7 历史只读 ───────────────────────────────────────────────

/** 历史只读判定 —— 写/删一律拒（D7） */
export function isWriteBlockedByHistory(
  accessLevel: AccessLevel | undefined,
  mode: AccessMode,
): boolean {
  return accessLevel === AccessLevel.HistoricalReadOnly && mode !== 'READ';
}

// ── 资源域推导（D1）────────────────────────────────────────────

/**
 * 由资源类型 + 行语义推导访问域 —— **调用方不传**（D1）。
 *
 * ⛔ 不允许 handler 传 domain 参数：一旦可传，就会出现
 *    「把私有资源标成 SHARED 以放行」的越权写法。
 */
export function domainOf(res: {
  type: ResourceType;
  scope?: string;
  ownerId?: bigint | null;
}): AccessDomain {
  if (res.type === 'trip_checklist_item' || res.type === 'checklist_template') {
    return resolveChecklistDomain({ scope: res.scope, ownerId: res.ownerId ?? null });
  }
  return RESOURCE_PRIVACY[res.type] ?? AccessDomain.Shared;
}

/** 资源类型 → 隐私域（D1 静态基线；双语义表运行时再按 scope 分流） */
export const RESOURCE_PRIVACY: Record<ResourceType, AccessDomain> = {
  user: AccessDomain.Private,
  item: AccessDomain.Private,
  outfit: AccessDomain.Private,
  // 双语义 —— 运行时由 domainOf 按 scope/ownerId 分流
  checklist_template: AccessDomain.Shared,
  trip_checklist_item: AccessDomain.Shared,
  family: AccessDomain.Shared,
  family_member: AccessDomain.Shared,
  wish: AccessDomain.Shared,
  trip: AccessDomain.Shared,
  trip_member: AccessDomain.Shared,
  itinerary_item: AccessDomain.Shared,
  booking: AccessDomain.Shared,
  reminder_task: AccessDomain.Shared,
  media_asset: AccessDomain.Shared,
  memory_archive: AccessDomain.Shared,
};
