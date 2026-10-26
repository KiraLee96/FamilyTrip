/**
 * A2 · @RequireAccess 装饰器 + 权限矩阵（C1 / D1–D8）
 * ============================================================================
 * 两张清单：
 *
 *   ① `PERMISSION_MATRIX` —— 权限矩阵（资源类型 × 操作）。
 *      行语义 = `(resource, mode)`，角色维度收在 `roles` 字段。
 *      规模 = 15 资源 / 43 行，由 `assertMatrixSize()` 在启动与 CI 期强制。
 *      它是**唯一权威口径**，CI 门禁据它校验每个路由的声明是否与矩阵一致。
 *
 *   ② `@RequireAccess(...)` —— 声明式权限标注。
 *      域 controller 在方法上标注资源类型与访问模式；
 *      Guard 在运行时据此构造 ResourceRef 并调 requireAccess()。
 *
 * 🔴 CI 门禁（A2 交付物之一）：
 *    遍历所有 controller 方法，要求：
 *      · 每个非 public 路由必须标注 @RequireAccess 或显式 @Public()
 *      · 标注的 (resource, mode) 组合必须存在于 PERMISSION_MATRIX
 *      · 私有资源（PRIVATE 域）不得标注 SHARED 才允许的模式
 *    未通过即构建失败 —— 这是「单人公司」的对抗性校验，防自己说服自己。
 */

import type { AccessMode, ResourceType } from './access-policy.js';

// ── 权限矩阵（15 资源 · 43 行）──────────────────────────────────

/** 矩阵行：一个「资源 × 操作」的可执行能力 */
export interface PermissionCell {
  resource: ResourceType;
  mode: AccessMode;
  /** 判定走哪个维度 */
  dimension: 'PRIVATE' | 'SHARED_FAMILY' | 'SHARED_TRIP' | 'PUBLIC';
  /** 是否要求角色（未列 = 任意成员） */
  roles?: readonly string[];
  /** 备注（用于评审与 CI 报告） */
  note?: string;
}

/**
 * 权限矩阵 —— 15 资源 / 43 行（行语义 = 资源 × 操作）。
 *
 * 编号规则 `Rxx`，便于与 TP-02C 评审结论逐格对账。
 * 规模与唯一性由 `assertMatrixSize()` 在启动期与 CI 中强制。
 */
