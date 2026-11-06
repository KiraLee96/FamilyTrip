/**
 * 权限判定（技术方案 §4.7 / TP-02C 组 D）
 * ---------------------------------------------------------------------------
 * 🔴 PRIVATE 短路是防越权的关键：私有资源**绝不能**被「我是家庭成员」放行。
 *
 * ```
 * isPrivate(resource)
 *   ? owner_id = U OR managed_by = U      ← 短路，不满足即拒，不参与下方OR 合并
 *   : family维度(U ∈ R.family) ∨ trip 维度(U ∈ R.trip)
 * ```
 *
 * 维度由 Policy 按资源类型**自行推导**，调用方不传 —— 消除「传错维度导致越权」。
 */

export type ResourceType =
  | 'user'
  | 'family'
  | 'family_member'
  | 'wish'
  | 'trip'
  | 'trip_member'
  | 'itinerary_item'
  | 'booking'
  | 'checklist_template'
  | 'trip_checklist_item'
  | 'item'
  | 'outfit'
  | 'reminder_task'
  | 'media_asset'
  | 'memory_archive';

export type AccessMode = 'READ' | 'WRITE' | 'DELETE';

export const enum AccessDomain {
  /** 私有：仅 owner_id = U OR managed_by = U */
  Private = 'PRIVATE',
  /** 共享：家庭 ∨ 出行 */
  Shared = 'SHARED',
}

/**
 * 资源域映射 —— 决定走短路还是OR 合并。
 *
 * 🔴 私有资源三件套：私人清单 / 个人物品库 / 个人穿搭。
 * 判定依据是**资源本身的语义**，不是「当前用户是谁」。
 */
export const RESOURCE_DOMAIN: Record<ResourceType, AccessDomain> = {
  user: AccessDomain.Private,
  // 私人清单模板 / 私人清单实例 / 个人物品库 / 个人穿搭
  checklist_template: AccessDomain.Shared, // 域由 owner_id 决定，运行时再分流
  trip_checklist_item: AccessDomain.Shared,
  item: AccessDomain.Private,
  outfit: AccessDomain.Private,
  family_member: AccessDomain.Shared,
  family: AccessDomain.Shared,
  wish: AccessDomain.Shared,
  trip: AccessDomain.Shared,
  trip_member: AccessDomain.Shared,
  itinerary_item: AccessDomain.Shared,
  booking: AccessDomain.Shared,
  reminder_task: AccessDomain.Shared,
  media_asset: AccessDomain.Shared,
  memory_archive: AccessDomain.Shared,
};

/**
 * 清单类资源是**双语义**表：`scope` 字段决定域
 * （SHARED / PERSONAL，见技术方案 chk_tci_scope_owner 约束）。
 */
export function resolveChecklistDomain(row: {
  scope?: string;
  ownerId?: bigint | null;
}): AccessDomain {
  return row.scope === 'PERSONAL' || (row.ownerId !== null && row.ownerId !== undefined)
    ? AccessDomain.Private
    : AccessDomain.Shared;
}

export interface Identity {
  userId: bigint;
}

export interface PermissionContext {
  identity: Identity;
  /** U 所属的家庭 ID 集合（O(1) 命中，用 Set 不用 Array.includes） */
  familyIds: ReadonlySet<bigint>;
  /** U 参与的出行 ID → 访问级别 */
  tripAccess: ReadonlyMap<bigint, AccessLevel>;
  /** U 作为代管人的虚拟成员所属家庭 */
  managedFamilyIds: ReadonlySet<bigint>;
}

export const enum AccessLevel {
  Active = 'ACTIVE',
  HistoricalReadOnly = 'HISTORICAL_READONLY',
}

export const enum Role {
  Owner = 'OWNER',
  Member = 'MEMBER',
  Leader = 'LEADER',
}

export interface ResourceRef {
  type: ResourceType;
  id: bigint;
  /** 共享域归属 */
  familyId?: bigint | null;
  tripId?: bigint | null;
  /** 私有域归属 */
  ownerId?: bigint | null;
  managedBy?: bigint | null;
  /** 清单类资源的双语义标记 */
  scope?: string;
}

export const enum Decision {
  Allow = 'ALLOW',
  Deny = 'DENY',
}

/** 判定维度 —— D3 要求缓存键纳入角色与 access_level */
export interface DecisionDetail {
  dimension: 'PRIVATE_OWNER' | 'PRIVATE_MANAGER' | 'FAMILY' | 'TRIP' | 'TRIP_HISTORICAL' | 'NONE';
  role?: Role;
  accessLevel?: AccessLevel;
}

/**
 * 媒体资产是**双语义**表：`family_id` / `trip_id` 都为空 → 纯用户资产（头像）。
 *
 * 2026-11-05（派发单 §4）：头像不再绑定家庭，`media_asset.family_id` 放宽为 NULL。
 * 若不在这里分流，`checkShared` 会因为「没有家庭维度、没有出行维度」直接 Deny ——
 * 表现为「用户删不掉/读不到自己的头像」。
 *
 * 🔴 只在**两者都为空**时短路：带 familyId 的家庭照片仍必须走家庭维度，
 *    绝不能因为「我是上传者」就绕过家庭成员门。
 */
