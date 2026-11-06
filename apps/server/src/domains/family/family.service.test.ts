/**
 * family 域 · 派发单 §1 / §2 回归
 * ============================================================================
 * §1 创建家庭时户主成员 displayName 必须来自用户 nickname（不是家庭名）
 * §2 listMine / detail 必须返回 `memberCount`（活跃 family_member 行数）
 *
 * 用内存驱动跑 service 全链路（含事务 / change_log / audit_log 写入），
 * 不做桩替换 —— 断言的是真实落库行，而不是 mock 调用次数。
 */
import { describe, expect, it } from 'vitest';
import { MemoryTableDriver } from '../../common/db/table-client.js';
import { createDomainContext, type DomainContext } from '../domain-context.js';
import { FamilyService } from './family.service.js';

function harness(): { ctx: DomainContext; family: FamilyService; driver: MemoryTableDriver } {
  const driver = new MemoryTableDriver();
  const ctx = createDomainContext({ reader: driver, runner: driver });
  return { ctx, family: new FamilyService({ ctx }), driver };
}

/** 造一个已注册用户（`displayNameOf` 只读 nickname / deletedAt） */
async function seedUser(driver: MemoryTableDriver, id: bigint, nickname?: string): Promise<void> {
  await driver.insert('user', {
    id,
    nickname: nickname ?? null,
    deletedAt: null,
  });
}

describe('派发单 §1 · 户主 displayName 来自 nickname', () => {
  it('nickname=小明 + 家庭名=暑假旅行组 → 户主展示名是小明，不等于家庭名', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');

    const created = await family.create(1n, { name: '暑假旅行组' });
    const familyId = BigInt(created['id'] as string);

    const detail = await family.detail(familyId);
    const members = detail['members'] as Array<Record<string, unknown>>;

    expect(members).toHaveLength(1);
    expect(members[0]!['role']).toBe('OWNER');
    expect(members[0]!['userId']).toBe('1');
    expect(members[0]!['displayName']).toBe('小明');
    expect(members[0]!['displayName']).not.toBe('暑假旅行组');
  });

  it('用户行缺失时沿用「成员」兜底（不抛、不写空串）', async () => {
    const { family } = harness();
    const created = await family.create(7n, { name: '我们的家' });
    const detail = await family.detail(BigInt(created['id'] as string));
    const members = detail['members'] as Array<Record<string, unknown>>;
    expect(members[0]!['displayName']).toBe('成员');
  });

  it('创建仍是原子事务：family / familyMember / changeLog / auditLog 都落库', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    const created = await family.create(1n, { name: '暑假旅行组' });
    const familyId = BigInt(created['id'] as string);

    expect(driver.dump?.('family')).toHaveLength(1);
    expect(driver.dump?.('familyMember')).toHaveLength(1);
    expect(driver.dump?.('changeLog')).toHaveLength(1);
    expect(driver.dump?.('auditLog')).toHaveLength(1);
    // 响应信封不变：只回 family，不带 members / memberCount
    expect(Object.keys(created)).toContain('id');
    expect(created).not.toHaveProperty('memberCount');
    void familyId;
  });

  it('家庭名与昵称同名时不误判（来源仍是 nickname 字段）', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    const created = await family.create(1n, { name: '小明' });
    const detail = await family.detail(BigInt(created['id'] as string));
    expect((detail['members'] as Array<Record<string, unknown>>)[0]!['displayName']).toBe('小明');
  });
});

describe('派发单 §2 · 家庭 memberCount', () => {
  it('1 个真实成员 + 2 个虚拟成员 → list / detail 均为 3', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    const created = await family.create(1n, { name: '暑假旅行组' });
    const familyId = BigInt(created['id'] as string);

    await family.addMember(familyId, 1n, { displayName: '奶奶', isVirtual: true, role: 'MEMBER' });
    await family.addMember(familyId, 1n, { displayName: '小满', isVirtual: true, role: 'MEMBER' });

    const list = await family.listMine(1n, {});
    const items = list.items;
    expect(items[0]!['memberCount']).toBe(3);
    expect(typeof items[0]!['memberCount']).toBe('number');

    const detail = await family.detail(familyId);
    expect(detail['memberCount']).toBe(3);
    expect((detail['members'] as unknown[]).length).toBe(3);
  });

  it('软删 1 个虚拟成员后 → list / detail 均为 2（不计 deletedAt != null）', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    const created = await family.create(1n, { name: '暑假旅行组' });
    const familyId = BigInt(created['id'] as string);
    const m1 = await family.addMember(familyId, 1n, {
      displayName: '奶奶',
      isVirtual: true,
      role: 'MEMBER',
    });
    await family.addMember(familyId, 1n, { displayName: '小满', isVirtual: true, role: 'MEMBER' });

    await family.removeMember(BigInt(m1['id'] as string), 1n);

    const items = (await family.listMine(1n, {})).items;
    expect(items[0]!['memberCount']).toBe(2);
    expect((await family.detail(familyId))['memberCount']).toBe(2);
  });

  it('family 4 人时只算本家庭：另一个家庭的成员不串号', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    await seedUser(driver, 2n, '小红');

    const a = await family.create(1n, { name: 'A 家' });
    const b = await family.create(2n, { name: 'B 家' });
    const aId = BigInt(a['id'] as string);
    const bId = BigInt(b['id'] as string);

    await family.addMember(aId, 1n, { displayName: '奶奶', isVirtual: true, role: 'MEMBER' });
    await family.addMember(aId, 1n, { displayName: '小满', isVirtual: true, role: 'MEMBER' });
    await family.addMember(bId, 2n, { displayName: '叔叔', isVirtual: true, role: 'MEMBER' });

    expect((await family.detail(aId))['memberCount']).toBe(3);
    expect((await family.detail(bId))['memberCount']).toBe(2);

    const items = (await family.listMine(1n, {})).items;
    expect(items).toHaveLength(1);
    expect(items[0]!['memberCount']).toBe(3);
    expect(items[0]!['myRole']).toBe('OWNER');
  });

  it('没有家庭时列表为空且不报错', async () => {
    const { family } = harness();
    const list = await family.listMine(99n, {});
    expect(list.items).toEqual([]);
    expect(list.meta['total']).toBe(0);
  });

  it('分页与既有字段不变（memberCount 是响应纯加法）', async () => {
    const { family, driver } = harness();
    await seedUser(driver, 1n, '小明');
    await family.create(1n, { name: 'A 家' });
    await family.create(1n, { name: 'B 家' });

    const page1 = await family.listMine(1n, { page: 1, pageSize: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.meta['total']).toBe(2);
    expect(page1.meta['pageSize']).toBe(1);
    expect(page1.items[0]).toHaveProperty('memberCount', 1);
    expect(page1.items[0]).toHaveProperty('ownerId');
  });
});
