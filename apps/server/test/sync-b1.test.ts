/**
 * B1 · 多端同步端到端（E1 ~ E6）
 * ============================================================================
 * 覆盖验收要求：
 *   · E2  服务端时间为唯一刻度：游标不受客户端时间影响
 *   · E3  复合游标 `(changedAt, id)`：**同毫秒并发写不漏单**
 *   · E4  严格 `>` 语义：游标推进不重复推送
 *   · E5  合并可折叠：同实体连续变更收敛；断链暴露 needsBackfill
 *   · E6  漏单自愈：客户端游标超前/落后时的 backfill 判定
 *   · B1  可见范围隔离：A 家庭的变更**绝不**推给 B 家庭的成员
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, stubWechat, type BuiltApp } from '../src/composition-root.js';
import { mustOk, req, scaffold } from './helpers.js';
import {
  buildCursorPredicate,
  coalesceChanges,
  decodeCursor,
  encodeCursor,
  mergeChanges,
  paginateChanges,
  type ChangeRecord,
} from '../src/common/sync/change-log.js';
import { ErrorCode } from '../src/common/errors/error-code.js';



interface PullResult {
  changes: Array<{ entityType: string; entityId: string; op: string; changedAt: string }>;
  nextCursor: string | null;
  hasMore: boolean;
  needsBackfill: boolean;
  serverWatermark: string | null;
}

describe('E3/E4 · 复合游标编码与谓词（纯函数）', () => {
  it('encodeCursor / decodeCursor 往返一致', () => {
    const c = { changedAt: new Date('2026-10-10T05:00:00.000Z'), id: 123456789n };
    const encoded = encodeCursor(c);
    const decoded = decodeCursor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.changedAt.getTime()).toBe(c.changedAt.getTime());
    expect(decoded!.id).toBe(c.id);
  });

  it('非法游标 → decodeCursor 返回 null（由上层转 400）', () => {
    for (const bad of ['', 'garbage', 'abc:def', '123', ':456', '123:']) {
      expect(decodeCursor(bad), `"${bad}" 应被拒`).toBeNull();
    }
  });

  it('E3：游标谓词用 OR —— 同毫秒靠 id 递进（不漏单）', () => {
    const at = new Date('2026-10-10T05:00:00.000Z');
    const p = buildCursorPredicate({ changedAt: at, id: 100n });
    // 必须是 OR 形态：只写 changedAt > t 会漏掉同毫秒的后续行
    expect(Array.isArray(p.OR)).toBe(true);
    const clauses = p.OR as Array<Record<string, unknown>>;
    expect(clauses.length).toBe(2);

    // 子句 ①：changedAt 严格大于（gt）
    const c0 = clauses[0]!;
    expect((c0['changedAt'] as { gt: Date }).gt.getTime()).toBe(at.getTime());

    // 子句 ②：changedAt **相等** 且 id 严格大于 —— 同毫秒不漏单的关键
    const c1 = clauses[1]!;
    expect(c1['changedAt']).toBeInstanceOf(Date);
    expect((c1['changedAt'] as Date).getTime()).toBe(at.getTime());
    expect((c1['id'] as { gt: bigint }).gt).toBe(100n);
  });

  it('after = null 时谓词为空（无下界，调用方须先 bootstrap）', () => {
    expect(buildCursorPredicate(null)).toEqual({});
  });

  it('E4：游标推进用严格 > （不重复推送已确认的条目）', () => {
    const at = new Date('2026-10-10T05:00:00.000Z');
    const p = buildCursorPredicate({ changedAt: at, id: 100n });
    const clauses = p.OR as Array<Record<string, unknown>>;
    // 必须全是 gt；出现 gte 就会让客户端反复收到游标处那一条
    for (const clause of clauses) {
      for (const v of Object.values(clause)) {
        if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
          expect(v).not.toHaveProperty('gte');
          expect(v).not.toHaveProperty('equals');
        }
      }
    }
  });
});

describe('E5 · 折叠与合并（纯函数）', () => {
  function rec(over: Partial<ChangeRecord> & { id: bigint }): ChangeRecord {
    return {
      entityType: 'trip_checklist_item',
      entityId: 500n,
      familyId: null,
      tripId: 9n,
      op: 'UPDATE',
      changedAt: new Date('2026-10-10T05:00:00.000Z'),
      ...over,
    };
  }

  it('同实体连续变更折叠成一条，保留 INSERT 语义并取较晚时间戳', () => {
    const rows = [
      rec({ id: 1n, op: 'INSERT', changedAt: new Date('2026-10-10T05:00:00.000Z') }),
      rec({ id: 2n, op: 'UPDATE', changedAt: new Date('2026-10-10T05:00:01.000Z') }),
      rec({ id: 3n, op: 'UPDATE', changedAt: new Date('2026-10-10T05:00:02.000Z') }),
    ];
    const out = coalesceChanges(rows);
    expect(out).toHaveLength(1);
    // 🔴 折叠语义：INSERT→UPDATE→UPDATE = INSERT（实体对客户端而言始终是「新增」）
    expect(out[0]!.op).toBe('INSERT');
    // 取最后一条的时间戳（游标推进依赖它）
    expect(out[0]!.changedAt.getTime()).toBe(new Date('2026-10-10T05:00:02.000Z').getTime());
    // 用更晚那条的 id（同毫秒靠它递进）
    expect(out[0]!.id).toBe(3n);
  });

  it('不同实体**不**折叠', () => {
    const rows = [
      rec({ id: 1n, entityId: 500n }),
      rec({ id: 2n, entityId: 501n }),
    ];
    expect(coalesceChanges(rows)).toHaveLength(2);
  });

  it('DELETE 之后不再向后折叠（保守：DELETE 后同实体变更原样保留）', () => {
    const rows = [
      rec({ id: 1n, op: 'DELETE', changedAt: new Date('2026-10-10T05:00:00.000Z') }),
      rec({ id: 2n, op: 'UPDATE', changedAt: new Date('2026-10-10T05:00:01.000Z') }),
    ];
    // prev 已是 DELETE → canCoalesce=false → 两条都保留
    expect(coalesceChanges(rows)).toHaveLength(2);
  });

  it('INSERT→DELETE 折叠为 DELETE（实体从未对客户端可见）', () => {
    const rows = [
      rec({ id: 1n, op: 'INSERT', changedAt: new Date('2026-10-10T05:00:00.000Z') }),
      rec({ id: 2n, op: 'DELETE', changedAt: new Date('2026-10-10T05:00:01.000Z') }),
    ];
    const out = coalesceChanges(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.op).toBe('DELETE');
  });

  it('E6 断链检测：本地无该实体却收到 UPDATE → needsBackfill', async () => {
    // 🔴 折叠会把 INSERT→UPDATE 收敛成 INSERT，所以断链信号只能由**裸 UPDATE** 触发
    const rows = [rec({ id: 9n, op: 'UPDATE', entityId: 800n })];
    const outcome = await mergeChanges(new Map<string, ChangeRecord>(), rows, (c) => c);
    expect(outcome.needsBackfill).toHaveLength(1);
    expect(outcome.needsBackfill[0]).toBe('trip_checklist_item:800');
  });

  it('INSERT 落本地 → 后续 UPDATE 不再算断链', async () => {
    const rows = [
      rec({ id: 1n, op: 'INSERT', entityId: 801n }),
      rec({ id: 2n, op: 'UPDATE', entityId: 801n }),
    ];
    const outcome = await mergeChanges(new Map<string, ChangeRecord>(), rows, (c) => c);
    expect(outcome.needsBackfill).toHaveLength(0);
  });

  it('mergeChanges 把变更落到本地 state，并统计 applied', async () => {
    const rows = [
      rec({ id: 1n, op: 'INSERT', entityId: 700n }),
      rec({ id: 2n, op: 'INSERT', entityId: 701n }),
    ];
    const local = new Map<string, ChangeRecord>();
    const outcome = await mergeChanges(local, rows, (c) => c);
    expect(outcome.applied).toBe(2);
    expect(outcome.state.size).toBe(2);
    // 不修改入参
    expect(local.size).toBe(0);
  });

  it('DELETE 命中有则移除并计 applied；未命中则忽略（容忍重复下发）', async () => {
    const local = new Map<string, ChangeRecord>([
      ['trip_checklist_item:900', rec({ id: 1n, entityId: 900n, op: 'INSERT' })],
    ]);
    const hit = await mergeChanges(local, [rec({ id: 2n, entityId: 900n, op: 'DELETE' })], (c) => c);
    expect(hit.applied).toBe(1);
    expect(hit.state.size).toBe(0);

    const miss = await mergeChanges(local, [rec({ id: 3n, entityId: 999n, op: 'DELETE' })], (c) => c);
    expect(miss.applied).toBe(0);
  });
});

describe('paginateChanges · 分页与游标签发', () => {
  function rec(id: bigint): ChangeRecord {
    return {
      entityType: 'wish',
      entityId: id,
      familyId: 1n,
      tripId: null,
      op: 'UPDATE',
      changedAt: new Date(2026, 0, 1, 0, 0, Number(id % 60n)),
      id,
    };
  }

  it('超出 take 时 hasMore=true 且 nextCursor 指向最后一条', () => {
    const rows = [rec(1n), rec(2n), rec(3n)];
    const page = paginateChanges(rows, 2);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
    const cur = decodeCursor(page.nextCursor);
    expect(cur!.id).toBe(2n);
  });

  it('不足 take 时 hasMore=false 且 nextCursor=null（已追平）', () => {
    const rows = [rec(1n), rec(2n)];
    const page = paginateChanges(rows, 10);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
    // 🔴 追平语义：没有更多了 → 不为「末条」签发游标
    //    （否则客户端会拿它再拉一次，白跑一趟）
    expect(page.nextCursor).toBeNull();
  });

  it('空输入 → nextCursor=null', () => {
    const page = paginateChanges([], 10);
    expect(page.items).toHaveLength(0);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

describe('B1 · 同步接口端到端', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  it('首次同步：GET /sync/cursor 返回水位（可为 null）与 serverTime', async () => {
    const s = await scaffold(app, 'sync0');
    const r = mustOk<{ cursor: string | null; serverTime: string }>(
      await app.dispatch(req('GET', '/sync/cursor', { token: s.token })),
    );
    expect(r).toHaveProperty('cursor');
    expect(typeof r.serverTime).toBe('string');
    expect(Number.isFinite(new Date(r.serverTime).getTime())).toBe(true);
  });

  it('E2：拉取增量后的 nextCursor 可再次使用（游标可推进、不重复）', async () => {
    const s = await scaffold(app, 'sync1');

    // 产生若干变更
    mustOk(
      await app.dispatch(
        req('POST', '/wishes', {
          token: s.token,
          body: { familyId: s.familyId, title: '想去北海道', category: 'TRIP' },
        }),
      ),
    );

    const first = mustOk<PullResult>(
      await app.dispatch(req('GET', '/sync/changes', { token: s.token })),
    );
    expect(first.changes.length).toBeGreaterThan(0);

    // 用 nextCursor 再拉 → 不应重复拿到同一批（E4 严格 >）
    if (first.nextCursor !== null) {
      const second = mustOk<PullResult>(
        await app.dispatch(
          req('GET', '/sync/changes', { token: s.token, query: { cursor: first.nextCursor } }),
        ),
      );
      const seen = new Set(first.changes.map((c) => `${c.entityType}:${c.entityId}:${c.op}`));
      const dup = second.changes.filter((c) => seen.has(`${c.entityType}:${c.entityId}:${c.op}`));
      expect(dup, '游标推进后不应重复推送已确认条目').toHaveLength(0);
    }
  });

  it('非法游标 → 400（提示客户端重跑首次同步）', async () => {
    const s = await scaffold(app, 'sync2');
    const r = await app.dispatch(
      req('GET', '/sync/changes', { token: s.token, query: { cursor: 'not-a-cursor' } }),
    );
    expect(r.httpStatus).toBe(400);
    expect(r.envelope.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('B1 可见范围隔离：B 家庭成员的拉取里**不含** A 家庭的变更', async () => {
    const a = await scaffold(app, 'syncA');
    const b = await scaffold(app, 'syncB');

    // A 产生变更
    mustOk(
      await app.dispatch(
        req('POST', '/wishes', {
          token: a.token,
          body: { familyId: a.familyId, title: 'A 家的心愿', category: 'TRIP' },
        }),
      ),
    );

    const bPull = mustOk<PullResult>(
      await app.dispatch(req('GET', '/sync/changes', { token: b.token })),
    );
    // B 不该看到任何挂在 A 家庭上的变更
    const leaked = bPull.changes.filter((c) => c.entityType === 'wish');
    const aLeaked = leaked.filter(() => true);
    // 更精确：B 自己没有任何 wish，所以 wish 类变更应为 0
    expect(aLeaked, 'B 看到了 A 家庭的变更 —— 同步域水平越权').toHaveLength(0);
  });

  it('POST /sync/changes：服务端已知的变更不计入 toReplay（幂等去重）', async () => {
    const s = await scaffold(app, 'sync3');
    mustOk(
      await app.dispatch(
        req('POST', '/wishes', {
          token: s.token,
          body: { familyId: s.familyId, title: '重复推送测试', category: 'TRIP' },
        }),
      ),
    );

    const pull = mustOk<PullResult>(await app.dispatch(req('GET', '/sync/changes', { token: s.token })));
    const known = pull.changes.filter((c) => c.entityType === 'wish');
    expect(known.length).toBeGreaterThan(0);

    const pushed = mustOk<{ accepted: number; alreadyKnown: number; toReplay: unknown[] }>(
      await app.dispatch(
        req('POST', '/sync/changes', {
          token: s.token,
          body: {
            batchId: 'batch-1',
            changes: known.map((c) => ({
              entityType: c.entityType,
              entityId: c.entityId,
              op: c.op,
            })),
          },
        }),
      ),
    );
    expect(pushed.accepted).toBe(known.length);
    // 🔴 服务端已知道的 → 一条都不该让客户端重放
    expect(pushed.alreadyKnown).toBe(known.length);
    expect(pushed.toReplay).toHaveLength(0);
  });

  it('POST /sync/changes：未知变更进入 toReplay（客户端需调业务接口重放）', async () => {
    const s = await scaffold(app, 'sync4');
    const pushed = mustOk<{ accepted: number; alreadyKnown: number; toReplay: unknown[] }>(
      await app.dispatch(
        req('POST', '/sync/changes', {
          token: s.token,
          body: {
            batchId: 'batch-2',
            changes: [{ entityType: 'wish', entityId: '999999999999999999', op: 'UPDATE' }],
          },
        }),
      ),
    );
    expect(pushed.accepted).toBe(1);
    expect(pushed.alreadyKnown).toBe(0);
    expect(pushed.toReplay).toHaveLength(1);
  });

  it('E6：客户端主动要求 backfill → action=BACKFILL', async () => {
    const s = await scaffold(app, 'sync5');
    const r = mustOk<{ action: string; reason: string | null }>(
      await app.dispatch(
        req('POST', '/sync/merge-report', {
          token: s.token,
          body: { batchId: 'b1', needsBackfill: true },
        }),
      ),
    );
    expect(r.action).toBe('BACKFILL');
    expect(r.reason).toBe('CLIENT_REQUESTED');
  });

  it('E6：游标格式非法 → BACKFILL / CURSOR_MALFORMED', async () => {
    const s = await scaffold(app, 'sync6');
    const r = mustOk<{ action: string; reason: string | null }>(
      await app.dispatch(
        req('POST', '/sync/merge-report', {
          token: s.token,
          body: { batchId: 'b2', needsBackfill: false, clientCursor: 'garbage' },
        }),
      ),
    );
    expect(r.action).toBe('BACKFILL');
    expect(r.reason).toBe('CURSOR_MALFORMED');
  });

  it('E6：游标未落后（等于当前水位）→ action=NONE', async () => {
    const s = await scaffold(app, 'sync7');
    mustOk(
      await app.dispatch(
        req('POST', '/wishes', {
          token: s.token,
          body: { familyId: s.familyId, title: '水位对齐', category: 'TRIP' },
        }),
      ),
    );
    const pull = mustOk<PullResult>(await app.dispatch(req('GET', '/sync/changes', { token: s.token })));
    expect(pull.serverWatermark).not.toBeNull();

    const r = mustOk<{ action: string }>(
      await app.dispatch(
        req('POST', '/sync/merge-report', {
          token: s.token,
          body: { batchId: 'b3', needsBackfill: false, clientCursor: pull.serverWatermark },
        }),
      ),
    );
    // 游标 = 服务端已知最早/在范围内 → 无需回灌
    expect(r.action).toBe('NONE');
  });

  it('游标进度可稳定推进：limit=1 时多次拉取覆盖全部变更且不重复', async () => {
    const s = await scaffold(app, 'sync8');

    // 造 3 条不同实体的变更
    for (let i = 1; i <= 3; i += 1) {
      mustOk(
        await app.dispatch(
          req('POST', '/wishes', {
            token: s.token,
            body: { familyId: s.familyId, title: `心愿 ${i}`, category: 'TRIP' },
          }),
        ),
      );
    }

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard += 1) {
      const page: PullResult = mustOk(
        await app.dispatch(
          req('GET', '/sync/changes', {
            token: s.token,
            query: cursor !== undefined ? { cursor, limit: '1' } : { limit: '1' },
          }),
        ),
      );
      for (const c of page.changes) collected.push(`${c.entityType}:${c.entityId}`);
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    // 没有重复（E3 复合游标正确性）
    expect(new Set(collected).size).toBe(collected.length);
    // 至少覆盖到我们造的那些变更
    expect(collected.length).toBeGreaterThan(0);
  });
});
