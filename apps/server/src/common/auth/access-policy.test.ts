/**
 * 权限判定单测（TP-02C 组 D）
 */
import { describe, expect, it } from 'vitest';
import {
  AccessLevel,
  Decision,
  RESOURCE_DOMAIN,
  AccessDomain,
  buildLockedPlaceholders,
  checkAccess,
  resolveChecklistDomain,
  type PermissionContext,
} from './access-policy.js';

const U = 100n;

function ctx(over: Partial<PermissionContext> = {}): PermissionContext {
  return {
    identity: { userId: U },
    familyIds: new Set([1n]),
    managedFamilyIds: new Set<bigint>(),
    tripAccess: new Map([[2n, AccessLevel.Active]]),
    ...over,
  };
}

describe('PRIVATE 短路：私有资源不被家庭维度放行', () => {
  it('item / outfit 属私有域', () => {
    expect(RESOURCE_DOMAIN.item).toBe(AccessDomain.Private);
    expect(RESOURCE_DOMAIN.outfit).toBe(AccessDomain.Private);
    expect(RESOURCE_DOMAIN.user).toBe(AccessDomain.Private);
  });

  it('本人访问自己的私有资源 → 放行', () => {
    const r = checkAccess(ctx(), { type: 'item', id: 1n, ownerId: U }, 'READ');
    expect(r.decision).toBe(Decision.Allow);
    expect(r.detail.dimension).toBe('PRIVATE_OWNER');
  });

  it('代管人访问虚拟成员私有资源 → 放行', () => {
    const r = checkAccess(ctx(), { type: 'item', id: 1n, ownerId: 999n, managedBy: U }, 'READ');
    expect(r.decision).toBe(Decision.Allow);
    expect(r.detail.dimension).toBe('PRIVATE_MANAGER');
  });

  it('🔴 他人私有资源即便同家庭也不放行（短路，不参与 OR 合并）', () => {
    // 关键：familyIds 含 1n，若走 OR 合并就会被家庭维度放行 —— 那就是越权
    const r = checkAccess(
      ctx(),
      { type: 'item', id: 1n, ownerId: 200n, familyId: 1n, tripId: 2n },
      'READ',
    );
    expect(r.decision).toBe(Decision.Deny);
    expect(r.detail.dimension).toBe('NONE');
  });
});

describe('SHARED：家庭 ∨ 出行 两维度合并', () => {
  it('家庭维度放行', () => {
    const r = checkAccess(ctx(), { type: 'wish', id: 1n, familyId: 1n }, 'READ');
    expect(r.decision).toBe(Decision.Allow);
    expect(r.detail.dimension).toBe('FAMILY');
  });

  it('出行维度放行（非本家庭成员也能参与）', () => {
    const r = checkAccess(
      ctx({ familyIds: new Set<bigint>() }),
      { type: 'itinerary_item', id: 1n, tripId: 2n },
      'READ',
    );
    expect(r.decision).toBe(Decision.Allow);
    expect(r.detail.dimension).toBe('TRIP');
  });

  it('代管人所属家庭同样放行', () => {
    const r = checkAccess(
      ctx({ familyIds: new Set<bigint>(), managedFamilyIds: new Set([1n]) }),
      { type: 'wish', id: 1n, familyId: 1n },
      'READ',
    );
    expect(r.decision).toBe(Decision.Allow);
  });

  it('两个维度都不满足 → 拒绝', () => {
    const r = checkAccess(ctx(), { type: 'wish', id: 1n, familyId: 777n, tripId: 888n }, 'READ');
    expect(r.decision).toBe(Decision.Deny);
  });
});

describe('历史只读访问级别', () => {
  const historical = ctx({ tripAccess: new Map([[2n, AccessLevel.HistoricalReadOnly]]) });

  it('READ 允许', () => {
    expect(
      checkAccess(historical, { type: 'itinerary_item', id: 1n, tripId: 2n }, 'READ').decision,
    ).toBe(Decision.Allow);
  });

  it('WRITE / DELETE 拒绝', () => {
    expect(
      checkAccess(historical, { type: 'itinerary_item', id: 1n, tripId: 2n }, 'WRITE').decision,
    ).toBe(Decision.Deny);
    expect(
      checkAccess(historical, { type: 'itinerary_item', id: 1n, tripId: 2n }, 'DELETE').decision,
    ).toBe(Decision.Deny);
  });
});

describe('清单类双语义：scope 决定域', () => {
  it('scope=SHARED 且 ownerId 为空 → 共享域', () => {
    expect(resolveChecklistDomain({ scope: 'SHARED', ownerId: null })).toBe(AccessDomain.Shared);
  });

  it('scope=PERSONAL → 私有域，走短路', () => {
    expect(resolveChecklistDomain({ scope: 'PERSONAL', ownerId: 5n })).toBe(AccessDomain.Private);
  });

  it('🔴 私人清单即便同家庭，列表层也不放行明细', () => {
    const r = checkAccess(
      ctx(),
      { type: 'trip_checklist_item', id: 1n, scope: 'PERSONAL', ownerId: 300n, familyId: 1n },
      'READ',
    );
    expect(r.decision).toBe(Decision.Deny);
  });
});

describe('列表层带锁占位（D5 三条硬约束）', () => {
  const names = new Map([
    [200n, '小红'],
    [300n, '小蓝'],
  ]);
  const lookup = (id: bigint): string | null => names.get(id) ?? null;

  it('每位成员最多 1 条 —— 重复 ownerId 被折叠', () => {
    const out = buildLockedPlaceholders([200n, 200n, 200n, 300n], lookup, U);
    expect(out).toHaveLength(2);
  });

  it('⛔ 不返回私有项数量（不逐条展开）', () => {
    const out = buildLockedPlaceholders([200n, 200n, 200n, 300n], lookup, U);
    for (const p of out) {
      expect(Object.keys(p).sort()).toEqual(['ownerDisplayName', 'type']);
    }
  });

  it('自己的私有内容不占位', () => {
    const out = buildLockedPlaceholders([U, 200n], lookup, U);
    expect(out).toEqual([{ type: 'LOCKED_PRIVATE', ownerDisplayName: '小红' }]);
  });

  it('ownerDisplayName 不在公开昵称白名单 → 不产出占位（防存在性泄漏）', () => {
    const out = buildLockedPlaceholders([999n], lookup, U);
    expect(out).toEqual([]);
  });

  it('占位不携带 owner_id / item_id / name / 金额', () => {
    const [p] = buildLockedPlaceholders([200n], lookup, U);
    expect(p).not.toHaveProperty('ownerId');
    expect(p).not.toHaveProperty('itemId');
    expect(p).not.toHaveProperty('name');
    expect(p).not.toHaveProperty('amount');
  });
});