export const PERMISSION_MATRIX: readonly PermissionCell[] = [
  // ── user（自身）· 3 行 ────────────────────────────────────
  { resource: 'user', mode: 'READ', dimension: 'PRIVATE', note: '仅本人资料' },
  { resource: 'user', mode: 'WRITE', dimension: 'PRIVATE', note: '仅本人资料' },
  { resource: 'user', mode: 'DELETE', dimension: 'PRIVATE', note: '注销（软删）' },

  // ── family · 3 行 ─────────────────────────────────────────
  { resource: 'family', mode: 'READ', dimension: 'SHARED_FAMILY' },
  {
    resource: 'family',
    mode: 'WRITE',
    dimension: 'SHARED_FAMILY',
    roles: ['OWNER'],
    note: '改名等仅户主',
  },
  {
    resource: 'family',
    mode: 'DELETE',
    dimension: 'SHARED_FAMILY',
    roles: ['OWNER'],
    note: '解散仅户主',
  },

  // ── family_member · 3 行 ──────────────────────────────────
  { resource: 'family_member', mode: 'READ', dimension: 'SHARED_FAMILY' },
  {
    resource: 'family_member',
    mode: 'WRITE',
    dimension: 'SHARED_FAMILY',
    roles: ['OWNER'],
    note: '改角色/转让户主',
  },
  {
    resource: 'family_member',
    mode: 'DELETE',
    dimension: 'SHARED_FAMILY',
    note: '退出（本人）或移除（户主）',
  },

  // ── wish · 3 行 ───────────────────────────────────────────
  { resource: 'wish', mode: 'READ', dimension: 'SHARED_FAMILY' },
  { resource: 'wish', mode: 'WRITE', dimension: 'SHARED_FAMILY' },
  { resource: 'wish', mode: 'DELETE', dimension: 'SHARED_FAMILY', note: '创建者或户主' },

  // ── trip · 3 行 ───────────────────────────────────────────
  { resource: 'trip', mode: 'READ', dimension: 'SHARED_TRIP' },
  {
    resource: 'trip',
    mode: 'WRITE',
    dimension: 'SHARED_TRIP',
    note: 'ACTIVE 成员；HISTORICAL_READONLY 拒',
  },
  {
    resource: 'trip',
    mode: 'DELETE',
    dimension: 'SHARED_TRIP',
    roles: ['LEADER'],
    note: '仅主导者/创建者',
  },

  // ── trip_member · 3 行 ────────────────────────────────────
  { resource: 'trip_member', mode: 'READ', dimension: 'SHARED_TRIP' },
  {
    resource: 'trip_member',
    mode: 'WRITE',
    dimension: 'SHARED_TRIP',
    roles: ['LEADER'],
    note: '改代管/角色仅主导者',
  },
  {
    resource: 'trip_member',
    mode: 'DELETE',
    dimension: 'SHARED_TRIP',
    note: '退出（本人）或移除（主导者）',
  },

  // ── itinerary_item · 3 行 ─────────────────────────────────
  { resource: 'itinerary_item', mode: 'READ', dimension: 'SHARED_TRIP' },
  { resource: 'itinerary_item', mode: 'WRITE', dimension: 'SHARED_TRIP' },
  { resource: 'itinerary_item', mode: 'DELETE', dimension: 'SHARED_TRIP' },

  // ── booking · 3 行（加密域）───────────────────────────────
  { resource: 'booking', mode: 'READ', dimension: 'SHARED_TRIP', note: '密文解密后仍受此文裁决' },
  { resource: 'booking', mode: 'WRITE', dimension: 'SHARED_TRIP' },
  { resource: 'booking', mode: 'DELETE', dimension: 'SHARED_TRIP' },

  // ── checklist_template · 3 行（双语义）────────────────────
  {
    resource: 'checklist_template',
    mode: 'READ',
    dimension: 'SHARED_FAMILY',
    note: 'SHARED 模板；PERSONAL 走私有短路',
  },
  {
    resource: 'checklist_template',
    mode: 'WRITE',
    dimension: 'SHARED_FAMILY',
    note: '改名称/条目（CAS）；PERSONAL 走私有短路',
  },
  {
    resource: 'checklist_template',
    mode: 'DELETE',
    dimension: 'SHARED_FAMILY',
    note: '软删整套模板（D-2026-10-26-01 P0-2）；不级联删行程清单项',
  },

  // ── trip_checklist_item · 3 行（双语义 + CAS）─────────────
  {
    resource: 'trip_checklist_item',
    mode: 'READ',
    dimension: 'SHARED_TRIP',
    note: 'SHARED 清单；PERSONAL 走私有短路',
  },
  {
    resource: 'trip_checklist_item',
    mode: 'WRITE',
    dimension: 'SHARED_TRIP',
    note: '勾选走 CAS 乐观锁',
  },
  { resource: 'trip_checklist_item', mode: 'DELETE', dimension: 'SHARED_TRIP' },

  // ── item（个人物品库 · 私有）· 3 行 ───────────────────────
  { resource: 'item', mode: 'READ', dimension: 'PRIVATE' },
  { resource: 'item', mode: 'WRITE', dimension: 'PRIVATE' },
  { resource: 'item', mode: 'DELETE', dimension: 'PRIVATE' },

  // ── outfit（个人穿搭 · 私有）· 3 行 ───────────────────────
  { resource: 'outfit', mode: 'READ', dimension: 'PRIVATE' },
  { resource: 'outfit', mode: 'WRITE', dimension: 'PRIVATE' },
  { resource: 'outfit', mode: 'DELETE', dimension: 'PRIVATE' },

  // ── reminder_task · 3 行 ──────────────────────────────────
  { resource: 'reminder_task', mode: 'READ', dimension: 'SHARED_TRIP', note: '接收人/创建者可读' },
  { resource: 'reminder_task', mode: 'WRITE', dimension: 'SHARED_TRIP' },
  { resource: 'reminder_task', mode: 'DELETE', dimension: 'SHARED_TRIP' },

  // ── media_asset · 3 行 ────────────────────────────────────
  { resource: 'media_asset', mode: 'READ', dimension: 'SHARED_TRIP' },
  { resource: 'media_asset', mode: 'WRITE', dimension: 'SHARED_TRIP' },
  { resource: 'media_asset', mode: 'DELETE', dimension: 'SHARED_TRIP' },

  // ── memory_archive（只读快照）· 1 行 ──────────────────────
  {
    resource: 'memory_archive',
    mode: 'READ',
    dimension: 'SHARED_FAMILY',
    note: 'C8 只读快照，不提供写/删',
  },
] as const;

