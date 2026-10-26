/**
 * D-2026-10-26-01 · P0-1 / P0-2 / P1-2 验收：长期清单模板的改 / 删 / 列
 * ============================================================================
 * 覆盖派发单 §P0-1 验收用例 1–5、§P0-2 验收用例 1–3、§P1-2。
 *
 * 驱动：内存驱动（MemoryTableDriver），全部走 `app.dispatch()` 真实 8 段链。
 * 🔴 必须走 HTTP 层而不是直接调 service：模板是**双语义**表，
 *    「SHARED family 维度」与「PERSONAL 私有短路」的判定分别落在
 *    链第 5 段（checkAccess）与 service 复核两处；只测 service 会漏掉网关层，
 *    而本次修的正是「SHARED 模板在网关层拿不到 familyId → 恒 404」这个缺陷。
 */

import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import { dumpTable, mustOk, req, scaffold, type DispatchResult, type Scaffold } from './helpers.js';

function freshApp(): BuiltApp {
  return buildApp({ driver: new MemoryTableDriver(), mediaPublicBaseUrl: 'https://media.test' });
}

interface TemplateRow {
  id: string;
  familyId: string | null;
  scope: 'SHARED' | 'PERSONAL';
  ownerId: string | null;
  name: string;
  items: Array<{ name: string; quantity: number }>;
  itemsJson?: unknown;
  version: number;
}

async function createTemplate(
  app: BuiltApp,
  s: Scaffold,
  body: Record<string, unknown>,
): Promise<TemplateRow> {
  const r = mustOk<{ template: TemplateRow }>(
    await app.dispatch(req('POST', '/checklists/templates', { token: s.token, body })),
  );
  return r.template;
}

async function listTemplates(
  app: BuiltApp,
  s: Scaffold,
  query?: Record<string, string>,
): Promise<TemplateRow[]> {
  const r = mustOk<{ items: TemplateRow[] }>(
    await app.dispatch(
      req('GET', '/checklists/templates', {
        token: s.token,
        ...(query !== undefined ? { query } : {}),
      }),
    ),
  );
  return r.items;
}

/** 第二个用户加入同一家庭（走真实邀请码链路） */
async function joinFamily(app: BuiltApp, inviteCode: string, code: string): Promise<Scaffold> {
  const login = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  mustOk(
    await app.dispatch(
      req('POST', '/families/join', {
        token: login.token,
        body: { inviteCode, displayName: code },
      }),
    ),
  );
  return { token: login.token, userId: login.user.id, familyId: '', tripId: '' };
}

async function familyInviteCodeOf(app: BuiltApp, s: Scaffold): Promise<string> {
  const detail = mustOk<{ family: { inviteCode: string } }>(
    await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
  );
  return detail.family.inviteCode;
}

