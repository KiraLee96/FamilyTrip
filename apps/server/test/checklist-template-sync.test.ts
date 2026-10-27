/**
 * 模板条目变更 → 同步到「未成行行程」验收（2026-10-27）
 * ============================================================================
 * 用户口径原话：
 *   「清单中已经修改了，引用过的行程 未成行的要同步改，已完成的就不用改了」
 *
 * 覆盖五条规则：
 *   S1 未成行行程：模板加条目 → 行程里补上（synced.created / trips 正确）
 *   S2 已完成行程：模板加条目 → **行程不动**（历史快照）
 *   S3 模板删条目 → 行程里未勾选的同步删掉
 *   S4 模板删条目但行程里已勾选 → **保留**（已打包，不能凭空消失）
 *   S5 只改名字 → 不产生 synced，行程清单项不变
 *
 * 🔴 关掉 autoFinish：本文件要精确控制「未成行 / 已完成」两种状态，
 *    惰性流转会在读 trip 时把过期行程自动归档，破坏 S1 的前提。
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { dumpTable, mustOk, req, scaffold, type Scaffold } from './helpers.js';

/** 未来日期：保证「未成行」，不会被自动完结 */
const FUTURE = { startDate: '2027-06-01', endDate: '2027-06-03' };

function freshApp(): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    autoFinish: { enabled: false, lazyOnRead: false },
  });
}

interface SyncResult {
  trips: number;
  created: number;
  updated: number;
  removed: number;
  keptChecked: number;
}

/** 建一套长期清单模板，返回 id 与 version */
async function createTemplate(
  app: BuiltApp,
  s: Scaffold,
  name: string,
  items: Array<{ name: string; quantity?: number }>,
): Promise<{ id: string; version: number }> {
  const r = mustOk<{ template: { id: string; version: number } }>(
    await app.dispatch(
      req('POST', '/checklists/templates', {
        token: s.token,
        body: {
          familyId: s.familyId,
          name,
          scope: 'SHARED',
          items: items.map((it) => ({ name: it.name, quantity: it.quantity ?? 1 })),
        },
      }),
    ),
  );
  return r.template;
}

/** 把模板引用到行程 */
async function applyTo(
  app: BuiltApp,
  s: Scaffold,
  templateId: string,
  tripId: string,
): Promise<void> {
  mustOk(
    await app.dispatch(
      req('POST', '/checklists/templates/apply', {
        token: s.token,
        body: { templateId, tripId, familyId: s.familyId },
      }),
    ),
  );
}

/** 改模板条目，返回 synced（只改名字时可能为 undefined） */
async function patchItems(
  app: BuiltApp,
  s: Scaffold,
  templateId: string,
  version: number,
  items: Array<{ name: string; quantity?: number }>,
): Promise<{ synced?: SyncResult; version: number }> {
  const r = mustOk<{ template: { version: number }; synced?: SyncResult }>(
    await app.dispatch(
      req('PATCH', `/checklists/templates/${templateId}`, {
        token: s.token,
        body: {
          version,
          items: items.map((it) => ({ name: it.name, quantity: it.quantity ?? 1 })),
        },
      }),
    ),
  );
  return {
    ...(r.synced !== undefined ? { synced: r.synced } : {}),
    version: r.template.version,
  };
}

/** 行程清单项的当前快照（未软删） */
function tripItems(app: BuiltApp, tripId: string): Array<Record<string, unknown>> {
  return dumpTable(app, 'tripChecklistItem').filter(
    (r) => String(r['tripId']) === tripId && r['deletedAt'] === null,
  );
}

/** 把行程标记为已完成（拿当前 version 再 finish） */
async function finishTrip(app: BuiltApp, s: Scaffold, tripId: string): Promise<void> {
  const d = mustOk<{ trip: { version: number } }>(
    await app.dispatch(req('GET', `/trips/${tripId}`, { token: s.token })),
  );
  mustOk(
    await app.dispatch(
      req('POST', `/trips/${tripId}/finish`, {
        token: s.token,
        body: { version: d.trip.version },
      }),
    ),
  );
}

