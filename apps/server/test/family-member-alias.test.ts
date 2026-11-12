/**
 * 家庭称呼：创建时可指定 + 成员可改自己（2026-11-12 反馈）
 * ============================================================================
 * 反馈原文：「我是创建者的话 没有地方让我选择我的称呼呀」
 *
 * 两个入口此前都缺：
 *   ① 创建家庭 —— 走后端 `create`，不经过 `JoinFamilyPage` 的「我的称呼」输入框，
 *      户主的称呼只能等于账号昵称；
 *   ② 已有家庭 —— `PATCH /families/members/:id` 只有户主能调，成员连自己那行都改不了，
 *      加入时填错就永久卡住。
 *
 * 本文件锁权限边界（放宽 ≠ 放开）：
 *   · 本人 → 只能改自己的 `displayName`，动 role / managedBy 一律 403
 *   · 户主 → 可改任意成员（含虚拟成员）
 *   · 非户主的其他成员 → 改别人 403
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import { mustOk, req } from './helpers.js';

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
}

async function members(app: BuiltApp, token: string, familyId: string): Promise<MemberRow[]> {
  const r = mustOk<{ members: MemberRow[] }>(
    await app.dispatch(req('GET', `/families/${familyId}`, { token })),
  );
  return r.members;
}

describe('创建家庭时可指定户主称呼', () => {
  it('传 displayName → 户主成员行用该称呼，账号昵称仍是昵称', async () => {
    const app = freshApp();
    const a = await login(app, 'alias-create-a');
    await rename(app, a.token, '小珂');

    const created = mustOk<{ family: { id: string } }>(
      await app.dispatch(
        req('POST', '/families', {
          token: a.token,
          body: { name: '我们一家', displayName: '爸爸' },
        }),
      ),
    );

    const owner = (await members(app, a.token, created.family.id)).find(
      (m) => m.userId === a.userId,
    )!;
    expect(owner.displayName).toBe('爸爸'); // 称呼
    expect(owner.nickname).toBe('小珂'); // 昵称
  });

  it('不传 displayName → 回落成账号昵称（老行为不回归）', async () => {
    const app = freshApp();
    const a = await login(app, 'alias-create-b');
    await rename(app, a.token, '小珂');
    const created = mustOk<{ family: { id: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: '我们一家' } })),
    );
    const owner = (await members(app, a.token, created.family.id)).find(
      (m) => m.userId === a.userId,
    )!;
    expect(owner.displayName).toBe('小珂');
    expect(owner.nickname).toBe('小珂');
  });

  it('创建时响应信封不变（仍是 data.family，不带成员）', async () => {
    const app = freshApp();
    const a = await login(app, 'alias-create-c');
    const created = mustOk<Record<string, unknown>>(
      await app.dispatch(
        req('POST', '/families', {
          token: a.token,
          body: { name: '我们一家', displayName: '爸爸' },
        }),
      ),
    );
    expect(Object.keys(created)).toEqual(['family']);
  });
});

describe('成员可改自己的称呼，不可越权', () => {
  /** 建家庭 + B 加入，返回双方与家庭 id */
  async function twoMembers(
    app: BuiltApp,
    aCode: string,
    bCode: string,
  ): Promise<{
    a: { token: string; userId: string };
    b: { token: string; userId: string };
    familyId: string;
  }> {
    const a = await login(app, aCode);
    await rename(app, a.token, '小珂');
    const created = mustOk<{ family: { id: string; inviteCode: string } }>(
      await app.dispatch(req('POST', '/families', { token: a.token, body: { name: '我们一家' } })),
    );
    const b = await login(app, bCode);
    await rename(app, b.token, '小李');
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: b.token,
          body: { inviteCode: created.family.inviteCode },
        }),
      ),
    );
    return { a, b, familyId: created.family.id };
  }

  it('B 改自己的称呼 → 200，且只动自己那行', async () => {
    const app = freshApp();
    const { a, b, familyId } = await twoMembers(app, 'alias-self-a', 'alias-self-b');
    const bRow = (await members(app, a.token, familyId)).find((m) => m.userId === b.userId)!;

    const r = await app.dispatch(
      req('PATCH', `/families/members/${bRow.id}`, {
        token: b.token,
        body: { displayName: '二姨' },
      }),
    );
    expect(r.httpStatus).toBe(200);

    const after = await members(app, a.token, familyId);
    expect(after.find((m) => m.userId === b.userId)?.displayName).toBe('二姨');
    expect(after.find((m) => m.userId === a.userId)?.displayName).toBe('小珂');
  });

  it('B 改自己的角色 / 代管人 → 403（放宽只放行称呼）', async () => {
    const app = freshApp();
    const { a, b, familyId } = await twoMembers(app, 'alias-selfrole-a', 'alias-selfrole-b');
    const bRow = (await members(app, a.token, familyId)).find((m) => m.userId === b.userId)!;

    const roleChange = await app.dispatch(
      req('PATCH', `/families/members/${bRow.id}`, {
        token: b.token,
        body: { role: 'MEMBER', displayName: '二姨' },
      }),
    );
    // role 与 displayName 同时传 → 仍视为越权（role 不在本人可改范围）
    expect(roleChange.httpStatus).toBe(403);
    expect(roleChange.envelope.code).toBe(ErrorCode.FORBIDDEN);

    const managedByChange = await app.dispatch(
      req('PATCH', `/families/members/${bRow.id}`, {
        token: b.token,
        body: { managedBy: a.userId },
      }),
    );
    expect(managedByChange.httpStatus).toBe(403);
  });

  it('B 改 A（户主）的称呼 → 403', async () => {
    const app = freshApp();
    const { a, b, familyId } = await twoMembers(app, 'alias-other-a', 'alias-other-b');
    const aRow = (await members(app, a.token, familyId)).find((m) => m.userId === a.userId)!;

    const r = await app.dispatch(
      req('PATCH', `/families/members/${aRow.id}`, {
        token: b.token,
        body: { displayName: '老王' },
      }),
    );
    expect(r.httpStatus).toBe(403);
  });

  it('户主可改任意成员（含虚拟成员）的称呼', async () => {
    const app = freshApp();
    const { a, familyId } = await twoMembers(app, 'alias-owner-a', 'alias-owner-b');

    const virtual = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/families/${familyId}/members`, {
          token: a.token,
          body: { displayName: '奶奶', isVirtual: true },
        }),
      ),
    );
    const r1 = await app.dispatch(
      req('PATCH', `/families/members/${virtual.member.id}`, {
        token: a.token,
        body: { displayName: '外婆' },
      }),
    );
    expect(r1.httpStatus).toBe(200);
    expect(
      (await members(app, a.token, familyId)).find((m) => m.userId === null)?.displayName,
    ).toBe('外婆');
  });

  it('称呼改完后改昵称：称呼保留（与昵称解耦）', async () => {
    const app = freshApp();
    const { a, b, familyId } = await twoMembers(app, 'alias-then-nick-a', 'alias-then-nick-b');
    const bRow = (await members(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    mustOk(
      await app.dispatch(
        req('PATCH', `/families/members/${bRow.id}`, {
          token: b.token,
          body: { displayName: '二姨' },
        }),
      ),
    );

    await rename(app, b.token, '李李');

    const bAfter = (await members(app, a.token, familyId)).find((m) => m.userId === b.userId)!;
    expect(bAfter.nickname).toBe('李李');
    expect(bAfter.displayName).toBe('二姨'); // 称呼不被昵称覆盖
  });
});