export function isPersonalMedia(res: {
  familyId?: bigint | null;
  tripId?: bigint | null;
}): boolean {
  return (
    (res.familyId === null || res.familyId === undefined) &&
    (res.tripId === null || res.tripId === undefined)
  );
}

/**
 * 统一权限判定。
 *
 * ⛔ 越权一律返回 Deny，由调用方转成**与「不存在」逐字节一致**的 404。
 */
export function checkAccess(
  ctx: PermissionContext,
  res: ResourceRef,
  mode: AccessMode,
): { decision: Decision; detail: DecisionDetail } {
  // 清单类：先按 scope 分流
  if (res.type === 'trip_checklist_item' || res.type === 'checklist_template') {
    const domain = resolveChecklistDomain({ scope: res.scope, ownerId: res.ownerId ?? null });
    if (domain === AccessDomain.Private) {
      return checkPrivate(ctx, res);
    }
  } else if (RESOURCE_DOMAIN[res.type] === AccessDomain.Private) {
    return checkPrivate(ctx, res);
  } else if (res.type === 'media_asset' && isPersonalMedia(res)) {
    // 头像等纯用户资产：owner 短路，不参与家庭/出行 OR 合并
    return checkPrivate(ctx, res);
  }

  return checkShared(ctx, res, mode);
}

/** 🔴 PRIVATE 短路：只认 owner_id / managed_by，不参与家庭·出行 OR 合并 */
function checkPrivate(
  ctx: PermissionContext,
  res: ResourceRef,
): { decision: Decision; detail: DecisionDetail } {
  const u = ctx.identity.userId;

  if (res.ownerId !== null && res.ownerId !== undefined && res.ownerId === u) {
    return { decision: Decision.Allow, detail: { dimension: 'PRIVATE_OWNER' } };
  }
  if (res.managedBy !== null && res.managedBy !== undefined && res.managedBy === u) {
    return { decision: Decision.Allow, detail: { dimension: 'PRIVATE_MANAGER' } };
  }
  // 关键：这里**不**回落到家庭/出行维度
  return { decision: Decision.Deny, detail: { dimension: 'NONE' } };
}

function checkShared(
  ctx: PermissionContext,
  res: ResourceRef,
  mode: AccessMode,
): { decision: Decision; detail: DecisionDetail } {
  // 家庭维度
  if (res.familyId !== null && res.familyId !== undefined) {
    const inFamily = ctx.familyIds.has(res.familyId) || ctx.managedFamilyIds.has(res.familyId);
    if (inFamily) {
      const role = ctx.familyIds.has(res.familyId) ? Role.Member : Role.Member;
      return { decision: Decision.Allow, detail: { dimension: 'FAMILY', role } };
    }
  }

  // 出行维度
  if (res.tripId !== null && res.tripId !== undefined) {
    const level = ctx.tripAccess.get(res.tripId);
    if (level !== undefined) {
      if (level === AccessLevel.HistoricalReadOnly && mode !== 'READ') {
        // 历史只读：仅允许读，写/删一律拒
        return { decision: Decision.Deny, detail: { dimension: 'NONE', accessLevel: level } };
      }
      const dimension = level === AccessLevel.HistoricalReadOnly ? 'TRIP_HISTORICAL' : 'TRIP';
      return {
        decision: Decision.Allow,
        detail: { dimension, accessLevel: level, role: Role.Member },
      };
    }
  }

  return { decision: Decision.Deny, detail: { dimension: 'NONE' } };
}

/**
 * 列表层「带锁占位」聚合（TP-02C D5 签认口径）。
 *
 * 三条硬约束：
 *   1. 不逐条返回 —— 每位成员最多 1 条聚合占位，⛔ 不返回私有项数量
 *   2. 不携带任何私有字段 —— 无 owner_id / item_id / name / 金额
 *   3. ownerDisplayName 白名单 —— 仅取家庭成员公开昵称
 */
export interface LockedPrivatePlaceholder {
  type: 'LOCKED_PRIVATE';
  ownerDisplayName: string;
}

/**
 * 把「某成员有私有内容但当前用户无权查看」折叠成**每位成员 1 条**无信息占位。
 *
 * @param ownerIdsWithPrivateContent 存在私有内容的 owner_id 集合
 * @param displayNameOf 仅接受家庭成员公开昵称的查表函数
 * @param userId当前用户
 */
export function buildLockedPlaceholders(
  ownerIdsWithPrivateContent: Iterable<bigint>,
  displayNameOf: (ownerId: bigint) => string | null,
  userId: bigint,
): LockedPrivatePlaceholder[] {
  // Set 去重 —— 天然满足「每位成员最多 1 条」
  const uniqueOwners = new Set(ownerIdsWithPrivateContent);
  const out: LockedPrivatePlaceholder[] = [];

  for (const ownerId of uniqueOwners) {
    // 自己的私有内容正常返回，不占位
    if (ownerId === userId) continue;
    const name = displayNameOf(ownerId);
    // 不在家庭成员公开昵称白名单内 → 不产出占位（避免泄漏存在性）
    if (name === null) continue;
    out.push({ type: 'LOCKED_PRIVATE', ownerDisplayName: name });
  }
  return out;
}
