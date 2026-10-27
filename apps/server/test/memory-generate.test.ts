/**
 * memory 域 · 「生成回忆」回归（线上 500 的根因锁定）
 * ============================================================================
 * 线上现象：行程详情 → 回忆 → 「生成本次出行回忆」→ 信封 `message: 服务内部错误`。
 *
 * 根因：`memory_archive.snap_key` 是 `uk_snap` 的唯一键，schema 里 NOT NULL
 * 且**无默认值**，而两处 insert 都没写这一列 →
 *   MySQL 严格模式：`Field 'snap_key' doesn't have a default value`（1364）
 *   → 事务回滚 → 全局兜底 500。
 *
 * 🔴 为什么以前没被测出来：MemoryTableDriver 是内存驱动，不校验 NOT NULL，
 *    于是「少写一列」在 CI 里完全隐形。本文件用**断言写入值**的方式补这道口子
 *    （内存驱动下断言 snapKey 确实被写进行里，等价于把 NOT NULL 约束提到应用层）。
 */

import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { mustOk, req, scaffold } from './helpers.js';

interface Generated {
  memory: Record<string, unknown>;
  snapshot: Record<string, unknown>;
  created: boolean;
}

function freshApp(): BuiltApp {
  return buildApp({ driver: new MemoryTableDriver(), mediaPublicBaseUrl: 'https://media.test' });
}

describe('POST /memories/generate-trip —— snap_key 必写（线上 500 回归）', () => {
  it('生成成功，且 snapKey = T:<tripId>', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'mem-trip-1');

    const r = mustOk<Generated>(
      await app.dispatch(
        req('POST', '/memories/generate-trip', { token: s.token, body: { tripId: s.tripId } }),
      ),
    );

    expect(r.created).toBe(true);
    // 这一行就是线上 1364 的直接防线：漏写即 fail
    expect(r.memory['snapKey']).toBe(`T:${s.tripId}`);
    expect(r.memory['type']).toBe('TRIP');
    expect(r.memory['refId']).toBe(s.tripId);
  });

  it('幂等：同一行程再生成返回既有快照，created=false', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'mem-trip-2');
    const body = { tripId: s.tripId };

    const first = mustOk<Generated>(
      await app.dispatch(req('POST', '/memories/generate-trip', { token: s.token, body })),
    );
    const second = mustOk<Generated>(
      await app.dispatch(req('POST', '/memories/generate-trip', { token: s.token, body })),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.memory['id']).toBe(first.memory['id']);
  });

  it('同一年两场出行各自一篇（uk_snap 语义，不再互相顶掉）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'mem-trip-3', { startDate: '2026-05-01', endDate: '2026-05-03' });

    const secondTrip = mustOk<{ trip: { id: string } }>(
      await app.dispatch(
        req('POST', '/trips', {
          token: s.token,
          body: {
            familyId: s.familyId,
            title: 'mem-trip-3 第二场',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          },
        }),
      ),
    );

    const a = mustOk<Generated>(
      await app.dispatch(
        req('POST', '/memories/generate-trip', { token: s.token, body: { tripId: s.tripId } }),
      ),
    );
    const b = mustOk<Generated>(
      await app.dispatch(
        req('POST', '/memories/generate-trip', {
          token: s.token,
          body: { tripId: secondTrip.trip.id },
        }),
      ),
    );

    expect(a.created).toBe(true);
    // 关键：第二场必须是**新建**，而不是命中第一场的快照
    expect(b.created).toBe(true);
    expect(b.memory['snapKey']).toBe(`T:${secondTrip.trip.id}`);
    expect(b.memory['id']).not.toBe(a.memory['id']);
  });
});

describe('POST /memories/generate-annual —— snap_key 必写', () => {
  it('生成成功，且 snapKey = A:<familyId>:<year>', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'mem-annual-1');

    const r = mustOk<Generated>(
      await app.dispatch(
        req('POST', '/memories/generate-annual', {
          token: s.token,
          body: { familyId: s.familyId, year: 2026 },
        }),
      ),
    );

    expect(r.created).toBe(true);
    expect(r.memory['snapKey']).toBe(`A:${s.familyId}:2026`);
    expect(r.memory['type']).toBe('ANNUAL');
  });

  it('幂等：同年再生成返回既有快照', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'mem-annual-2');
    const body = { familyId: s.familyId, year: 2026 };

    const first = mustOk<Generated>(
      await app.dispatch(req('POST', '/memories/generate-annual', { token: s.token, body })),
    );
    const second = mustOk<Generated>(
      await app.dispatch(req('POST', '/memories/generate-annual', { token: s.token, body })),
    );

    expect(second.created).toBe(false);
    expect(second.memory['id']).toBe(first.memory['id']);
  });
});
