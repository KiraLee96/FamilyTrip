/**
 * D-2026-10-22-01 · P0/P1 验收：行程邀请码三端点 + media 域历史只读门
 * ============================================================================
 * 覆盖派发单 D-2026-10-14-02 §6.1（1-8）与 D-2026-10-22-01 §2.4（1-4）。
 *
 * 驱动：内存驱动（MemoryTableDriver）—— 与既有集成测试同口径。
 * 全部走 `app.dispatch()` 真实 8 段链（含权限网关），不直接调 service：
 * 邀请码的「谁能看 / 谁能重置 / 谁能加入」三个判定横跨网关与 service，
 * 只测 service 会漏掉网关层的 404 同形拒。
 *
 * 🔴 口径说明（勿按直觉改断言）：
 *   · 「非成员 GET invite」在**网关层**即被 404 同形拒（TRIP 维度不放行），
 *     不是因为 service 抛了 FORBIDDEN —— 这是 D8「越权与不存在逐字节一致」
 *     的既有设计。派发单写的「非成员 → 403」在实现层由 service 的
 *     `assertTripMember` 兜底，但正常请求打不到那里，故断言 404。
 *   · 「非主导者 reset」是行程成员调写接口：网关放行 → service 抛 403，
 *     故此处能断言到 403。
 */

import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { INVITE_CODE_PATTERN } from '../src/common/invite-code.js';
import { dumpTable, mustOk, req, type Scaffold } from './helpers.js';

function freshApp(): BuiltApp {
  return buildApp({ driver: new MemoryTableDriver(), mediaPublicBaseUrl: 'https://media.test' });
}

/** 登录（同一 code 幂等，可安全重复调用） */
async function login(app: BuiltApp, code: string): Promise<{ token: string; userId: string }> {
  const d = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  return { token: d.token, userId: d.user.id };
}

/**
 * 建立「用户 + 家庭 + 出行」脚手架，并**保留 POST /trips 的原始响应体**。
 *
 * 不用 `helpers.scaffold`：它只回 id，而验收第 1 条要看
 * 「创建行程的响应体里有没有 inviteCode」—— 那正是前端「创建完立即进入
 * 邀请步骤」的取码路径，必须直接断言 create 的返回，不能绕过。
 */
async function scaffoldWithCreate(
  app: BuiltApp,
  code: string,
): Promise<{ s: Scaffold; createdTrip: Record<string, unknown> }> {
  const me = await login(app, code);
  const family = mustOk<{ family: { id: string } }>(
    await app.dispatch(req('POST', '/families', { token: me.token, body: { name: `${code}家` } })),
  );
  const trip = mustOk<{ trip: Record<string, unknown> }>(
    await app.dispatch(
      req('POST', '/trips', {
        token: me.token,
        body: {
          familyId: family.family.id,
          title: `${code} 出行`,
          startDate: '2026-08-01',
          endDate: '2026-08-03',
        },
      }),
    ),
  );
  return {
    s: {
      token: me.token,
      userId: me.userId,
      familyId: family.family.id,
      tripId: String(trip.trip['id']),
    },
    createdTrip: trip.trip,
  };
}

/** 登记一个媒体资产（真实两段式：presign → confirm） */
async function createAsset(
  app: BuiltApp,
  s: Scaffold,
  opts: { withTrip: boolean } = { withTrip: true },
): Promise<Record<string, unknown>> {
  const pre = await app.dispatch(
    req('POST', '/media/presign', {
      token: s.token,
      body: {
        familyId: s.familyId,
        ...(opts.withTrip ? { tripId: s.tripId } : {}),
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: '1024',
      },
    }),
  );
  const signed = mustOk<{ fileKey: string }>(pre);

  const r = await app.dispatch(
    req('POST', '/media/confirm', {
      token: s.token,
      body: {
        familyId: s.familyId,
        ...(opts.withTrip ? { tripId: s.tripId } : {}),
        fileKey: signed.fileKey,
        mimeType: 'image/jpeg',
        byteSize: '1024',
        compressed: true,
        exifStripped: true,
        hadGps: false,
        storageClass: 'STANDARD',
      },
    }),
  );
  return mustOk<{ asset: Record<string, unknown> }>(r).asset;
}

/** 把行程推进到 FINISHED（同时把全体成员转 HISTORICAL_READONLY，B6） */
async function finishTrip(app: BuiltApp, s: Scaffold): Promise<void> {
  mustOk(
    await app.dispatch(
      req('POST', `/trips/${s.tripId}/finish`, { token: s.token, body: { version: 0 } }),
    ),
  );
}