describe('P0-1 · PATCH /checklists/templates/:id', () => {
  it('① 改名称 → 列表读回新名称，version 自增 1', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl1');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '家庭出行常用',
      scope: 'SHARED',
      items: [{ name: '身份证', quantity: 4 }],
    });
    expect(tpl.version).toBe(0);

    const patched = mustOk<{ template: TemplateRow }>(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${tpl.id}`, {
          token: s.token,
          body: { version: tpl.version, name: '国庆出行' },
        }),
      ),
    );
    expect(patched.template.name).toBe('国庆出行');
    expect(patched.template.version).toBe(1);
    // 只改名不动条目
    expect(patched.template.items).toEqual([{ name: '身份证', quantity: 4 }]);

    const listed = await listTemplates(app, s, { familyId: s.familyId });
    const again = listed.find((t) => t.id === tpl.id);
    expect(again?.name).toBe('国庆出行');
    expect(again?.version).toBe(1);
  });

  it('② items 整体替换；传 items: [] → 条目清空但模板保留', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl2');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '露营清单',
      scope: 'SHARED',
      items: [
        { name: '帐篷', quantity: 1 },
        { name: '睡袋', quantity: 3 },
      ],
    });

    const replaced = mustOk<{ template: TemplateRow }>(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${tpl.id}`, {
          token: s.token,
          body: {
            version: 0,
            items: [
              { name: '帐篷', quantity: 1 },
              { name: '溯溪鞋', quantity: 1 },
            ],
          },
        }),
      ),
    );
    // 整体替换：睡袋消失（不是增量合并）
    expect(replaced.template.items).toEqual([
      { name: '帐篷', quantity: 1 },
      { name: '溯溪鞋', quantity: 1 },
    ]);

    const cleared = mustOk<{ template: TemplateRow }>(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${tpl.id}`, {
          token: s.token,
          body: { version: 1, items: [] },
        }),
      ),
    );
    expect(cleared.template.items).toEqual([]);
    expect(cleared.template.name).toBe('露营清单'); // 模板本身保留
    expect(cleared.template.version).toBe(2);
  });

  it('③ 用旧 version 再改 → 409，且库内数据未被覆盖', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl3');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '老名字',
      scope: 'SHARED',
      items: [{ name: '雨伞', quantity: 1 }],
    });

    mustOk(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${tpl.id}`, {
          token: s.token,
          body: { version: 0, name: '先到者' },
        }),
      ),
    );

    const stale = await app.dispatch(
      req('PATCH', `/checklists/templates/${tpl.id}`, {
        token: s.token,
        body: { version: 0, name: '后到者（应被拒）' },
      }),
    );
    expect(stale.httpStatus).toBe(409);
    expect(stale.envelope.code).toBe(ErrorCode.VERSION_CONFLICT);

    // 物理行断言：名字仍是「先到者」，version 仍是 1
    const row = dumpTable(app, 'checklistTemplate').find((r) => String(r['id']) === tpl.id);
    expect(row?.['name']).toBe('先到者');
    expect(Number(row?.['version'])).toBe(1);
  });

  it('④ 改别人的 PERSONAL 模板 → 404（不是 403）；同家庭 SHARED 模板另一成员可改', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'tpl4a');
    const b = await joinFamily(app, await familyInviteCodeOf(app, a), 'tpl4b');

    // A 的私人清单
    const personal = await createTemplate(app, a, {
      name: '我的私人物品',
      scope: 'PERSONAL',
      ownerId: a.userId,
      items: [{ name: '隐形眼镜', quantity: 1 }],
    });

    const denied = await app.dispatch(
      req('PATCH', `/checklists/templates/${personal.id}`, {
        token: b.token,
        body: { version: 0, name: '我要改别人的' },
      }),
    );
    // 越权与不存在同形：必须是 404，不能是 403
    expect(denied.httpStatus).toBe(404);
    expect(denied.envelope.code).toBe(ErrorCode.NOT_FOUND);

    // SHARED 模板：家庭任一成员都能改（与 applyTemplate 的「任意成员可引用」同口径）
    const shared = await createTemplate(app, a, {
      familyId: a.familyId,
      name: '家庭共用',
      scope: 'SHARED',
      items: [{ name: '垃圾袋', quantity: 2 }],
    });
    const okByB = await app.dispatch(
      req('PATCH', `/checklists/templates/${shared.id}`, {
        token: b.token,
        body: { version: 0, items: [{ name: '垃圾袋', quantity: 3 }] },
      }),
    );
    expect(okByB.httpStatus).toBe(200);
  });

  it('⑤ items 传 201 条 → 校验失败；超过 64 字的名称同样被拒', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl5');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '上限用例',
      scope: 'SHARED',
      items: [],
    });

    const tooMany = await app.dispatch(
      req('PATCH', `/checklists/templates/${tpl.id}`, {
        token: s.token,
        body: {
          version: 0,
          items: Array.from({ length: 201 }, (_, i) => ({ name: `物品${i}`, quantity: 1 })),
        },
      }),
    );
    // 项目统一口径：校验失败 = 4001（HTTP 422），不是裸 400
    expect(tooMany.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);

    const badName = await app.dispatch(
      req('PATCH', `/checklists/templates/${tpl.id}`, {
        token: s.token,
        body: { version: 0, name: 'x'.repeat(65) },
      }),
    );
    expect(badName.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('空 PATCH（只给 version）→ 校验失败，不白涨 version', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl6');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '空 patch',
      scope: 'SHARED',
      items: [],
    });
    const empty = await app.dispatch(
      req('PATCH', `/checklists/templates/${tpl.id}`, { token: s.token, body: { version: 0 } }),
    );
    expect(empty.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
    const row = dumpTable(app, 'checklistTemplate').find((r) => String(r['id']) === tpl.id);
    expect(Number(row?.['version'])).toBe(0);
  });
});