/**
 * 矩阵规模核对（CI 门禁断言）。
 *
 * 🔴 为什么校验「资源数 + 组合唯一性」而不是硬编码格数：
 *   设计文档里的「78 格」是早期按「资源 × 角色 × 操作」估算的口径，
 *   而本矩阵的行语义是「资源 × 操作」，角色维度收在 `roles` 字段里
 *   （见 `PermissionCell`）。两者口径不同，硬编码 78 会让断言长期为红、
 *   最终被注释掉 —— 那等于没有门禁。
 *
 *   故这里校验的是**真正有意义的两个不变量**：
 *     ① 资源类型数 = 15（每新增/删除一个资源必须显式改这里，同步评审）
 *     ② 不存在重复的 (resource, mode) —— 重复会让后一格静默失效
 */
export const PERMISSION_RESOURCE_COUNT = 15;

export function assertMatrixSize(expectedResources = PERMISSION_RESOURCE_COUNT): void {
  const resources = new Set(PERMISSION_MATRIX.map((c) => c.resource));
  if (resources.size !== expectedResources) {
    throw new Error(
      `权限矩阵资源数不符：期望 ${expectedResources}，实际 ${resources.size}。` +
        `矩阵是权限裁决的唯一权威口径，任何增删都必须同步 TP-02C 评审结论。` +
        `实际资源：${[...resources].sort().join(' / ')}`,
    );
  }

  const seen = new Set<string>();
  for (const c of PERMISSION_MATRIX) {
    const key = `${c.resource}:${c.mode}`;
    if (seen.has(key)) {
      throw new Error(`权限矩阵存在重复格：${key}。重复会让后一格静默失效，必须合并或删除。`);
    }
    seen.add(key);
  }
}

/** 查询某资源的矩阵行 */
export function matrixFor(resource: ResourceType): readonly PermissionCell[] {
  return PERMISSION_MATRIX.filter((c) => c.resource === resource);
}

/** 校验 (resource, mode) 是否为矩阵承认的组合（CI 门禁用） */
export function isMatrixCombination(resource: ResourceType, mode: AccessMode): boolean {
  return PERMISSION_MATRIX.some((c) => c.resource === resource && c.mode === mode);
}

// ── @RequireAccess 装饰器 ─────────────────────────────────────

/** 装饰器写入的元数据键 */
export const REQUIRE_ACCESS_META = 'family-trip:require-access';
export const PUBLIC_META = 'family-trip:public';

export interface RequireAccessMeta {
  resource: ResourceType;
  mode: AccessMode;
  /** 从请求参数取资源 ID 的路径（默认 `params.id`） */
  idFrom?: string;
}

/**
 * 声明式权限标注（D2）。
 *
 * 用法：
 * ```ts
 * @RequireAccess({ resource: 'trip', mode: 'WRITE' })
 * async update(@Param('id') id: string) { ... }
 * ```
 *
 * ⛔ 未标注且非 @Public 的路由，CI 门禁直接失败 —— 默认拒绝。
 */
export function RequireAccess(meta: RequireAccessMeta): MethodDecorator {
  // 立即做矩阵校验：写错组合在**模块加载期**就炸，不必等 CI
  if (!isMatrixCombination(meta.resource, meta.mode)) {
    throw new Error(
      `@RequireAccess 声明了矩阵不存在的组合：${meta.resource} × ${meta.mode}。` +
        '请先更新 PERMISSION_MATRIX 并同步 TP-02C 评审。',
    );
  }
  return (target, propertyKey, descriptor) => {
    Reflect.defineMetadata(REQUIRE_ACCESS_META, meta, descriptor.value as object);
    return descriptor;
  };
}

/** 显式公开路由（登录、健康检查等）—— 必须显式，不留默认 */
export function Public(): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    Reflect.defineMetadata(PUBLIC_META, true, descriptor.value as object);
    return descriptor;
  };
}

/** 读回装饰器元数据（供 Guard 与 CI 门禁使用） */
export function getRequireAccessMeta(handler: object): RequireAccessMeta | undefined {
  return Reflect.getMetadata(REQUIRE_ACCESS_META, handler) as RequireAccessMeta | undefined;
}

export function isPublicHandler(handler: object): boolean {
  return Reflect.getMetadata(PUBLIC_META, handler) === true;
}