/** 取邀请码 */
async function inviteOf(
  app: BuiltApp,
  s: Scaffold,
): Promise<{ inviteCode: string; updatedAt: string; tripId: string }> {
  return mustOk<{ inviteCode: string; updatedAt: string; tripId: string }>(
    await app.dispatch(req('GET', `/trips/${s.tripId}/invite`, { token: s.token })),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// §一 P0：邀请码三端点
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-14-02 · 行程邀请码三端点', () => {
  it('① POST /trips 响应体带 inviteCode（8 位，去易混字符集）', async () => {
    const app = freshApp();
    const { createdTrip } = await scaffoldWithCreate(app, 'inv1');
    const code = createdTrip['inviteCode'];
    expect(typeof code).toBe('string');
    expect(code).toMatch(INVITE_CODE_PATTERN);
    // invite_updated_at 也要有值（前端邀请卡展示「重置时间」）
    expect(Number.isFinite(new Date(String(createdTrip['inviteUpdatedAt'])).getTime())).toBe(true);
  });

  it('② GET /trips/:id/invite → {tripId(字符串), inviteCode, updatedAt(ISO)}，且与详情一致', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv2');
    const invite = await inviteOf(app, s);
    expect(invite.tripId).toBe(s.tripId);
    expect(invite.inviteCode).toMatch(INVITE_CODE_PATTERN);
    expect(Number.isFinite(new Date(invite.updatedAt).getTime())).toBe(true);

    const detail = mustOk<{ trip: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/trips/${s.tripId}`, { token: s.token })),
    );
    expect(detail.trip.inviteCode).toBe(invite.inviteCode);
  });

  it('③ reset 换新码；旧码 join → 404 邀请码无效', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv3');
    const before = await inviteOf(app, s);
    const after = mustOk<{ inviteCode: string; updatedAt: string }>(
      await app.dispatch(req('POST', `/trips/${s.tripId}/invite/reset`, { token: s.token })),
    );
    expect(after.inviteCode).toMatch(INVITE_CODE_PATTERN);
    expect(after.inviteCode).not.toBe(before.inviteCode);
    expect(Number.isFinite(new Date(after.updatedAt).getTime())).toBe(true);

    const other = await login(app, 'inv3-other');
    const stale = await app.dispatch(
      req('POST', '/trips/join', { token: other.token, body: { inviteCode: before.inviteCode } }),
    );
    expect(stale.httpStatus).toBe(404);
    expect(stale.envelope.code).toBe(4040);
    expect(stale.envelope.message).toBe('邀请码无效');
  });

  it('④⑤ 外部同行者 join → isExternal/role/accessLevel 正确；二次 join 幂等不插行', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv4');
    const invite = await inviteOf(app, s);
    const other = await login(app, 'inv4-other');

    const first = mustOk<{
      trip: { id: string };
      member: {
        id: string;
        isExternal: boolean;
        role: string;
        accessLevel: string;
        userId: string;
      };
      alreadyMember: boolean;
    }>(
      await app.dispatch(
        req('POST', '/trips/join', {
          token: other.token,
          body: { inviteCode: invite.inviteCode, displayName: '同行朋友' },
        }),
      ),
    );
    expect(first.alreadyMember).toBe(false);
    expect(first.trip.id).toBe(s.tripId);
    expect(first.member.isExternal).toBe(true);
    expect(first.member.role).toBe('MEMBER');
    expect(first.member.accessLevel).toBe('ACTIVE');
    expect(first.member.userId).toBe(other.userId);

    const countRows = (): number =>
      dumpTable(app, 'tripMember').filter((r) => String(r['tripId']) === s.tripId).length;
    const rowsAfterFirst = countRows();

    const second = mustOk<{ alreadyMember: boolean; member: { id: string } }>(
      await app.dispatch(
        req('POST', '/trips/join', { token: other.token, body: { inviteCode: invite.inviteCode } }),
      ),
    );
    expect(second.alreadyMember).toBe(true);
    expect(second.member.id).toBe(first.member.id);
    expect(countRows()).toBe(rowsAfterFirst);
  });

  it('⑥ FINISHED 行程 join → 403 行程已结束，无法加入（GRP-08）', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv5');
    const invite = await inviteOf(app, s);
    await finishTrip(app, s);

    const other = await login(app, 'inv5-other');
    const r = await app.dispatch(
      req('POST', '/trips/join', { token: other.token, body: { inviteCode: invite.inviteCode } }),
    );
    expect(r.httpStatus).toBe(403);
    expect(r.envelope.code).toBe(4030);
    expect(r.envelope.message).toBe('行程已结束，无法加入');
  });

  it('⑦ 非成员 GET invite → 404 同形；非主导者（普通成员）reset → 403', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv6');
    const invite = await inviteOf(app, s);

    // 外部用户（尚未加入）= 非成员：网关层 404 同形，不泄漏行程存在性
    const outsider = await login(app, 'inv6-outsider');
    const denied = await app.dispatch(
      req('GET', `/trips/${s.tripId}/invite`, { token: outsider.token }),
    );
    expect(denied.httpStatus).toBe(404);
    expect(denied.envelope.code).toBe(4040);

    // 普通成员（join 进来的朋友）调 reset → 网关放行、service 拒 → 403
    mustOk(
      await app.dispatch(
        req('POST', '/trips/join', {
          token: outsider.token,
          body: { inviteCode: invite.inviteCode },
        }),
      ),
    );
    const reset = await app.dispatch(
      req('POST', `/trips/${s.tripId}/invite/reset`, { token: outsider.token }),
    );
    expect(reset.httpStatus).toBe(403);
    expect(reset.envelope.code).toBe(4030);
    expect(reset.envelope.message).toBe('仅主导者可执行该操作');
  });

  it('⑧ 历史行（invite_code 为空）GET invite → 懒生成并补写落库', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv7');
    // 模拟迁移前建的历史行：清空邀请码
    await app.driver.update('trip', { id: BigInt(s.tripId) }, { inviteCode: null });

    const invite = await inviteOf(app, s);
    expect(invite.inviteCode).toMatch(INVITE_CODE_PATTERN);

    const row = dumpTable(app, 'trip').find((r) => String(r['id']) === s.tripId);
    expect(row?.['inviteCode']).toBe(invite.inviteCode);
  });

  it('⑨ 行程软删后邀请码不可再用 → join 404（原 C3 守卫用例的落地版）', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'inv8');
    const invite = await inviteOf(app, s);
    mustOk(await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token })));

    const other = await login(app, 'inv8-other');
    const r = await app.dispatch(
      req('POST', '/trips/join', { token: other.token, body: { inviteCode: invite.inviteCode } }),
    );
    expect(r.httpStatus).toBe(404);
  });

  it('⑩ join 入参校验：inviteCode 太短 → 422', async () => {
    const app = freshApp();
    const other = await login(app, 'inv9-short');
    const r = await app.dispatch(
      req('POST', '/trips/join', { token: other.token, body: { inviteCode: 'AB' } }),
    );
    expect(r.httpStatus).toBe(422);
    expect(r.envelope.code).toBe(4001);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §二 P1：media 域历史只读门
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-22-01 · media 域 HISTORICAL_READONLY 拒写', () => {
  it('M1：FINISHED 行程 confirm（带 tripId）→ 403 该出行已归档，仅可查看', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med1');
    // 先取上传位（此时行程还 ACTIVE）
    const pre = await app.dispatch(
      req('POST', '/media/presign', {
        token: s.token,
        body: {
          familyId: s.familyId,
          tripId: s.tripId,
          fileName: 'late.jpg',
          mimeType: 'image/jpeg',
          byteSize: '2048',
        },
      }),
    );
    const signed = mustOk<{ fileKey: string }>(pre);
    await finishTrip(app, s);

    const r = await app.dispatch(
      req('POST', '/media/confirm', {
        token: s.token,
        body: {
          familyId: s.familyId,
          tripId: s.tripId,
          fileKey: signed.fileKey,
          mimeType: 'image/jpeg',
          byteSize: '2048',
          compressed: true,
          exifStripped: true,
          hadGps: false,
          storageClass: 'STANDARD',
        },
      }),
    );
    expect(r.httpStatus).toBe(403);
    expect(r.envelope.code).toBe(4030);
    expect(r.envelope.message).toBe('该出行已归档，仅可查看');
  });

  it('M2：FINISHED 行程 presign（带 tripId）→ 403（提前拦截）', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med2');
    await finishTrip(app, s);
    const r = await app.dispatch(
      req('POST', '/media/presign', {
        token: s.token,
        body: {
          familyId: s.familyId,
          tripId: s.tripId,
          fileName: 'x.jpg',
          mimeType: 'image/jpeg',
          byteSize: '1024',
        },
      }),
    );
    expect(r.httpStatus).toBe(403);
    expect(r.envelope.message).toBe('该出行已归档，仅可查看');
  });

  it('M3：FINISHED 行程 DELETE /media/:id（资产属该行程）→ 403', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med3');
    const asset = await createAsset(app, s);
    await finishTrip(app, s);

    const r = await app.dispatch(
      req('DELETE', `/media/${String(asset['id'])}`, { token: s.token }),
    );
    expect(r.httpStatus).toBe(403);
    expect(r.envelope.message).toBe('该出行已归档，仅可查看');
  });

  it('M4：ACTIVE 行程同一组操作全部成功（回归不破）', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med4');
    const asset = await createAsset(app, s); // presign + confirm 均带 tripId
    expect(asset['tripId']).toBe(s.tripId);
    mustOk(await app.dispatch(req('DELETE', `/media/${String(asset['id'])}`, { token: s.token })));
  });

  it('M5：家庭照片（tripId 为空）删除行为不变', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med5');
    const asset = await createAsset(app, s, { withTrip: false });
    expect(asset['tripId']).toBeNull();
    mustOk(await app.dispatch(req('DELETE', `/media/${String(asset['id'])}`, { token: s.token })));
  });

  it('M6：行程软删后照片仍可由上传者删除（不因父行程消失而卡死）', async () => {
    const app = freshApp();
    const { s } = await scaffoldWithCreate(app, 'med6');
    const asset = await createAsset(app, s);
    mustOk(await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token })));

    mustOk(await app.dispatch(req('DELETE', `/media/${String(asset['id'])}`, { token: s.token })));
  });
});
