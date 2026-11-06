/**
 * 昵称与「家庭称谓」的分离（派发单 2026-11-06 · 产品口径）
 * ============================================================================
 * 两个字段各管一件事：
 *   · `user.nickname`            —— 账号昵称，本人随时可改，**权威源**
 *   · `family_member.displayName` / `trip_member.displayName`
 *                                —— 家里 / 行程里的**称呼**（「爸爸」「二姨」），
 *                                   由家人设定，可以长期不动
 * 前端渲染：昵称做主行，称呼做灰字副行 → 所以**两个值都必须由后端给**。
 *
 * 于是「改昵称」的正确行为不是覆盖，而是**只处理幽灵旧名**：
 *   · `displayName === 旧昵称`（没人动过的昵称副本）→ 跟着改
 *   · `displayName` 是家人设过的称呼 → 原样保留
 *
 * 本文件锁：
 *   1. 成员接口同时返回 nickname + displayName（家庭 & 行程）
 *   2. 昵称副本跟着改、称呼保留、虚拟成员不动、只改头像不触发
 *   3. 称呼可以被家人改（不是别名，是本义），真实成员也允许
 *   4. change_log 只给真正变更的行写
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { dumpTable, mustOk, req, scaffold } from './helpers.js';

function freshApp(): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    autoFinish: { enabled: false, lazyOnRead: false },
  });
}

async function login(app: BuiltApp, code: string): Promise<{ token: string; userId: string }> {
  const r = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  return { token: r.token, userId: r.user.id };
}

async function rename(app: BuiltApp, token: string, nickname: string): Promise<void> {
  mustOk(await app.dispatch(req('PATCH', '/auth/me', { token, body: { nickname } })));
}

interface MemberRow {
  id: string;
  userId: string | null;
  displayName: string;
  nickname: string | null;
  role: string;
}

async function familyMembers(app: BuiltApp, token: string, familyId: string): Promise<MemberRow[]> {
  const r = mustOk<{ members: MemberRow[] }>(
    await app.dispatch(req('GET', `/families/${familyId}`, { token })),
  );
  return r.members;
}

async function tripMembers(app: BuiltApp, token: string, tripId: string): Promise<MemberRow[]> {
  const r = mustOk<{ members: MemberRow[] }>(
    await app.dispatch(req('GET', `/trips/${tripId}`, { token })),
  );
  return r.members;
}

/** 建家庭 + 拉 B 进来（B 的称呼 = B 的昵称副本，未手改） */
async function familyWithTwo(
  app: BuiltApp,
  aCode: string,
  bCode: string,
  aNick = '小明',
  bNick = '小红',
): Promise<{
  a: { token: string; userId: string };
  b: { token: string; userId: string };
  familyId: string;
}> {
  const a = await login(app, aCode);
  await rename(app, a.token, aNick);
  const family = mustOk<{ family: { id: string; inviteCode: string } }>(
    await app.dispatch(req('POST', '/families', { token: a.token, body: { name: '我们的家' } })),
  );

  const b = await login(app, bCode);
  await rename(app, b.token, bNick);
  mustOk(
    await app.dispatch(
      req('POST', '/families/join', {
        token: b.token,
        body: { inviteCode: family.family.inviteCode },
      }),
    ),
  );

  return { a, b, familyId: family.family.id };
}

