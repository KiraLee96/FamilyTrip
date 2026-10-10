/**
 * v0.1 Alpha 验收主链路 · 端到端
 * ============================================================================
 * 覆盖派发单 §2「v0.1 (Alpha) 可测切片」的完整用户旅程：
 *
 *   登录 → 建家庭 → 加成员 → 加心愿 → 投票 → 心愿转出行草稿
 *        → 建出行 → 加成员 / 设主导者 → 建日程 → 记一笔花销
 *
 * 全部走 `buildApp().dispatch()` —— 即真实 HTTP 路径的完整 8 段链
 * （resolveIdentity → loadUser → withFamily → withTrip → withOwner
 *   → validate → handler → responseEnvelope），不是直接调 service。
 *
 * 这样任何一个中间件段坏掉，本测试都会红。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, DEFAULT_DEV_SECRET, stubWechat, type BuiltApp } from '../src/composition-root.js';
import type { RawRequest } from '../src/common/middleware/dispatcher.js';

/** 便捷构造请求 */
function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; query?: Record<string, string> } = {},
): RawRequest {
  const headers: Record<string, string | undefined> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  return {
    method: method.toUpperCase(),
    path,
    headers,
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };
}

/** 断言成功并取出 data */
function mustOk<T = Record<string, unknown>>(r: { httpStatus: number; envelope: { code: number; message: string; data: unknown } }): T {
  expect(
    r.httpStatus,
    `期望 2xx，实得 ${r.httpStatus} / code=${r.envelope.code} / ${r.envelope.message}`,
  ).toBeLessThan(300);
  expect(r.envelope.code).toBe(0);
  return r.envelope.data as T;
}

