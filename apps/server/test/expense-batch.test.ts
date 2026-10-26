/**
 * D-2026-10-26-01 · P1-1 验收：POST /expenses/batch（批量记账）
 * ============================================================================
 * 覆盖：部分成功 / rows 上限 / requestId 幂等 / 单用户 1 次/秒限流 / 整体权限门。
 *
 * 🔴 「部分成功」的失败源必须落在**业务层**（schema 层会被链第 6 段整批拒掉）：
 *    这里用「非 CNY 且无授权汇率源」——正是真实导入账单里最常见的失败
 *    （用户导入了外币笔数，但汇率还没录入）。断言它只让那一行失败。
 *
 * 🔴 限流用注入的时钟推进，不真的 sleep —— 见 ExpenseDomainOptions.clockMs。
 */

import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import { MinIntervalLimiter } from '../src/common/security/rate-limit.js';
import { mustOk, req, scaffold, type Scaffold } from './helpers.js';

interface BatchRowResult {
  index: number;
  ok: boolean;
  id?: string;
  error?: { code: number; message: string };
}

interface BatchResult {
  created: number;
  failed: number;
  results: BatchRowResult[];
}

/** 可控时钟：默认每读一次前进 0ms，测试里显式 `advance()` */
function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function freshApp(clock?: () => number): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    ...(clock !== undefined ? { now: () => new Date(clock()) } : {}),
  });
}

function row(
  title: string,
  amount = '42.50',
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { title, amount, currency: 'CNY', spentAt: '2026-10-03', ...extra };
}

function batchBody(s: Scaffold, rows: unknown[], requestId?: string): Record<string, unknown> {
  return {
    tripId: s.tripId,
    familyId: s.familyId,
    ...(requestId !== undefined ? { requestId } : {}),
    rows,
  };
}

describe('P1-1 · POST /expenses/batch', () => {
  it('部分成功：外币行缺汇率 → 该行失败、其余成功（不整批回滚）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'batch1');

    const r = mustOk<BatchResult>(
      await app.dispatch(
        req('POST', '/expenses/batch', {
          token: s.token,
          body: batchBody(s, [
            row('栈桥咖啡', '42.50'),
            row('便利店', '18.00'),
            row('东京药妆', '3200', { currency: 'USD' }), // 无授权汇率源 → 5006
            row('停车费', '5.00'),
          ]),
        }),
      ),
    );

    expect(r.created).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.results).toHaveLength(4);
    expect(r.results.map((x) => x.index)).toEqual([0, 1, 2, 3]);

    const failedRow = r.results.find((x) => !x.ok)!;
    expect(failedRow.index).toBe(2);
    expect(failedRow.error?.code).toBe(ErrorCode.FX_SOURCE_MISCONFIGURED);
    // 成功的行带 id
    expect(
      r.results.filter((x) => x.ok).every((x) => typeof x.id === 'string' && x.id !== ''),
    ).toBe(true);

    // 库内确实只有 3 笔
    const list = mustOk<{ items: unknown[] }>(
      await app.dispatch(req('GET', '/expenses', { token: s.token, query: { tripId: s.tripId } })),
    );
    expect(list.items).toHaveLength(3);
  });

  it('rows 上限 200：201 行整批拒（不截断、不静默成功）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'batch2');
    const rows = Array.from({ length: 201 }, (_, i) => row(`第${i}笔`));
    const r = await app.dispatch(
      req('POST', '/expenses/batch', { token: s.token, body: batchBody(s, rows) }),
    );
    expect(r.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
    const list = mustOk<{ items: unknown[] }>(
      await app.dispatch(req('GET', '/expenses', { token: s.token, query: { tripId: s.tripId } })),
    );
    expect(list.items).toHaveLength(0); // 一行都没写进去
  });

  it('幂等：同 requestId 重放返回首次结果，不重复记账（1 秒内也不被限流误伤）', async () => {
    const clock = makeClock();
    const app = freshApp(clock.now);
    const s = await scaffold(app, 'batch3');
    const body = batchBody(s, [row('早餐', '12.00'), row('午餐', '36.00')], 'req-batch-3');

    const first = mustOk<BatchResult>(
      await app.dispatch(req('POST', '/expenses/batch', { token: s.token, body })),
    );
    expect(first.created).toBe(2);

    // 客户端弱网重试：同 requestId **立刻**再发一次（不推进时钟）。
    // 🔴 这里刻意不推进时间：限流施力点在幂等占位之后，重放属零副作用回放，
    //    不该被 429 拦住 —— 否则用户会看到「导入过于频繁」，而服务端其实早已写好。
    const replay = mustOk<BatchResult>(
      await app.dispatch(req('POST', '/expenses/batch', { token: s.token, body })),
    );
    expect(replay).toEqual(first);
    expect(replay.created).toBe(2);

    const list = mustOk<{ items: unknown[] }>(
      await app.dispatch(req('GET', '/expenses', { token: s.token, query: { tripId: s.tripId } })),
    );
    expect(list.items).toHaveLength(2); // 没有记两遍
  });

  it('限流：同一用户 1 秒内第二次 → 4290；过了窗口放行', async () => {
    const clock = makeClock();
    const app = freshApp(clock.now);
    const s = await scaffold(app, 'batch4');

    const first = await app.dispatch(
      req('POST', '/expenses/batch', { token: s.token, body: batchBody(s, [row('第一笔')]) }),
    );
    expect(first.httpStatus).toBe(200);

    const blocked = await app.dispatch(
      req('POST', '/expenses/batch', { token: s.token, body: batchBody(s, [row('第二笔')]) }),
    );
    expect(blocked.httpStatus).toBe(429);
    expect(blocked.envelope.code).toBe(ErrorCode.RATE_LIMITED);
    // 提示不带剩余额度，只让稍后重试
    expect(blocked.envelope.message).toContain('秒后重试');

    clock.advance(1_200);
    const after = await app.dispatch(
      req('POST', '/expenses/batch', { token: s.token, body: batchBody(s, [row('第三笔')]) }),
    );
    expect(after.httpStatus).toBe(200);
  });

  it('整体权限门：非行程成员 → 404（不铺成 N 条「资源不存在」）', async () => {
    const app = freshApp();
    const owner = await scaffold(app, 'batch5owner');
    const outsider = await scaffold(app, 'batch5out');

    const r = await app.dispatch(
      req('POST', '/expenses/batch', {
        token: outsider.token,
        body: batchBody(owner, [row('偷记一笔'), row('再记一笔')]),
      }),
    );
    expect(r.httpStatus).toBe(404);
    expect(r.envelope.code).toBe(ErrorCode.NOT_FOUND);
    // 不是「200 + 两条 failed」
    expect(r.envelope.data).toBeNull();
  });

  it('自定义限流器可关闭节流（其它域/单测复用时的可配置性）', async () => {
    const limiter = new MinIntervalLimiter({ intervalMs: 0 });
    expect(limiter.tryAcquire('u1').ok).toBe(true);
    expect(limiter.tryAcquire('u1').ok).toBe(true);
  });
});
