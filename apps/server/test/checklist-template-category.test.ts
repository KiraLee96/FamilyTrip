/**
 * 常备清单 · 条目类型（category）验收（2026-10-27 反馈④第二次）
 * ============================================================================
 * 用户口径：「家庭清单或者个人清单都要根据类型分类，常备物品其实就应该包含
 * 家庭清单和我的清单」。
 *
 * 落到数据层就是两件事：
 *   1. **同一套模型** —— 家庭常备 / 我的常备都是 `checklist_template`，
 *      由 scope 区分，不再有 item 表那第二套；
 *   2. **条目带类型** —— `items_json` 的每个元素多一个 `category`。
 *
 * 🔴 为什么必须有用例：`category` 走的是 Zod → service → JSON 列这条链，
 *    任何一环没放行（比如 schema 忘加字段）都会**静默 strip**：
 *    接口回 200、条目还在，就是类型没了 —— 界面全归到「未分类」，
 *    看起来像"分类功能没做"，而不是"数据丢了"。
 */

import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { mustOk, req, scaffold, type Scaffold } from './helpers.js';

function freshApp(): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    autoFinish: { enabled: false, lazyOnRead: false },
  });
}

interface TemplateItem {
  name: string;
  quantity?: number;
  category?: string;
}

interface TemplateRow {
  id: string;
  version: number;
  items: TemplateItem[];
}

async function create(
  app: BuiltApp,
  s: Scaffold,
  body: { name: string; scope: 'SHARED' | 'PERSONAL'; items: TemplateItem[] },
): Promise<TemplateRow> {
  const r = mustOk<{ template: TemplateRow }>(
    await app.dispatch(
      // 🔴 familyId 必须带：SHARED 模板的归属解析靠它，
      //    缺了会让后续 PATCH 在归属链上判 404（不是路由不存在，是"找不到这条模板"）
      req('POST', '/checklists/templates', {
        token: s.token,
        body: { familyId: s.familyId, ...body },
      }),
    ),
  );
  return r.template;
}

/** 取列表里某套模板（列表已是「共享 + 我的私有」的可见集合） */
async function readBack(app: BuiltApp, s: Scaffold, id: string): Promise<TemplateRow> {
  const r = mustOk<{ items: TemplateRow[] }>(
    await app.dispatch(req('GET', '/checklists/templates', { token: s.token })),
  );
  const hit = r.items.find((t) => t.id === id);
  expect(hit, `模板 ${id} 应出现在列表里`).toBeDefined();
  return hit!;
}

function byName(items: TemplateItem[], name: string): TemplateItem | undefined {
  return items.find((i) => i.name === name);
}

describe('常备清单条目 · 类型（category）', () => {
  it('创建时带的类型能被读回（不被 Zod 静默 strip）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'cat-1');

    const created = await create(app, s, {
      name: '家庭出行常用',
      scope: 'SHARED',
      items: [
        { name: '身份证', quantity: 4, category: '证件' },
        { name: '充电宝', quantity: 2, category: '电子' },
      ],
    });

    expect(byName(created.items, '身份证')?.category).toBe('证件');

    const back = await readBack(app, s, created.id);
    expect(byName(back.items, '身份证')?.category).toBe('证件');
    expect(byName(back.items, '充电宝')?.category).toBe('电子');
  });

  it('不传类型的条目读回不带 category（不落空串）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'cat-2');

    const created = await create(app, s, {
      name: '我的常备',
      scope: 'PERSONAL',
      items: [{ name: '雨伞', quantity: 1 }],
    });

    const back = await readBack(app, s, created.id);
    const umbrella = byName(back.items, '雨伞');
    expect(umbrella).toBeDefined();
    // 🔴 关键：空串会让前端分组出一个「名称为空」的类别
    expect('category' in (umbrella ?? {})).toBe(false);
  });

  it('改模板（items 整体替换）时类型跟着保留', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'cat-3');

    const created = await create(app, s, {
      name: '家庭出行常用',
      scope: 'SHARED',
      items: [{ name: '身份证', quantity: 4, category: '证件' }],
    });

    mustOk(
      await app.dispatch(
        req('PATCH', `/checklists/templates/${created.id}`, {
          token: s.token,
          body: {
            version: created.version,
            items: [
              { name: '身份证', quantity: 4, category: '证件' },
              { name: '防晒霜', quantity: 1, category: '洗护' },
            ],
          },
        }),
      ),
    );

    const back = await readBack(app, s, created.id);
    expect(byName(back.items, '身份证')?.category).toBe('证件');
    expect(byName(back.items, '防晒霜')?.category).toBe('洗护');
  });

  it('家庭常备与我的常备同属一套模型，仅 scope 不同', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'cat-4');

    const shared = await create(app, s, {
      name: '家庭常备',
      scope: 'SHARED',
      items: [{ name: '身份证', quantity: 4, category: '证件' }],
    });
    const personal = await create(app, s, {
      name: '我的常备',
      scope: 'PERSONAL',
      items: [{ name: '处方药', quantity: 1, category: '药品' }],
    });

    const r = mustOk<{ items: Array<TemplateRow & { scope: string }> }>(
      await app.dispatch(req('GET', '/checklists/templates', { token: s.token })),
    );
    const a = r.items.find((t) => t.id === shared.id);
    const b = r.items.find((t) => t.id === personal.id);

    expect(a?.scope).toBe('SHARED');
    expect(b?.scope).toBe('PERSONAL');
    // 两者条目结构完全一致，只有可见范围不同 —— 这就是「常备物品包含两半」
    expect(byName(a?.items ?? [], '身份证')?.category).toBe('证件');
    expect(byName(b?.items ?? [], '处方药')?.category).toBe('药品');
  });
});
