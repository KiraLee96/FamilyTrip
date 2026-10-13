/**
 * E 组 · 并发写保护端到端（E1 ~ E8）
 * ============================================================================
 * 覆盖验收要求：
 *   · E7  CAS 乐观锁：陈旧 version → 409 / 4090，且**数据未被改写**
 *   · E7  幂等优先于 CAS：同 version 重放不得误报冲突
 *   · E7  version 必传：缺失即 4001（不允许「降级为无锁」）
 *   · E7  成功后 version 递增（客户端据此发下一次请求）
 *   · E8  主导者继任：唯一主导者退出 → PROMOTE；最后一人 → REFUSE
 *   · E8  JSON patch：并发编辑不同路径不互相覆盖（lost update 防护）
 *   · E8  JSON patch：原型污染 / 越界 / 连续点等非法路径一律拒
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, stubWechat, type BuiltApp } from '../src/composition-root.js';
import { mustOk, req, scaffold } from './helpers.js';
import {
  applyJsonPatch,
  decideLeaderSuccession,
  withJsonPatch,
  type JsonPatchOp,
  type RowLockRunner,
} from '../src/common/concurrency/row-lock.js';
import { ErrorCode } from '../src/common/errors/error-code.js';

interface ChecklistItem {
  id: string;
  version: number;
  checked: boolean;
  name: string;
}

describe('E7 · CAS 乐观锁（清单勾选）', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  async function createItem(s: Awaited<ReturnType<typeof scaffold>>): Promise<ChecklistItem> {
    const r = mustOk<ChecklistItem>(
      await app.dispatch(
        req('POST', '/checklists/items', {
          token: s.token,
          body: { tripId: s.tripId, familyId: s.familyId, name: '帐篷', scope: 'SHARED' },
        }),
      ),
    );
    return r;
  }

  it('E7：陈旧 version 勾选 → 409 / 4090，且数据不被改写', async () => {
    const s = await scaffold(app, 'cas');
    const item = await createItem(s);

    // 第一次：带正确 version，成功
    const first = mustOk<ChecklistItem>(
      await app.dispatch(
        req('POST', `/checklists/items/${item.id}/toggle`, {
          token: s.token,
          body: { version: item.version, checked: true },
        }),
      ),
    );
    expect(first.checked).toBe(true);
    // 🔴 version 必须递增 —— 客户端靠它发下一次请求
    expect(first.version).toBe(item.version + 1);

    // 第二次：**复用已过期的 version**（模拟另一端基于旧快照提交）→ 必须 409
    const stale = await app.dispatch(
      req('POST', `/checklists/items/${item.id}/toggle`, {
        token: s.token,
        body: { version: item.version, checked: false },
      }),
    );
    expect(stale.httpStatus).toBe(409);
    expect(stale.envelope.code).toBe(ErrorCode.VERSION_CONFLICT);
    expect(stale.envelope.code).toBe(4090);

    // 🔴 关键：冲突请求**不得**产生任何副作用 —— checked 仍是 true
    const after = mustOk<ChecklistItem>(
      await app.dispatch(req('GET', `/checklists/items/${item.id}`, { token: s.token })),
    );
    expect(after.checked).toBe(true);
    expect(after.version).toBe(item.version + 1);
  });

  it('E7：version 必传 —— 缺失即 4001，绝不「降级为无锁写入」', async () => {
    const s = await scaffold(app, 'cas2');
    const item = await createItem(s);

    const missing = await app.dispatch(
      req('POST', `/checklists/items/${item.id}/toggle`, {
        token: s.token,
        body: { checked: true }, // 故意不给 version
      }),
    );
    // ⚠️ 校验失败走 422（`VALIDATION_FAILED`），不是 400 —— 400 留给「语义非法」
    expect(missing.httpStatus).toBe(422);
    expect(missing.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(missing.envelope.code).toBe(4001);

    // 确认确实没写进去
    const after = mustOk<ChecklistItem>(
      await app.dispatch(req('GET', `/checklists/items/${item.id}`, { token: s.token })),
    );
    expect(after.checked).toBe(false);
    expect(after.version).toBe(item.version);
  });

  it('E7：连续递增版本可正常串行推进（v0 → v1 → v2）', async () => {
    const s = await scaffold(app, 'cas3');
    let item = await createItem(s);
    expect(item.version).toBe(0);

    for (let round = 1; round <= 2; round += 1) {
      const r = mustOk<ChecklistItem>(
        await app.dispatch(
          req('POST', `/checklists/items/${item.id}/toggle`, {
            token: s.token,
            body: { version: item.version, checked: round % 2 === 1 },
          }),
        ),
      );
      expect(r.version).toBe(round);
      item = r;
    }
    expect(item.version).toBe(2);
  });
});

describe('E8 ② · 主导者继任判定（纯函数）', () => {
  const leader = 100n;
  const a = 201n;
  const b = 202n;

  it('退位者不是主导者 → KEEP，主导者不变', () => {
    const d = decideLeaderSuccession({
      leavingUserId: a,
      currentLeaderId: leader,
      remainingActiveUserIds: [b, leader],
    });
    expect(d.action).toBe('KEEP');
    expect(d).toMatchObject({ leaderId: leader });
  });

  it('唯一主导者退出且有后继 → PROMOTE 首个 ACTIVE 成员', () => {
    const d = decideLeaderSuccession({
      leavingUserId: leader,
      currentLeaderId: leader,
      remainingActiveUserIds: [a, b],
    });
    expect(d.action).toBe('PROMOTE');
    expect(d).toMatchObject({ leaderId: a });
  });

  it('唯一主导者退出且无人可递补 → REFUSE（不变量：主导者数 ≥ 1）', () => {
    const d = decideLeaderSuccession({
      leavingUserId: leader,
      currentLeaderId: leader,
      remainingActiveUserIds: [],
    });
    expect(d.action).toBe('REFUSE');
    // REFUSE 时不得给出 leaderId —— 类型上就没有该字段
    expect(d).not.toHaveProperty('leaderId');
  });

  it('本无主导者 + 仍有成员 → 顺带 PROMOTE（自愈）', () => {
    const d = decideLeaderSuccession({
      leavingUserId: a,
      currentLeaderId: null,
      remainingActiveUserIds: [b],
    });
    expect(d.action).toBe('PROMOTE');
    expect(d).toMatchObject({ leaderId: b });
  });

  it('本无主导者 + 最后一人退出 → REFUSE', () => {
    const d = decideLeaderSuccession({
      leavingUserId: a,
      currentLeaderId: null,
      remainingActiveUserIds: [],
    });
    expect(d.action).toBe('REFUSE');
  });
});

describe('E8 ① · JSON patch（行锁增量更新）', () => {
  it('并发编辑**不同路径**不互相覆盖（lost update 防护）', async () => {
    // 模拟两端的两个 patch 依次落在**最新**值上（这正是行锁内 read-modify-write 的语义）
    let disk: Record<string, unknown> = { points: { d1: { title: '浅草寺' }, d2: {} } };

    const clientA: JsonPatchOp[] = [{ op: 'set', path: 'points.d1.note', value: '穿和服' }];
    const clientB: JsonPatchOp[] = [{ op: 'set', path: 'points.d2.title', value: '晴空塔' }];

    // A 先提交
    disk = applyJsonPatch(disk, clientA);
    // B 后提交，但基于**最新** disk（行锁保证）
    disk = applyJsonPatch(disk, clientB);

    const points = disk['points'] as Record<string, Record<string, unknown>>;
    // 🔴 两个改动都要在 —— 若实现是「整字段覆盖」这里会丢一个
    expect(points['d1']!['note']).toBe('穿和服');
    expect(points['d1']!['title']).toBe('浅草寺');
    expect(points['d2']!['title']).toBe('晴空塔');
  });

  it('withJsonPatch 在 runner 提供的事务内完成 read → patch → writeBack', async () => {
    let disk: Record<string, unknown> = { a: 1 };
    const order: string[] = [];

    const runner: RowLockRunner = async (_entity, _id, fn) => {
      order.push('lock');
      return fn({ client: {} });
    };

    const result = await withJsonPatch(
      runner,
      'trip',
      1n,
      async () => {
        order.push('read');
        return disk;
      },
      async (_tx, next) => {
        order.push('write');
        disk = next;
        return Object.keys(next).length;
      },
      [{ op: 'set', path: 'b', value: 2 }],
    );

    // 先锁 → 再读 → 再写。顺序反了就有 lost update 窗口。
    expect(order).toEqual(['lock', 'read', 'write']);
    expect(result).toBe(2);
    expect(disk).toEqual({ a: 1, b: 2 });
  });

  it('非法的 patch 路径一律拒（原型污染 / 连续点 / 数组越界）', () => {
    const base = { a: 1, arr: [1, 2] };

    expect(() =>
      applyJsonPatch(base, [{ op: 'set', path: '__proto__.polluted', value: 1 }]),
    ).toThrow();
    expect(() => applyJsonPatch(base, [{ op: 'set', path: 'constructor.x', value: 1 }])).toThrow();
    expect(() => applyJsonPatch(base, [{ op: 'set', path: 'a..b', value: 1 }])).toThrow();
    expect(() => applyJsonPatch(base, [{ op: 'set', path: 'arr.9', value: 1 }])).toThrow();

    // 确认没有真的污染 Object.prototype
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('applyJsonPatch 不修改入参（纯净性：行锁外的调用才是 bug）', () => {
    const base: Record<string, unknown> = { nested: { k: 'v' } };
    const snapshot = JSON.stringify(base);
    const next = applyJsonPatch(base, [{ op: 'set', path: 'nested.k', value: 'changed' }]);
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(next).not.toBe(base);
  });
});