describe('成员接口同时返回 nickname 与 displayName', () => {
  it('家庭详情：真实成员带账号昵称，虚拟成员 nickname 为 null', async () => {
    const app = freshApp();
    const { a, familyId } = await familyWithTwo(app, 'sep-a', 'sep-b');

    mustOk(
      await app.dispatch(
        req('POST', `/families/${familyId}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );

    const members = await familyMembers(app, a.token, familyId);
    const me = members.find((m) => m.userId === a.userId)!;
    expect(me.nickname).toBe('小明');
    expect(me.displayName).toBe('小明');

    const virtual = members.find((m) => m.userId === null)!;
    expect(virtual.nickname).toBeNull();
    expect(virtual.displayName).toBe('奶奶');
  });

  it('行程详情同构：nickname + displayName 都有', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sep-trip');
    const members = await tripMembers(app, s.token, s.tripId);
    const me = members.find((m) => m.userId === s.userId)!;
    expect(me.nickname).toBeTruthy();
    expect(me.displayName).toBe(me.nickname);
  });
});

describe('改昵称：昵称副本跟着改，称呼保留', () => {
  it('未手改的成员行随昵称更新；家人设过的称呼原样保留（两个值共存）', async () => {
    const app = freshApp();
    const { a, b, familyId } = await familyWithTwo(app, 'sep-keep-a', 'sep-keep-b');

    // 户主给 B 设称呼「二姨」（这是称呼，不是别名）
    const bRow = (await familyMembers(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    mustOk(
      await app.dispatch(
        req('PATCH', `/families/members/${bRow.id}`, {
          token: a.token,
          body: { displayName: '二姨' },
        }),
      ),
    );

    // B 改昵称：昵称变了，称呼保持「二姨」
    await rename(app, b.token, '红红');

    const after = await familyMembers(app, a.token, familyId);
    const bAfter = after.find((m) => m.userId === b.userId)!;
    expect(bAfter.nickname).toBe('红红'); // 主行：账号昵称
    expect(bAfter.displayName).toBe('二姨'); // 副行：家庭称呼（保留）

    // A 自己那行没手改过 → 称呼仍是昵称本身
    const aAfter = after.find((m) => m.userId === a.userId)!;
    expect(aAfter.nickname).toBe('小明');
    expect(aAfter.displayName).toBe('小明');
  });

  it('A 改昵称后，A 的昵称副本（家庭 + 行程）全部跟着改，不漏行', async () => {
    const app = freshApp();
    const a = await login(app, 'sep-multi-a');
    await rename(app, a.token, '小明');
    const f1 = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: 'A 家' } })),
    );
    const t1 = mustOk<{ trip: { id: string } }>(
      await app.dispatch(
        req('POST', '/trips', {
          token: a.token,
          body: {
            familyId: f1.family.id,
            title: '第一次出行',
            startDate: '2026-12-01',
            endDate: '2026-12-03',
          },
        }),
      ),
    );
    const b = await login(app, 'sep-multi-b');
    const f2 = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: b.token, body: { name: 'B 家' } })),
    );
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: a.token,
          body: { inviteCode: f2.family.inviteCode },
        }),
      ),
    );
    const t2 = mustOk<{ trip: { id: string } }>(
      await app.dispatch(
        req('POST', '/trips', {
          token: a.token,
          body: {
            familyId: f2.family.id,
            title: '第二次出行',
            startDate: '2026-12-10',
            endDate: '2026-12-12',
          },
        }),
      ),
    );

    await rename(app, a.token, '小满');

    for (const familyId of [f1.family.id, f2.family.id]) {
      const mine = (await familyMembers(app, a.token, familyId)).find(
        (m) => m.userId === a.userId,
      )!;
      expect(mine.displayName, `家庭 ${familyId}`).toBe('小满');
      expect(mine.nickname).toBe('小满');
    }
    for (const tripId of [t1.trip.id, t2.trip.id]) {
      const mine = (await tripMembers(app, a.token, tripId)).find((m) => m.userId === a.userId)!;
      expect(mine.displayName, `行程 ${tripId}`).toBe('小满');
    }

    // 审计：2 家庭 + 2 行程 = 4 行跟着改，0 行保留
    const audit = dumpTable(app, 'auditLog').filter((r) => r['action'] === 'auth.update_profile');
    const detail = audit[audit.length - 1]!['detail'] as Record<string, unknown>;
    expect(detail['syncedMemberRows']).toBe(4);
    expect(detail['keptCustomMemberRows']).toBe(0);
  });

  it('有保留称呼时，审计的 kept 计数如实反映', async () => {
    const app = freshApp();
    const { a, b, familyId } = await familyWithTwo(app, 'sep-kept-a', 'sep-kept-b');
    const bRow = (await familyMembers(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    mustOk(
      await app.dispatch(
        req('PATCH', `/families/members/${bRow.id}`, {
          token: a.token,
          body: { displayName: '二姨' },
        }),
      ),
    );

    await rename(app, b.token, '红红');

    // B 只有家庭一行成员（没建行程）→ 0 行同步、1 行保留
    const audit = dumpTable(app, 'auditLog').filter((r) => r['action'] === 'auth.update_profile');
    const detail = audit[audit.length - 1]!['detail'] as Record<string, unknown>;
    expect(detail['syncedMemberRows']).toBe(0);
    expect(detail['keptCustomMemberRows']).toBe(1);
  });
});

describe('不该被动的情况', () => {
  it('虚拟成员、其他用户的行不被同步影响', async () => {
    const app = freshApp();
    const { a, b, familyId } = await familyWithTwo(app, 'sep-scope-a', 'sep-scope-b');
    mustOk(
      await app.dispatch(
        req('POST', `/families/${familyId}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );

    await rename(app, a.token, '小满');

    const members = await familyMembers(app, a.token, familyId);
    expect(members.find((m) => m.userId === null)?.displayName).toBe('奶奶');
    expect(members.find((m) => m.userId === b.userId)?.displayName).toBe('小红');
    expect(members.find((m) => m.userId === a.userId)?.displayName).toBe('小满');
  });

  it('只改头像 → 不同步、审计不带计数', async () => {
    const app = freshApp();
    const { a, familyId } = await familyWithTwo(app, 'sep-avatar-a', 'sep-avatar-b');

    mustOk(
      await app.dispatch(
        req('PATCH', '/auth/me', {
          token: a.token,
          body: { avatarUrl: 'https://cdn.example.com/me.png' },
        }),
      ),
    );

    expect(
      (await familyMembers(app, a.token, familyId)).find((m) => m.userId === a.userId)?.displayName,
    ).toBe('小明');

    const audit = dumpTable(app, 'auditLog').filter((r) => r['action'] === 'auth.update_profile');
    const detail = audit[audit.length - 1]!['detail'] as Record<string, unknown>;
    expect(detail['syncedMemberRows']).toBeUndefined();
  });
});

describe('称呼可以被家人修改（真实成员也允许）', () => {
  it('家庭：户主改真实成员的称呼 → 200；改虚拟成员 → 200', async () => {
    const app = freshApp();
    const { a, b, familyId } = await familyWithTwo(app, 'sep-alias-a', 'sep-alias-b');

    const bRow = (await familyMembers(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    const r1 = await app.dispatch(
      req('PATCH', `/families/members/${bRow.id}`, {
        token: a.token,
        body: { displayName: '爸爸' },
      }),
    );
    expect(r1.httpStatus).toBe(200);

    const virtual = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/families/${familyId}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );
    const r2 = await app.dispatch(
      req('PATCH', `/families/members/${virtual.member.id}`, {
        token: a.token,
        body: { displayName: '外婆' },
      }),
    );
    expect(r2.httpStatus).toBe(200);

    const members = await familyMembers(app, a.token, familyId);
    expect(members.find((m) => m.userId === b.userId)?.displayName).toBe('爸爸');
    expect(members.find((m) => m.userId === null)?.displayName).toBe('外婆');
  });

  it('行程：主导者改真实同行者的称呼 → 200', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'sep-trip-alias-a');
    const b = await login(app, 'sep-trip-alias-b');
    const detail = mustOk<{ trip: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/trips/${a.tripId}`, { token: a.token })),
    );
    mustOk(
      await app.dispatch(
        req('POST', '/trips/join', {
          token: b.token,
          body: { inviteCode: detail.trip.inviteCode },
        }),
      ),
    );

    const bRow = (await tripMembers(app, a.token, a.tripId)).find((m) => m.userId === b.userId)!;
    const r = await app.dispatch(
      req('PATCH', `/trips/members/${bRow.id}`, {
        token: a.token,
        body: { displayName: '同事小王' },
      }),
    );
    expect(r.httpStatus).toBe(200);
    expect(
      (await tripMembers(app, a.token, a.tripId)).find((m) => m.userId === b.userId)?.displayName,
    ).toBe('同事小王');
  });
});

describe('留痕', () => {
  it('只给真正变更的行写 change_log（保留称呼的行不写）', async () => {
    const app = freshApp();
    const { a, b, familyId } = await familyWithTwo(app, 'sep-log-a', 'sep-log-b');
    const bRow = (await familyMembers(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    mustOk(
      await app.dispatch(
        req('PATCH', `/families/members/${bRow.id}`, {
          token: a.token,
          body: { displayName: '二姨' },
        }),
      ),
    );

    const before = dumpTable(app, 'changeLog').length;
    await rename(app, b.token, '红红');
    const added = dumpTable(app, 'changeLog').slice(before);

    // B 的家庭行被保留（称呼），且没有行程 → 这次改名不该产生成员类 change_log
    expect(added.filter((r) => r['entityType'] === 'family_member')).toHaveLength(0);
    expect(added.filter((r) => r['entityType'] === 'trip_member')).toHaveLength(0);
  });

  it('跟着改的行带完整归属维度（familyId / tripId）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sep-log-owner'); // 1 家庭 + 1 行程
    const before = dumpTable(app, 'changeLog').length;
    await rename(app, s.token, '新名字');
    const added = dumpTable(app, 'changeLog')
      .slice(before)
      .filter((r) => r['op'] === 'UPDATE');

    const fam = added.filter((r) => r['entityType'] === 'family_member');
    const trip = added.filter((r) => r['entityType'] === 'trip_member');
    expect(fam).toHaveLength(1);
    expect(trip).toHaveLength(1);
    expect(String(fam[0]!['familyId'])).toBe(s.familyId);
    expect(String(trip[0]!['tripId'])).toBe(s.tripId);
    expect(String(trip[0]!['familyId'])).toBe(s.familyId);
  });
});
