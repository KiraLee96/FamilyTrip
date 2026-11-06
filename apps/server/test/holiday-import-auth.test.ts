/**
 * 节假日字典 · 写权限回归（2026-11-06 安全修复）
 * ============================================================================
 * 漏洞：`POST /holidays/import` 原先允许 `familyId` 缺省 → 写入 `family_id = NULL`
 *       的**全国法定字典**；而该路由 `idParam: '__none__'`，链路第 5 段
 *       `if (rawId !== undefined)` 整段跳过，`checkAccess` 根本不执行，
 *       只剩登录校验。结果：任意登录用户能把全国假期改成「上班」。
 *
 * 本文件锁四件事（每条都对应一种绕过方式）：
 *   1. 缺 familyId / 传非数字 → 422（schema 层堵死「写全国字典」这条路）
 *   2. 不是家庭成员 → 404（不泄漏家庭是否存在）
 *   3. 是成员但不是户主 → 403（普通成员不能单方面改全家的假）
 *   4. 户主 → 可写，但落库的 `familyId` 恒非空，且只影响自家视图
 *
 * ⚠️ 第 4 条必须验证「读回来是 FAMILY 来源」而不是只看写入返回 200 ——
 *    只看 200 的话，`upsert` 里少写一次 `familyId` 就能骗过测试。
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import { dumpTable, mustOk, req, scaffold } from './helpers.js';

function freshApp(): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    autoFinish: { enabled: false, lazyOnRead: false },
  });
}

/** 只登录，不建家庭 */
async function loginOnly(app: BuiltApp, code: string): Promise<{ token: string; userId: string }> {
  const r = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  return { token: r.token, userId: r.user.id };
}

const ITEM = { name: '公司假', date: '2027-02-05', isWorkday: false };

describe('POST /holidays/import · 全国字典不可写', () => {
  it('缺 familyId → 422（原漏洞的入口）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'holiday-no-family');

    const r = await app.dispatch(
      req('POST', '/holidays/import', { token: s.token, body: { items: [ITEM] } }),
    );
    expect(r.httpStatus).toBe(422);
    expect(r.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('familyId 传 "null" / "undefined" 之类也拒（不能绕过 refine）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'holiday-bad-family');

    for (const bad of ['null', 'undefined', '', 'abc']) {
      const r = await app.dispatch(
        req('POST', '/holidays/import', { token: s.token, body: { familyId: bad, items: [ITEM] } }),
      );
      expect(r.httpStatus, `familyId=${bad} 应被拒`).toBe(422);
    }
  });

  it('未登录 → 401', async () => {
    const app = freshApp();
    const r = await app.dispatch(req('POST', '/holidays/import', { body: { items: [ITEM] } }));
    expect(r.httpStatus).toBe(401);
  });

  it('用别人家的 familyId → 404（不泄漏该家庭是否存在）', async () => {
    const app = freshApp();
    const owner = await scaffold(app, 'holiday-owner');
    const stranger = await loginOnly(app, 'holiday-stranger');

    const r = await app.dispatch(
      req('POST', '/holidays/import', {
        token: stranger.token,
        body: { familyId: owner.familyId, items: [ITEM] },
      }),
    );
    expect(r.httpStatus).toBe(404);
    // 关键：拒绝之后字典必须是干净的
    const list = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(
        req('GET', '/holidays', {
          token: owner.token,
          query: { country: 'CN', year: '2027' },
        }),
      ),
    );
    expect(list.items).toHaveLength(0);
  });

  it('家庭成员（非户主）→ 403', async () => {
    const app = freshApp();
    const owner = await scaffold(app, 'holiday-owner-2');
    const member = await loginOnly(app, 'holiday-member');

    // 走真实加入流程：拿邀请码 join
    const detail = mustOk<{ family: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/families/${owner.familyId}`, { token: owner.token })),
    );
    mustOk(
      await app.dispatch(
        req('POST', '/families/join', {
          token: member.token,
          body: { inviteCode: detail.family.inviteCode },
        }),
      ),
    );

    const r = await app.dispatch(
      req('POST', '/holidays/import', {
        token: member.token,
        body: { familyId: owner.familyId, items: [ITEM] },
      }),
    );
    expect(r.httpStatus).toBe(403);
    expect(r.envelope.code).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('POST /holidays/import · 户主可写自家字典', () => {
  it('落库 familyId 恒非空，读回是 FAMILY 来源且只覆盖自家', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'holiday-family-a');
    const b = await scaffold(app, 'holiday-family-b');

    const ok = mustOk<{ inserted: number; replaced: number }>(
      await app.dispatch(
        req('POST', '/holidays/import', {
          token: a.token,
          body: { familyId: a.familyId, items: [ITEM] },
        }),
      ),
    );
    expect(ok.inserted).toBe(1);

    // ① 物理行：family_id 必须是具体值，绝不能是 NULL
    const rows = dumpTable(app, 'holiday');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['familyId']).not.toBeNull();
    expect(String(rows[0]!['familyId'])).toBe(a.familyId);

    // ② 读回来：A 家看到 FAMILY 覆盖；B 家看不到
    const listA = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(
        req('GET', '/holidays', { token: a.token, query: { country: 'CN', year: '2027' } }),
      ),
    );
    expect(listA.items).toHaveLength(1);
    expect(listA.items[0]).toMatchObject({ name: '公司假', date: '2027-02-05', source: 'FAMILY' });

    const listB = mustOk<{ items: unknown[] }>(
      await app.dispatch(
        req('GET', '/holidays', { token: b.token, query: { country: 'CN', year: '2027' } }),
      ),
    );
    expect(listB.items).toHaveLength(0);
  });

  it('同日期重复导入 → 覆盖而非新增（幂等，旧行软删）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'holiday-idempotent');

    mustOk(
      await app.dispatch(
        req('POST', '/holidays/import', {
          token: s.token,
          body: { familyId: s.familyId, items: [ITEM] },
        }),
      ),
    );
    const second = mustOk<{ inserted: number; replaced: number }>(
      await app.dispatch(
        req('POST', '/holidays/import', {
          token: s.token,
          body: {
            familyId: s.familyId,
            items: [{ name: '公司假（改）', date: '2027-02-05', isWorkday: true }],
          },
        }),
      ),
    );
    expect(second).toMatchObject({ inserted: 1, replaced: 1 });

    const active = dumpTable(app, 'holiday').filter((r) => r['deletedAt'] === null);
    expect(active).toHaveLength(1);
    expect(active[0]!['name']).toBe('公司假（改）');
  });
});