describe('P0-2 · DELETE /checklists/templates/:id', () => {
  it('① 删掉模板 → 列表少一套；行程里由它引用的清单项仍在、仍可勾选', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl7');
    const tpl = await createTemplate(app, s, {
      familyId: s.familyId,
      name: '家庭出行常用',
      scope: 'SHARED',
      items: [
        { name: '身份证', quantity: 4 },
        { name: '充电宝', quantity: 2 },
      ],
    });

    // 引用到行程
    const applied = mustOk<{ created: number }>(
      await app.dispatch(
        req('POST', '/checklists/templates/apply', {
          token: s.token,
          body: { templateId: tpl.id, tripId: s.tripId, familyId: s.familyId },
        }),
      ),
    );
    expect(applied.created).toBe(2);

    const del = await app.dispatch(
      req('DELETE', `/checklists/templates/${tpl.id}`, { token: s.token }),
    );
    expect(del.httpStatus).toBe(200);
    expect(del.envelope.code).toBe(ErrorCode.OK);

    // 列表里没有了
    const listed = await listTemplates(app, s, { familyId: s.familyId });
    expect(listed.some((t) => t.id === tpl.id)).toBe(false);

    // 行程清单项仍在（不级联删）
    const items = mustOk<
      Array<{ id: string; title: string; version: number; templateId?: string }>
    >(
      await app.dispatch(
        req('GET', '/checklists/items', { token: s.token, query: { tripId: s.tripId } }),
      ),
    );
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).sort()).toEqual(['充电宝', '身份证'].sort());

    // 仍可勾选
    const first = items[0]!;
    const toggled = await app.dispatch(
      req('POST', `/checklists/items/${first.id}/toggle`, {
        token: s.token,
        body: { version: first.version, checked: true },
      }),
    );
    expect(toggled.httpStatus).toBe(200);
  });

  it('② 非本家庭成员删 → 404；③ 删后再删 → 404（不暴露「曾经存在」）', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'tpl8a');
    const outsider = await scaffold(app, 'tpl8c');

    const tpl = await createTemplate(app, a, {
      familyId: a.familyId,
      name: '别人家的清单',
      scope: 'SHARED',
      items: [{ name: '泳镜', quantity: 1 }],
    });

    const denied = await app.dispatch(
      req('DELETE', `/checklists/templates/${tpl.id}`, { token: outsider.token }),
    );
    expect(denied.httpStatus).toBe(404);

    const ok = await app.dispatch(
      req('DELETE', `/checklists/templates/${tpl.id}`, { token: a.token }),
    );
    expect(ok.httpStatus).toBe(200);

    const again = await app.dispatch(
      req('DELETE', `/checklists/templates/${tpl.id}`, { token: a.token }),
    );
    expect(again.httpStatus).toBe(404);
    expect(again.envelope.code).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('P1-2 · GET /checklists/templates 回包 items', () => {
  it('回包同时带解析后的 items 与原始 itemsJson（纯加法）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl9');
    await createTemplate(app, s, {
      familyId: s.familyId,
      name: '带条目',
      scope: 'SHARED',
      items: [{ name: '护照', quantity: 2 }],
    });

    const raw = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(
        req('GET', '/checklists/templates', { token: s.token, query: { familyId: s.familyId } }),
      ),
    );
    const row = raw.items[0]!;
    expect(row['items']).toEqual([{ name: '护照', quantity: 2 }]);
    // 原始列保留，老客户端读 itemsJson 也不受影响
    expect(row).toHaveProperty('itemsJson');
  });

  it('存量脏数据（JSON 字符串 / 双重编码 / null）一律降级为数组，不炸列表', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tpl10');
    const driver = app.driver;

    const now = new Date();
    const seeds: Array<[string, unknown]> = [
      ['501', JSON.stringify([{ name: '身份证', quantity: 4 }])], // 旧代码写入的「字符串」形态
      ['502', JSON.stringify(JSON.stringify([{ name: '双重编码', quantity: 1 }]))],
      ['503', null],
      ['504', 'not-json'],
    ];
    for (const [id, itemsJson] of seeds) {
      await driver.insert('checklistTemplate', {
        id: BigInt(id),
        familyId: BigInt(s.familyId),
        scope: 'SHARED',
        ownerId: null,
        name: `seed-${id}`,
        itemsJson,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });
    }

    const items = await listTemplates(app, s, { familyId: s.familyId });
    const byId = new Map(items.map((t) => [t.id, t]));
    expect(byId.get('501')?.items).toEqual([{ name: '身份证', quantity: 4 }]);
    expect(byId.get('502')?.items).toEqual([{ name: '双重编码', quantity: 1 }]);
    expect(byId.get('503')?.items).toEqual([]);
    expect(byId.get('504')?.items).toEqual([]);
  });

  it('跨家庭不泄漏：别人的家庭共享模板不出现在我的列表里', async () => {
    const app = freshApp();
    const a = await scaffold(app, 'tpl11a');
    const b = await scaffold(app, 'tpl11b');

    await createTemplate(app, a, {
      familyId: a.familyId,
      name: 'A 家的清单',
      scope: 'SHARED',
      items: [{ name: 'A 的物品', quantity: 1 }],
    });

    // B 不带 familyId 查（此前会看到 A 家的共享模板）
    const bList = await listTemplates(app, b);
    expect(bList.some((t) => t.name === 'A 家的清单')).toBe(false);

    // B 显式指定 A 的家庭 id 也不行（请求参数不能扩大可见集合）
    const bForced = await listTemplates(app, b, { familyId: a.familyId });
    expect(bForced.some((t) => t.name === 'A 家的清单')).toBe(false);
  });
});