describe('S1 · 未成行行程跟随模板新增', () => {
  it('模板加一条 → 行程里补一条未勾选项，synced 反映影响面', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sync-s1', FUTURE);
    const tpl = await createTemplate(app, s, '出行必带', [{ name: '身份证' }, { name: '充电宝' }]);

    await applyTo(app, s, tpl.id, s.tripId);
    expect(tripItems(app, s.tripId)).toHaveLength(2);

    const patched = await patchItems(app, s, tpl.id, tpl.version, [
      { name: '身份证' },
      { name: '充电宝' },
      { name: '雨伞' },
    ]);

    const names = tripItems(app, s.tripId).map((r) => String(r['name']));
    expect(names).toContain('雨伞');
    expect(names).toHaveLength(3);
    expect(patched.synced).toEqual({
      trips: 1,
      created: 1,
      updated: 0,
      removed: 0,
      keptChecked: 0,
    });
  });
});

describe('S2 · 已完成行程不回溯', () => {
  it('行程先完成、再改模板 → 行程清单项保持不变', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sync-s2', FUTURE);
    const tpl = await createTemplate(app, s, '出行必带', [{ name: '身份证' }]);

    await applyTo(app, s, tpl.id, s.tripId);
    await finishTrip(app, s, s.tripId);
    expect(tripItems(app, s.tripId)).toHaveLength(1);

    const patched = await patchItems(app, s, tpl.id, tpl.version, [
      { name: '身份证' },
      { name: '雨伞' },
    ]);

    // 行程没被改：仍是 1 项，且没有雨伞
    const items = tripItems(app, s.tripId);
    expect(items).toHaveLength(1);
    expect(items.map((r) => String(r['name']))).not.toContain('雨伞');
    // 没有可同步的行程，影响面全 0
    expect(patched.synced).toEqual({
      trips: 0,
      created: 0,
      updated: 0,
      removed: 0,
      keptChecked: 0,
    });
  });
});

describe('S3 · 模板删条目 → 未勾选的同步删掉', () => {
  it('删掉的条目在行程里消失（软删）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sync-s3', FUTURE);
    const tpl = await createTemplate(app, s, '出行必带', [{ name: '身份证' }, { name: '雨伞' }]);

    await applyTo(app, s, tpl.id, s.tripId);
    expect(tripItems(app, s.tripId)).toHaveLength(2);

    const patched = await patchItems(app, s, tpl.id, tpl.version, [{ name: '身份证' }]);

    expect(tripItems(app, s.tripId).map((r) => String(r['name']))).toEqual(['身份证']);
    expect(patched.synced?.removed).toBe(1);
    expect(patched.synced?.keptChecked).toBe(0);

    // 软删而非物理删：留痕可追溯
    const all = dumpTable(app, 'tripChecklistItem').filter((r) => String(r['tripId']) === s.tripId);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r['deletedAt'] !== null)).toHaveLength(1);
  });
});

describe('S4 · 已勾选的条目删不掉', () => {
  it('模板删了它，但行程里勾过 → 保留并计入 keptChecked', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sync-s4', FUTURE);
    const tpl = await createTemplate(app, s, '出行必带', [{ name: '身份证' }, { name: '雨伞' }]);

    await applyTo(app, s, tpl.id, s.tripId);

    // 勾上「雨伞」（toggle 需要 version，取当前行）
    const umbrella = tripItems(app, s.tripId).find((r) => String(r['name']) === '雨伞');
    expect(umbrella).toBeDefined();
    mustOk(
      await app.dispatch(
        req('POST', `/checklists/items/${String(umbrella!['id'])}/toggle`, {
          token: s.token,
          body: { version: Number(umbrella!['version']), checked: true },
        }),
      ),
    );

    const patched = await patchItems(app, s, tpl.id, tpl.version, [{ name: '身份证' }]);

    const names = tripItems(app, s.tripId).map((r) => String(r['name']));
    expect(names).toContain('雨伞'); // 保留
    expect(names).toHaveLength(2);
    expect(patched.synced?.keptChecked).toBe(1);
    expect(patched.synced?.removed).toBe(0);
  });
});

describe('S5 · 只改名字不动行程', () => {
  it('PATCH 只带 name → 没有 synced，行程清单项一条不少', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'sync-s5', FUTURE);
    const tpl = await createTemplate(app, s, '出行必带', [{ name: '身份证' }]);
    await applyTo(app, s, tpl.id, s.tripId);

    const r = mustOk<{ synced?: SyncResult }>(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${tpl.id}`, {
          token: s.token,
          body: { version: tpl.version, name: '出门必带（新版）' },
        }),
      ),
    );

    expect(r.synced).toBeUndefined();
    expect(tripItems(app, s.tripId)).toHaveLength(1);
  });
});
