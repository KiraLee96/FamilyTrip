/**
 * 最小间隔限流器 · 单测（D-2026-10-26-01 P1-1 的基础件）
 *
 * 🔴 断言重点在**被拒时不推进窗口**：朴素实现会在每次尝试都更新「上次时间」，
 *    于是客户端越重试越久，最终变成指数级惩罚 —— 那不是限流，是拒绝服务。
 */

import { describe, expect, it } from 'vitest';
import { MinIntervalLimiter } from './rate-limit.js';

function clock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('MinIntervalLimiter', () => {
  it('首次放行；未到间隔被拒并给出 retryAfterMs', () => {
    const c = clock();
    const limiter = new MinIntervalLimiter({ intervalMs: 1_000, now: c.now });

    expect(limiter.tryAcquire('u1')).toEqual({ ok: true });
    c.advance(400);
    expect(limiter.tryAcquire('u1')).toEqual({ ok: false, retryAfterMs: 600 });
  });

  it('被拒不推进窗口：连续重试的等待时间单调减少，不会越试越久', () => {
    const c = clock();
    const limiter = new MinIntervalLimiter({ intervalMs: 1_000, now: c.now });
    limiter.tryAcquire('u1');

    c.advance(300);
    const first = limiter.tryAcquire('u1');
    c.advance(300);
    const second = limiter.tryAcquire('u1');
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (first.ok || second.ok) throw new Error('应被拒');
    // 时间在走，剩余窗口必须变小（若按「上次尝试」计时则恒为 700）
    expect(second.retryAfterMs).toBeLessThan(first.retryAfterMs);
    expect(second.retryAfterMs).toBe(400);
  });

  it('不同 key 互不影响', () => {
    const c = clock();
    const limiter = new MinIntervalLimiter({ intervalMs: 1_000, now: c.now });
    expect(limiter.tryAcquire('u1').ok).toBe(true);
    expect(limiter.tryAcquire('u2').ok).toBe(true);
  });

  it('过了间隔重新放行', () => {
    const c = clock();
    const limiter = new MinIntervalLimiter({ intervalMs: 1_000, now: c.now });
    limiter.tryAcquire('u1');
    c.advance(1_000);
    expect(limiter.tryAcquire('u1').ok).toBe(true);
  });

  it('maxKeys 上限：淘汰最久未使用的 key，不无界增长', () => {
    const c = clock();
    const limiter = new MinIntervalLimiter({ intervalMs: 1_000, maxKeys: 2, now: c.now });
    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    expect(limiter.size).toBe(2);
    limiter.tryAcquire('c');
    expect(limiter.size).toBe(2);
    // a 已被淘汰 → 再次 acquire 视为首次，立即放行
    expect(limiter.tryAcquire('a').ok).toBe(true);
  });
});
