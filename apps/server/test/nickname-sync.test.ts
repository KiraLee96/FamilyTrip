/**
 * 改昵称后成员展示名同步（派发单 2026-11-06 口径 A）
 * ============================================================================
 * 背景：`family_member.display_name` / `trip_member.display_name` 是**加入时的快照**。
 * `PATCH /auth/me` 原来只改 `user.nickname`，于是：
 *   · 本人页面靠前端投影看着是新的；
 *   · **其他家庭成员看到的永远是旧名**（`GET /families/:id` 直接读快照）。
 *
 * 口径 A（产品拍板）：真实成员的展示名**恒等于账号昵称**；虚拟成员 / 外部同行者
 * 没有账号，名字就是它的唯一标识，一个字都不动。
 *
 * 本文件锁四组行为：
 *   1. 改名后他人视角立即正确（含多家庭、多行程，不漏行）
 *   2. 虚拟成员 / 其他用户 / 只改头像 → 不受影响
 *   3. 别名入口收口：真实成员不能在成员接口里单独改名，虚拟成员可以
 *   4. 留痕：审计计数 + change_log UPDATE（否则同步游标会漏掉这次变化）
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

interface MemberRow {
  id: string;
  userId: string | null;
  displayName: string;
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

async function rename(app: BuiltApp, token: string, nickname: string): Promise<void> {
  mustOk(await app.dispatch(req('PATCH', '/auth/me', { token, body: { nickname } })));
}

describe('口径 A · 改昵称后他人视角同步', () => {
  it('A 从「小明」改成「小满」→ B 调 GET /families/:id 看到「小满」', async () => {
    const app = freshApp();
    const a = await login(app, 'sync-a');
    await rename(app, a.token, '小明');
    const family = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: '我们的家' } })),
    );

    const b = await login(app, 'sync-b');
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: b.token,
          body: { inviteCode: family.family.inviteCode },
        }),
      ),
    );

    // 改名前：B 看到小明
    expect(
      (await familyMembers(app, b.token, family.family.id)).find((m) => m.userId === a.userId)
        ?.displayName,
    ).toBe('小明');

    await rename(app, a.token, '小满');

    // 改名后：B 看到小满（不再依赖前端投影）
    expect(
      (await familyMembers(app, b.token, family.family.id)).find((m) => m.userId === a.userId)
        ?.displayName,
    ).toBe('小满');

    // A 自己读也一样（前后端口径一致）
    expect(
      (await familyMembers(app, a.token, family.family.id)).find((m) => m.userId === a.userId)
        ?.displayName,
    ).toBe('小满');
  });

  it('两个家庭 + 两个行程全部同步，一行不漏（审计计数 = 4）', async () => {
    const app = freshApp();
    const a = await login(app, 'sync-multi-a');
    await rename(app, a.token, '小明');

    // 家庭 1 + 行程 1（A 是户主与创建者）
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

    // 家庭 2：B 建、A 凭邀请码加入；再在该家庭建行程 2
    const b = await login(app, 'sync-multi-b');
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

    for (const [token, familyId] of [
      [a.token, f1.family.id],
      [b.token, f2.family.id],
    ] as const) {
      const mine = (await familyMembers(app, token, familyId)).find((m) => m.userId === a.userId);
      expect(mine?.displayName, `家庭 ${familyId} 未同步`).toBe('小满');
    }
    for (const tripId of [t1.trip.id, t2.trip.id]) {
      const mine = (await tripMembers(app, a.token, tripId)).find((m) => m.userId === a.userId);
      expect(mine?.displayName, `行程 ${tripId} 未同步`).toBe('小满');
    }

    // 审计：2 家庭 + 2 行程 = 4 行
    const audit = dumpTable(app, 'auditLog').filter((r) => r['action'] === 'auth.update_profile');
    const last = audit[audit.length - 1]!;
    const detail = last['detail'] as Record<string, unknown>;
    expect(detail['syncedMemberRows']).toBe(4);
    expect(detail['syncedFamilyMemberRows']).toBe(2);
    expect(detail['syncedTripMemberRows']).toBe(2);
  });
});

describe('口径 A · 不该被动的行', () => {
  it('虚拟成员、其他用户的成员行不受影响', async () => {
    const app = freshApp();
    const a = await login(app, 'sync-scope-a');
    await rename(app, a.token, '小明');
    const family = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: 'A 家' } })),
    );
    mustOk(
      await app.dispatch(
        req('POST', `/families/${family.family.id}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );

    const b = await login(app, 'sync-scope-b');
    await rename(app, b.token, '小红');
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: b.token,
          body: { inviteCode: family.family.inviteCode },
        }),
      ),
    );

    await rename(app, a.token, '小满');

    const members = await familyMembers(app, a.token, family.family.id);
    expect(members.find((m) => m.userId === a.userId)?.displayName).toBe('小满');
    expect(members.find((m) => m.userId === null)?.displayName).toBe('奶奶');
    expect(members.find((m) => m.userId === b.userId)?.displayName).toBe('小红');
  });

  it('只改头像 / 时区 → 不同步成员行，审计也不带计数', async () => {
    const app = freshApp();
    const a = await login(app, 'sync-avatar');
    await rename(app, a.token, '小明');
    const family = mustOk<{ family: { id: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: 'A 家' } })),
    );

    mustOk(
      await app.dispatch(
        req('PATCH', '/auth/me', {
          token: a.token,
          body: { avatarUrl: 'https://cdn.example.com/me.png' },
        }),
      ),
    );

    expect((await familyMembers(app, a.token, family.family.id))[0]?.displayName).toBe('小明');

    const audit = dumpTable(app, 'auditLog').filter((r) => r['action'] === 'auth.update_profile');
    const last = audit[audit.length - 1]!;
    expect((last['detail'] as Record<string, unknown>)['syncedMemberRows']).toBeUndefined();
  });

  it('加入时自定义的「我的称呼」仍作为初始快照生效（口径 A 的既定例外）', async () => {
    const app = freshApp();
    const a = await login(app, 'sync-join-a');
    const family = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: 'A 家' } })),
    );

    const b = await login(app, 'sync-join-b');
    await rename(app, b.token, '小红');
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: b.token,
          body: { inviteCode: family.family.inviteCode, displayName: '二姨' },
        }),
      ),
    );

    const before = (await familyMembers(app, a.token, family.family.id)).find(
      (m) => m.userId === b.userId,
    );
    expect(before?.displayName).toBe('二姨');

    // 本人改名后回到账号昵称（这就是「初始快照 ≠ 别名」的可验证语义）
    await rename(app, b.token, '红红');
    const after = (await familyMembers(app, a.token, family.family.id)).find(
      (m) => m.userId === b.userId,
    );
    expect(after?.displayName).toBe('红红');
  });
});

describe('口径 A · 别名入口收口', () => {
  it('家庭：户主改真实成员名 → 422；改虚拟成员名 → 200', async () => {
    const app = freshApp();
    const a = await login(app, 'alias-family-a');
    const family = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: 'A 家' } })),
    );
    const b = await login(app, 'alias-family-b');
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: b.token,
          body: { inviteCode: family.family.inviteCode },
        }),
      ),
    );
    const virtual = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/families/${family.family.id}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );

    const members = await familyMembers(app, a.token, family.family.id);
    const realRow = members.find((m) => m.userId === b.userId)!;

    const denied = await app.dispatch(
      req('PATCH', `/families/members/${realRow.id}`, {
        token: a.token,
        body: { displayName: '老 B' },
      }),
    );
    expect(denied.httpStatus).toBe(422);

    const okVirtual = await app.dispatch(
      req('PATCH', `/families/members/${virtual.member.id}`, {
        token: a.token,
        body: { displayName: '太奶奶' },
      }),
    );
    expect(okVirtual.httpStatus).toBe(200);
    expect(
      (await familyMembers(app, a.token, family.family.id)).find((m) => m.userId === null)
        ?.displayName,
    ).toBe('太奶奶');
  });

  it('行程：主导者改真实同行者名 → 422；改外部同行者名 → 200', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'alias-trip-a');
    const b = await login(app, 'alias-trip-b');

    // B 凭行程邀请码加入（真实同行者）
    const invite = mustOk<{ trip: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/trips/${a.tripId}`, { token: a.token })),
    );
    mustOk(
      await app.dispatch(
        req('POST', '/trips/join', {
          token: b.token,
          body: { inviteCode: invite.trip.inviteCode },
        }),
      ),
    );

    // 外部同行者
    const ext = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/trips/${a.tripId}/members`, {
          token: a.token,
          body: { displayName: '同事小王', isVirtual: true },
        }),
      ),
    );

    const members = await tripMembers(app, a.token, a.tripId);
    const realRow = members.find((m) => m.userId === b.userId)!;
    expect(realRow).toBeDefined();

    const denied = await app.dispatch(
      req('PATCH', `/trips/members/${realRow.id}`, {
        token: a.token,
        body: { displayName: '老 B' },
      }),
    );
    expect(denied.httpStatus).toBe(422);

    const okExt = await app.dispatch(
      req('PATCH', `/trips/members/${ext.member.id}`, {
        token: a.token,
        body: { displayName: '老王' },
      }),
    );
    expect(okExt.httpStatus).toBe(200);
    expect(
      (await tripMembers(app, a.token, a.tripId)).find((m) => m.userId === null)?.displayName,
    ).toBe('老王');
  });

  it('被邀请时指定的称呼作为初始快照生效，本人改名后对齐账号昵称', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'alias-add-a');
    const b = await login(app, 'alias-add-b');

    // 真实家庭场景：账号叫「小红」，家里叫她「二姨」
    await rename(app, b.token, '小红');
    const invited = await app.dispatch(
      req('POST', `/families/${a.familyId}/members`, {
        token: a.token,
        body: { userId: b.userId, isVirtual: false, displayName: '二姨' },
      }),
    );
    expect(invited.httpStatus).toBe(200);
    expect(
      (await familyMembers(app, a.token, a.familyId)).find((m) => m.userId === b.userId)
        ?.displayName,
    ).toBe('二姨');

    // 本人改昵称 → 初始称呼被账号昵称取代（口径 A 的既定取舍）
    await rename(app, b.token, '红红');
    expect(
      (await familyMembers(app, a.token, a.familyId)).find((m) => m.userId === b.userId)
        ?.displayName,
    ).toBe('红红');
  });
});

describe('口径 A · 留痕', () => {
  it('每同步一行写一条 change_log UPDATE（同步游标不丢状态）', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'sync-log-a'); // 家庭 + 行程各 1 行成员
    await rename(app, a.token, '新名字');

    const logs = dumpTable(app, 'changeLog').filter((r) => r['op'] === 'UPDATE');
    const familyLogs = logs.filter((r) => r['entityType'] === 'family_member');
    const tripLogs = logs.filter((r) => r['entityType'] === 'trip_member');

    expect(familyLogs).toHaveLength(1);
    expect(tripLogs).toHaveLength(1);
    // 归属维度必须带上，否则按 family / trip 维度消费的同步会漏
    expect(String(familyLogs[0]!['familyId'])).toBe(a.familyId);
    expect(String(tripLogs[0]!['tripId'])).toBe(a.tripId);
    expect(String(tripLogs[0]!['familyId'])).toBe(a.familyId);
  });
});