describe('P2-2 · GET /trips/:id 补 memberCount', () => {
  it('memberCount === members.length（纯加法，不破坏既有字段）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'tripdetail');
    const detail = mustOk<{
      trip: Record<string, unknown>;
      members: unknown[];
      memberCount: number;
      myRole: unknown;
    }>(await app.dispatch(req('GET', `/trips/${s.tripId}`, { token: s.token })));
    expect(detail.memberCount).toBe(detail.members.length);
    expect(detail.memberCount).toBeGreaterThan(0);
    // 既有字段不动
    expect(Array.isArray(detail.members)).toBe(true);
  });
});

describe('P2-1 · 邀请码未命中回 4041', () => {
  it('家庭邀请码写错 → 4041 邀请码无效或已失效（HTTP 仍 404）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'inva');
    const r: DispatchResult = await app.dispatch(
      req('POST', '/families/join', { token: s.token, body: { inviteCode: 'ZZZZZZZZ' } }),
    );
    expect(r.httpStatus).toBe(404);
    expect(r.envelope.code).toBe(ErrorCode.INVITE_CODE_INVALID);
    expect(r.envelope.message).toBe('邀请码无效或已失效');
  });

  it('不存在的行程邀请码 → 4041（与「路径写错」同 HTTP 状态但可区分 code）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'invb');
    const r = await app.dispatch(
      req('POST', '/trips/join', { token: s.token, body: { inviteCode: 'ZZZZZZZZ' } }),
    );
    expect(r.httpStatus).toBe(404);
    expect(r.envelope.code).toBe(ErrorCode.INVITE_CODE_INVALID);
  });
});