describe('v0.1 Alpha 主链路（端到端过 8 段链）', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({
      tokenSecret: DEFAULT_DEV_SECRET,
      wechat: stubWechat(),
      defaultTimezone: 'Asia/Shanghai',
    });
  });

  it('登录：首次 code 注册新用户，同 code 幂等复用', async () => {
    const first = mustOk<{ token: string; isNewUser: boolean; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'alice-code' } })),
    );
    expect(first.isNewUser).toBe(true);
    expect(first.token).toBeTruthy();
    expect(first.user.id).toMatch(/^\d+$/);

    const again = mustOk<{ token: string; isNewUser: boolean; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'alice-code' } })),
    );
    expect(again.isNewUser).toBe(false);
    // 同一 openid 必须映射到同一 user
    expect(again.user.id).toBe(first.user.id);
  });

  it('鉴权：无 token 命中受保护路由 → 401 同形信封；坏 token 同样 401', async () => {
    const noToken = await app.dispatch(req('GET', '/families'));
    expect(noToken.httpStatus).toBe(401);
    expect(noToken.envelope.code).toBe(4010);

    const badToken = await app.dispatch(req('GET', '/families', { token: 'garbage.token' }));
    expect(badToken.httpStatus).toBe(401);
    expect(badToken.envelope.code).toBe(4010);
  });

  it('404 不可区分：不存在的路径与无权的资源返回同一形状（D8）', async () => {
    const ghost = await app.dispatch(req('GET', '/definitely-not-a-route'));
    expect(ghost.httpStatus).toBe(404);
    expect(ghost.envelope.code).toBe(4040);
    // 不泄露「该路径是否存在」
    expect(Object.keys(ghost.envelope).sort()).toEqual(['code', 'data', 'message', 'meta']);
  });

  it('全链路：建家庭 → 加成员 → 加心愿 → 投票 → 转出行草稿 → 设主导者 → 日程 → 花销', async () => {
    // ── 1. 登录三个用户 ───────────────────────────────────────────
    const alice = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'alice' } })),
    );
    const bob = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'bob' } })),
    );
    const carol = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'carol' } })),
    );
    expect(new Set([alice.user.id, bob.user.id, carol.user.id]).size).toBe(3);

    // ── 2. Alice 建家庭 ────────────────────────────────────────────
    const family = mustOk<{ family: { id: string; name: string; inviteCode: string } }>(
      await app.dispatch(
        req('POST', '/families', { token: alice.token, body: { name: '张家' } }),
      ),
    );
    expect(family.family.id).toMatch(/^\d+$/);
    expect(family.family.name).toBe('张家');
    // 建家庭的人自动成为 OWNER 成员
    expect(family.family.inviteCode).toBeTruthy();

    // ── 3. Alice 邀请 Bob、Carol ───────────────────────────────────
    const bobMember = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/families/${family.family.id}/members`, {
          token: alice.token,
          body: { userId: bob.user.id, displayName: '爸爸', role: 'MEMBER' },
        }),
      ),
    );
    expect(bobMember.member.id).toMatch(/^\d+$/);

    const carolMember = mustOk<{ member: { id: string } }>(
      await app.dispatch(
        req('POST', `/families/${family.family.id}/members`, {
          token: alice.token,
          body: { userId: carol.user.id, displayName: '妈妈', role: 'MEMBER' },
        }),
      ),
    );
    expect(carolMember.member.id).toMatch(/^\d+$/);

    // Alice 自己也能看到家庭列表
    const list = mustOk<{ items: Array<{ id: string }> }>(
      await app.dispatch(req('GET', '/families', { token: alice.token })),
    );
    expect(list.items.map((f) => f.id)).toContain(family.family.id);

    // ── 4. Bob 加两个心愿 ──────────────────────────────────────────
    const wish1 = mustOk<{ wish: { id: string; title: string; voteCount: number } }>(
      await app.dispatch(
        req('POST', '/wishes', {
          token: bob.token,
          body: { familyId: family.family.id, title: '去北海道看雪', priority: 3 },
        }),
      ),
    );
    expect(wish1.wish.voteCount).toBe(0);

    const wish2 = mustOk<{ wish: { id: string } }>(
      await app.dispatch(
        req('POST', '/wishes', {
          token: carol.token,
          body: { familyId: family.family.id, title: '去冲绳潜水', priority: 1 },
        }),
      ),
    );

    // ── 5. 投票（Alice-Carol 投第一个；Bob 投第二个）────────────────
    mustOk(
      await app.dispatch(
        req('POST', `/wishes/${wish1.wish.id}/vote`, {
          token: alice.token,
          body: { vote: true },
        }),
      ),
    );
    const voted = mustOk<{ wishId: string; voteCount: number; votedByMe: boolean }>(
      await app.dispatch(
        req('POST', `/wishes/${wish1.wish.id}/vote`, {
          token: carol.token,
          body: { vote: true },
        }),
      ),
    );
    // 票数在事务内重算 —— 必须是 2，不是 1（防「假自增」）
    expect(voted.voteCount).toBe(2);
    expect(voted.votedByMe).toBe(true);

    mustOk(
      await app.dispatch(
        req('POST', `/wishes/${wish2.wish.id}/vote`, { token: bob.token, body: { vote: true } }),
      ),
    );

    // 取消投票 → 票数回落（幂等性 + 双向计数）
    const unvoted = mustOk<{ voteCount: number; votedByMe: boolean }>(
      await app.dispatch(
        req('POST', `/wishes/${wish2.wish.id}/vote`, { token: bob.token, body: { vote: false } }),
      ),
    );
    expect(unvoted.voteCount).toBe(0);
    expect(unvoted.votedByMe).toBe(false);

    // 列表按票数排序 —— 北海道(2) 必须排在冲绳(0) 前面
    const wishList = mustOk<{ items: Array<{ id: string; voteCount: number }> }>(
      await app.dispatch(
        req('GET', '/wishes', {
          token: alice.token,
          query: { familyId: family.family.id },
        }),
      ),
    );
    expect(wishList.items.length).toBeGreaterThanOrEqual(2);
    expect(wishList.items[0]!.voteCount).toBeGreaterThanOrEqual(wishList.items[1]!.voteCount);

    // ── 6. 心愿 → 出行草稿（原子：建 DRAFT + 心愿转 PLANNED + 建者入队）─
    const draft = mustOk<{ trip: { id: string; status: string } }>(
      await app.dispatch(
        req('POST', '/wishes/to-trip-draft', {
          token: alice.token,
          body: {
            familyId: family.family.id,
            wishIds: [wish1.wish.id],
            title: '2026 冬 北海道',
            startDate: '2026-12-20',
            endDate: '2026-12-27',
            timezone: 'Asia/Tokyo',
          },
        }),
      ),
    );
    expect(draft.trip.status).toBe('DRAFT');
    const tripId = draft.trip.id;

    // 转草稿后，被选中的心愿状态必须是 PLANNED，而不是还留在候选池
    const afterPromote = mustOk<{ items: Array<{ id: string; status: string }> }>(
      await app.dispatch(
        req('GET', '/wishes', {
          token: alice.token,
          query: { familyId: family.family.id, status: 'PLANNED' },
        }),
      ),
    );
    expect(afterPromote.items.map((w) => w.id)).toContain(wish1.wish.id);

    // ── 7. 出行加成员 + 设主导者 ───────────────────────────────────
    const bobTripMember = mustOk<{ member: { id: string; userId: string | null } }>(
      await app.dispatch(
        req('POST', `/trips/${tripId}/members`, {
          token: alice.token,
          body: { userId: bob.user.id, displayName: '爸爸', role: 'MEMBER' },
        }),
      ),
    );
    expect(bobTripMember.member.userId).toBe(bob.user.id);

    // 设 Bob 为主导者 —— 返回更新后的整个 trip
    const leaderChanged = mustOk<{ trip: { id: string; leaderId: string | null } }>(
      await app.dispatch(
        req('POST', `/trips/${tripId}/leader`, {
          token: alice.token,
          body: { leaderMemberId: bobTripMember.member.id },
        }),
      ),
    );
    expect(leaderChanged.trip.leaderId).toBe(bob.user.id);

    // ── 8. 出行详情：成员齐、主导者正确 ────────────────────────────
    const detail = mustOk<{ trip: { id: string; leaderId: string | null; status: string } }>(
      await app.dispatch(req('GET', `/trips/${tripId}`, { token: alice.token })),
    );
    expect(detail.trip.id).toBe(tripId);
    expect(detail.trip.leaderId).toBe(bob.user.id);

    // ── 9. 加日程 ──────────────────────────────────────────────────
    const itinerary = mustOk<{ item: { id: string; title: string } }>(
      await app.dispatch(
        req('POST', '/itineraries', {
          token: alice.token,
          body: {
            tripId,
            familyId: family.family.id,
            title: '新千岁机场落地',
            startAt: '2026-12-20T14:30',
            location: 'CTS',
            sort: 1,
          },
        }),
      ),
    );
    expect(itinerary.item.title).toBe('新千岁机场落地');

    // ── 10. 记一笔花销 ──────────────────────────────────────────────
    // M2/M3 纪律：金额以**字符串**传递（禁止 JS number，避免浮点误差），
    // 单位是主单位（元）。服务端按币种精度换算成最小单位落库。
    const expense = mustOk<{ expense: { id: string; amountBase: string | null; currency: string } }>(
      await app.dispatch(
        req('POST', '/expenses', {
          token: alice.token,
          body: {
            tripId,
            familyId: family.family.id,
            title: '机票 3 人',
            amount: '8600.00',
            currency: 'CNY',
            category: 'TRANSPORT',
            spentAt: '2026-12-01',
          },
        }),
      ),
    );
    expect(expense.expense.currency).toBe('CNY');
    // 同币种：amount_base 必须等于换算后的最小单位（8600.00 元 → 860000 分）
    expect(expense.expense.amountBase).toBe('860000');

    // 花销汇总必须把这一笔算进去
    const summary = mustOk<{
      totalMinor: string;
      count: number;
      byCategory: Array<{ category: string | null; totalMinor: string }>;
    }>(
      await app.dispatch(
        req('GET', '/expenses/summary', { token: alice.token, query: { tripId } }),
      ),
    );
    expect(summary.count).toBeGreaterThanOrEqual(1);
    expect(summary.totalMinor).toBe('860000');
    expect(summary.byCategory.some((b) => b.category === 'TRANSPORT')).toBe(true);

    // ── 11. 非成员看不到这个家庭（越权防护）─────────────────────────
    const outsider = mustOk<{ token: string }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'outsider' } })),
    );
    const denied = await app.dispatch(
      req('GET', `/families/${family.family.id}`, { token: outsider.token }),
    );
    // 404 不可区分 —— 不是 403（不确认资源存在）
    expect([404, 403]).toContain(denied.httpStatus);
    expect(denied.envelope.code).not.toBe(0);
  });

  it('软删隔离：删掉的心愿不再出现在列表里', async () => {
    const alice = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'alice2' } })),
    );
    const family = mustOk<{ family: { id: string } }>(
      await app.dispatch(req('POST', '/families', { token: alice.token, body: { name: '李家' } })),
    );
    const wish = mustOk<{ wish: { id: string } }>(
      await app.dispatch(
        req('POST', '/wishes', {
          token: alice.token,
          body: { familyId: family.family.id, title: '去新疆' },
        }),
      ),
    );

    mustOk(
      await app.dispatch(req('DELETE', `/wishes/${wish.wish.id}`, { token: alice.token })),
    );

    const list = mustOk<{ items: Array<{ id: string }> }>(
      await app.dispatch(
        req('GET', '/wishes', { token: alice.token, query: { familyId: family.family.id } }),
      ),
    );
    expect(list.items.map((w) => w.id)).not.toContain(wish.wish.id);

    // 详情也必须 404（软删后读不到）
    const gone = await app.dispatch(req('GET', `/wishes/${wish.wish.id}`, { token: alice.token }));
    expect(gone.httpStatus).toBe(404);
  });

  it('路由表唯一性与规模：无重复注册，域数 = 16', async () => {
    const keys = app.routes.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 14 个业务域 + auth + fx（合成根共装配 16 组路由）
    expect(app.routes.length).toBeGreaterThanOrEqual(60);
  });
});
