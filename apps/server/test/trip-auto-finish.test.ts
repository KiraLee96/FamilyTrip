/**
 * D-2026-10-26-02 · 后端配套验收
 * ============================================================================
 * 覆盖四件事：
 *   P0-1  行程到期自动完结（定时扫描 + 读路径惰性流转 + 回滚开关）
 *   P2-1  POST /trips/:id/finish 幂等
 *   P1-1  GET /trips 每项带 memberCount
 *   附带  调度配置解析与循环的四条硬约束（防重入 / 可停止 / 失败不终止 / unref）
 *
 * 🔴 为什么用「直接调 service.autoFinishExpired()」而不是等定时器：
 *    定时器只是一层皮，真正的归档判定全在 service 里。service 层跑通 +
 *    循环层单独测触发性，比「挂着真定时器睡 5 分钟」既快又确定。
 *
 * 🔴 惰性流转会干扰「扫描」用例：所以 A1–A4、P1-1、P2-1 都用
 *    `autoFinish: { lazyOnRead: false }` 建 app，只让显式扫描生效；
 *    A5 专门用默认配置验读路径。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import {
  AUTO_FINISH_DEFAULTS,
  readAutoFinishConfig,
  startAutoFinishScheduler,
} from '../src/common/scheduler/auto-finish.js';
import type { TripService } from '../src/domains/trip/trip.service.js';
import { dumpTable, mustOk, req } from './helpers.js';

function freshApp(autoFinish?: { lazyOnRead?: boolean; enabled?: boolean }): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: 'https://media.test',
    ...(autoFinish !== undefined ? { autoFinish } : {}),
  });
}

/** 只让显式扫描生效的 app（默认惰性流转会盖掉「扫描」的观测点） */
function appWithoutLazyRead(): BuiltApp {
  return freshApp({ lazyOnRead: false });
}

function tripServiceOf(app: BuiltApp): TripService {
  return app.services['trip'] as TripService;
}

interface Boot {
  token: string;
  userId: string;
  familyId: string;
  tripId: string;
  version: number;
}

/** 登录 → 建家庭 → 建行程（拿到 create 返回的 version） */
async function boot(
  app: BuiltApp,
  code: string,
  dates: { startDate: string; endDate: string },
): Promise<Boot> {
  const login = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  const family = mustOk<{ family: { id: string } }>(
    await app.dispatch(
      req('POST', '/families', { token: login.token, body: { name: `${code}家` } }),
    ),
  );
  const trip = mustOk<{ trip: Record<string, unknown> }>(
    await app.dispatch(
      req('POST', '/trips', {
        token: login.token,
        body: { familyId: family.family.id, title: `${code} 出行`, ...dates },
      }),
    ),
  );
  return {
    token: login.token,
    userId: login.user.id,
    familyId: family.family.id,
    tripId: String(trip.trip['id']),
    version: Number(trip.trip['version']),
  };
}

/** 改状态（会 CAS 一次，version 自增） */
async function setStatus(
  app: BuiltApp,
  s: Boot,
  status: 'PLANNED' | 'CANCELLED',
  version = s.version,
): Promise<number> {
  const r = mustOk<{ trip: { version: number } }>(
    await app.dispatch(
      req('PATCH', `/trips/${s.tripId}`, {
        token: s.token,
        body: { version, status },
      }),
    ),
  );
  return r.trip.version;
}

function auditCountBy(reason: string): (app: BuiltApp) => number {
  return (app) => dumpTable(app, 'auditLog').filter((r) => r['reason'] === reason).length;
}

const autoFinishedAudits = auditCountBy('TRIP_AUTO_FINISHED');

function changeLogCount(app: BuiltApp, tripId: string): number {
  return dumpTable(app, 'changeLog').filter(
    (r) => r['entityType'] === 'trip' && String(r['entityId']) === tripId,
  ).length;
}

async function detailOf(app: BuiltApp, s: Boot): Promise<Record<string, unknown>> {
  return mustOk<Record<string, unknown>>(
    await app.dispatch(req('GET', `/trips/${s.tripId}`, { token: s.token })),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-1 方案 A：扫描自动完结
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-02 P0-1 · 过期行程自动完结（扫描）', () => {
  it('A1：end_date 已过 → 归档 FINISHED、成员转历史只读、change_log + audit（reason=TRIP_AUTO_FINISHED）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'af1', { startDate: '2020-01-02', endDate: '2020-01-03' });
    const v1 = await setStatus(app, s, 'PLANNED');
    expect(v1).toBe(1);
    const logsBefore = changeLogCount(app, s.tripId);

    const stats = await tripServiceOf(app).autoFinishExpired();
    expect(stats).toEqual({ scanned: 1, finished: 1, skipped: 0, failed: 0 });

    const detail = await detailOf(app, s);
    const trip = detail['trip'] as Record<string, unknown>;
    expect(trip['status']).toBe('FINISHED');
    // 成员不软删，只转只读 —— 历史要留「谁参加过」
    expect(detail['myAccessLevel']).toBe('HISTORICAL_READONLY');
    expect(detail['memberCount']).toBe(1);

    // 审计归属创建者，reason 与手工 TRIP_FINISHED 区分（便于对账）
    const audits = dumpTable(app, 'auditLog').filter((r) => r['reason'] === 'TRIP_AUTO_FINISHED');
    expect(audits.length).toBe(1);
    expect(audits[0]?.['action']).toBe('trip.auto_finish');
    expect(audits[0]?.['severity']).toBe('INFO');
    expect(String(audits[0]?.['actorId'])).toBe(s.userId);
    expect(String(audits[0]?.['targetId'])).toBe(s.tripId);

    // change_log 恰好多一条 UPDATE（PATCH 那次之外的归档信号）
    expect(changeLogCount(app, s.tripId)).toBe(logsBefore + 1);
  });

  it('A2：重复扫描幂等 —— 第二轮不再归档、不再产生审计、version 不再自增', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'af2', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, s, 'PLANNED');

    const first = await tripServiceOf(app).autoFinishExpired();
    expect(first.finished).toBe(1);
    const afterFirst = dumpTable(app, 'trip').find((r) => String(r['id']) === s.tripId);
    const versionAfterFirst = String(afterFirst?.['version']);
    const auditsAfterFirst = autoFinishedAudits(app);

    const second = await tripServiceOf(app).autoFinishExpired();
    expect(second).toEqual({ scanned: 0, finished: 0, skipped: 0, failed: 0 });

    const afterSecond = dumpTable(app, 'trip').find((r) => String(r['id']) === s.tripId);
    expect(String(afterSecond?.['version'])).toBe(versionAfterFirst);
    expect(autoFinishedAudits(app)).toBe(auditsAfterFirst);
  });

  it('A3：未到 end_date 的行程不受影响（结束日当天仍算进行中）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'af3', { startDate: '2099-01-02', endDate: '2099-01-03' });
    await setStatus(app, s, 'PLANNED');

    const stats = await tripServiceOf(app).autoFinishExpired();
    expect(stats.scanned).toBe(0);

    const detail = await detailOf(app, s);
    expect((detail['trip'] as Record<string, unknown>)['status']).toBe('PLANNED');
    expect(detail['myAccessLevel']).toBe('ACTIVE');
  });

  it('A4：CANCELLED / DRAFT 不参与流转（取消是事实，草稿不该被静默归档）', async () => {
    const app = appWithoutLazyRead();
    const cancelled = await boot(app, 'af4a', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, cancelled, 'CANCELLED');
    const draft = await boot(app, 'af4b', { startDate: '2020-01-02', endDate: '2020-01-03' });

    const stats = await tripServiceOf(app).autoFinishExpired();
    expect(stats.scanned).toBe(0);

    const rows = dumpTable(app, 'trip');
    expect(rows.find((r) => String(r['id']) === cancelled.tripId)?.['status']).toBe('CANCELLED');
    expect(rows.find((r) => String(r['id']) === draft.tripId)?.['status']).toBe('DRAFT');
  });

  it('A5：batchLimit 生效（单轮最多处理 N 条，其余留给下一轮）', async () => {
    const app = appWithoutLazyRead();
    for (const code of ['af5a', 'af5b', 'af5c']) {
      const s = await boot(app, code, { startDate: '2020-01-02', endDate: '2020-01-03' });
      await setStatus(app, s, 'PLANNED');
    }

    const first = await tripServiceOf(app).autoFinishExpired({ batchLimit: 2 });
    expect(first.scanned).toBe(3);
    expect(first.finished).toBe(2);

    const second = await tripServiceOf(app).autoFinishExpired({ batchLimit: 2 });
    expect(second.scanned).toBe(1);
    expect(second.finished).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P0-1 方案 B：读路径惰性流转
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-02 P0-1 · 读时惰性流转（定时器没跑时的兜底）', () => {
  it('B1：GET /trips/:id 前先归档 —— 详情返回 FINISHED + 历史只读', async () => {
    const app = freshApp(); // 默认 lazyOnRead=true
    const s = await boot(app, 'lazy1', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, s, 'PLANNED');

    const detail = await detailOf(app, s);
    expect((detail['trip'] as Record<string, unknown>)['status']).toBe('FINISHED');
    expect(detail['myAccessLevel']).toBe('HISTORICAL_READONLY');
    expect(autoFinishedAudits(app)).toBe(1);
  });

  it('B2：GET /trips 列表项也拿到归档后的状态（不是过期前的 PLANNED）', async () => {
    const app = freshApp();
    const s = await boot(app, 'lazy2', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, s, 'PLANNED');

    const list = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/trips', { token: s.token })),
    );
    const item = list.items.find((i) => String(i['id']) === s.tripId);
    expect(item?.['status']).toBe('FINISHED');
    expect(item?.['myAccessLevel']).toBe('HISTORICAL_READONLY');
  });

  it('B3：lazyOnRead=false → 读路径不改状态（灰度和排障时用）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'lazy3', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, s, 'PLANNED');

    const detail = await detailOf(app, s);
    expect((detail['trip'] as Record<string, unknown>)['status']).toBe('PLANNED');
    expect(autoFinishedAudits(app)).toBe(0);
  });

  it('B4：AUTO_FINISH_ENABLED=false（enabled=false）时读路径也不流转 —— 回滚开关真的关得住', async () => {
    const app = freshApp({ enabled: false, lazyOnRead: true });
    const s = await boot(app, 'lazy4', { startDate: '2020-01-02', endDate: '2020-01-03' });
    await setStatus(app, s, 'PLANNED');

    const detail = await detailOf(app, s);
    expect((detail['trip'] as Record<string, unknown>)['status']).toBe('PLANNED');
    expect(autoFinishedAudits(app)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 定时器循环本体
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-02 P0-1 · 定时器循环', () => {
  it('C1：按间隔触发；stop 后不再触发；单轮失败不终止循环', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const scheduler = startAutoFinishScheduler({
      config: { ...AUTO_FINISH_DEFAULTS, intervalMs: 1000 },
      intervalMs: 1000,
      runOnStart: false,
      log: () => undefined,
      sweep: () => {
        calls += 1;
        // 第一轮抛错：验证「失败不终止」
        if (calls === 1) return Promise.reject(new Error('boom'));
        return Promise.resolve({ finished: 0, failed: 0 });
      },
    });
    expect(scheduler).not.toBeNull();

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(3);

    scheduler?.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls).toBe(3);
  });

  it('C2：上一轮未跑完时跳过本轮（防重入，不在内存里堆积）', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let release: (() => void) | undefined;
    const scheduler = startAutoFinishScheduler({
      config: { ...AUTO_FINISH_DEFAULTS, intervalMs: 1000 },
      intervalMs: 1000,
      runOnStart: false,
      log: () => undefined,
      sweep: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = (): void => resolve({ finished: 0, failed: 0 });
        });
      },
    });

    await vi.advanceTimersByTimeAsync(1000); // 第一轮开始并挂住
    await vi.advanceTimersByTimeAsync(3000); // 期间又触发 3 次 → 全被跳过
    expect(calls).toBe(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1000); // 释放后下一轮正常开跑
    expect(calls).toBe(2);
    release?.();

    scheduler?.stop();
  });

  it('C3：enabled=false → 不创建调度器（返回 null）', () => {
    const scheduler = startAutoFinishScheduler({
      config: { ...AUTO_FINISH_DEFAULTS, enabled: false },
      sweep: () => Promise.resolve({ finished: 0, failed: 0 }),
      log: () => undefined,
    });
    expect(scheduler).toBeNull();
  });

  it('C4：配置解析 —— 缺省全开；显式关闭；非法值回落缺省', () => {
    expect(readAutoFinishConfig({})).toEqual(AUTO_FINISH_DEFAULTS);

    expect(readAutoFinishConfig({ AUTO_FINISH_ENABLED: 'false' }).enabled).toBe(false);
    expect(readAutoFinishConfig({ AUTO_FINISH_LAZY_ON_READ: 'off' }).lazyOnRead).toBe(false);
    expect(readAutoFinishConfig({ AUTO_FINISH_INTERVAL_MS: '600000' }).intervalMs).toBe(600000);

    // 非法/越界 → 回落缺省（配置写错不该让服务起不来）
    expect(readAutoFinishConfig({ AUTO_FINISH_INTERVAL_MS: '0' }).intervalMs).toBe(
      AUTO_FINISH_DEFAULTS.intervalMs,
    );
    expect(readAutoFinishConfig({ AUTO_FINISH_INTERVAL_MS: 'abc' }).intervalMs).toBe(
      AUTO_FINISH_DEFAULTS.intervalMs,
    );
    expect(readAutoFinishConfig({ AUTO_FINISH_BATCH_LIMIT: '-5' }).batchLimit).toBe(
      AUTO_FINISH_DEFAULTS.batchLimit,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-1 finish 幂等
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-02 P2-1 · POST /trips/:id/finish 幂等', () => {
  it('D1：已 FINISHED 再点一次 → 200 alreadyFinished=true，不写新审计/change_log', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'idem1', { startDate: '2099-01-02', endDate: '2099-01-03' });
    const v1 = await setStatus(app, s, 'PLANNED');

    const first = mustOk<{ trip: { status: string }; alreadyFinished: boolean }>(
      await app.dispatch(
        req('POST', `/trips/${s.tripId}/finish`, { token: s.token, body: { version: v1 } }),
      ),
    );
    expect(first.trip.status).toBe('FINISHED');
    expect(first.alreadyFinished).toBe(false);

    const auditsBefore = dumpTable(app, 'auditLog').length;
    const logsBefore = changeLogCount(app, s.tripId);

    const second = mustOk<{ trip: { status: string; version: number }; alreadyFinished: boolean }>(
      await app.dispatch(
        req('POST', `/trips/${s.tripId}/finish`, { token: s.token, body: { version: v1 } }),
      ),
    );
    expect(second.alreadyFinished).toBe(true);
    expect(second.trip.status).toBe('FINISHED');
    // 幂等出口不动版本、不写日志
    expect(second.trip.version).toBe(v1 + 1);
    expect(dumpTable(app, 'auditLog').length).toBe(auditsBefore);
    expect(changeLogCount(app, s.tripId)).toBe(logsBefore);
  });

  it('D2：未归档但 version 不符 → 仍然 409（幂等只对「已完成」生效，不吞真冲突）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'idem2', { startDate: '2099-01-02', endDate: '2099-01-03' });
    const v1 = await setStatus(app, s, 'PLANNED');

    const r = await app.dispatch(
      req('POST', `/trips/${s.tripId}/finish`, { token: s.token, body: { version: v1 + 99 } }),
    );
    expect(r.httpStatus).toBe(409);
    expect(r.envelope.code).toBe(4090);
  });

  it('D3：非主导者调 finish → 403；非行程成员 → 404（幂等出口不越过鉴权）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'idem3', { startDate: '2099-01-02', endDate: '2099-01-03' });
    const v1 = await setStatus(app, s, 'PLANNED');

    // 外部同行者凭邀请码加入（MEMBER，非 LEADER）
    const invite = mustOk<{ inviteCode: string }>(
      await app.dispatch(req('GET', `/trips/${s.tripId}/invite`, { token: s.token })),
    );
    const other = mustOk<{ token: string }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'idem3-other' } })),
    );
    mustOk(
      await app.dispatch(
        req('POST', '/trips/join', {
          token: other.token,
          body: { inviteCode: invite.inviteCode },
        }),
      ),
    );

    // 未归档 + 同行成员但非主导者 → service 抛 403
    const asMember = await app.dispatch(
      req('POST', `/trips/${s.tripId}/finish`, { token: other.token, body: { version: v1 } }),
    );
    expect(asMember.httpStatus).toBe(403);
    expect(asMember.envelope.message).toBe('仅主导者可执行该操作');

    // 归档后同一个人再点 → 仍然 403（幂等出口在鉴权之后，不放宽非主导者）
    mustOk(
      await app.dispatch(
        req('POST', `/trips/${s.tripId}/finish`, { token: s.token, body: { version: v1 } }),
      ),
    );
    const asMemberAfterArchive = await app.dispatch(
      req('POST', `/trips/${s.tripId}/finish`, { token: other.token, body: { version: v1 } }),
    );
    expect(asMemberAfterArchive.httpStatus).toBe(403);

    // 完全无关的用户 → 网关 trip 维度不放行 → 404 同形（D8）
    const outsider = mustOk<{ token: string }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'idem3-outsider' } })),
    );
    const asOutsider = await app.dispatch(
      req('POST', `/trips/${s.tripId}/finish`, { token: outsider.token, body: { version: v1 } }),
    );
    expect(asOutsider.httpStatus).toBe(404);
  });

  it('D4：finish 带 actual → actual_json 以**对象**落库（不是 JSON 字符串再转义一次）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'idem4', { startDate: '2099-01-02', endDate: '2099-01-03' });
    const v1 = await setStatus(app, s, 'PLANNED');
    const actual = { weather: '晴', days: 3 };

    const r = mustOk<{ trip: Record<string, unknown> }>(
      await app.dispatch(
        req('POST', `/trips/${s.tripId}/finish`, {
          token: s.token,
          body: { version: v1, actual },
        }),
      ),
    );
    expect(r.trip['actualJson']).toEqual(actual);

    const row = dumpTable(app, 'trip').find((x) => String(x['id']) === s.tripId);
    // MySQL 的 JSON 列要的是 JSON 值；传字符串会存成「JSON 字符串标量」（双重转义）
    expect(typeof row?.['actualJson']).toBe('object');
    expect(row?.['actualJson']).toEqual(actual);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-1 GET /trips 的 memberCount
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-26-02 P1-1 · GET /trips 每项带 memberCount', () => {
  it('E1：memberCount = trip_member 存活行数（不是家庭人数）', async () => {
    const app = appWithoutLazyRead();
    const s = await boot(app, 'cnt1', { startDate: '2099-01-02', endDate: '2099-01-03' });

    // 家庭再加 2 个成员（走真实邀请码链路）→ 家庭 3 人
    const familyDetail = mustOk<{ family: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
    );
    for (const code of ['cnt1-a', 'cnt1-b']) {
      const other = mustOk<{ token: string }>(
        await app.dispatch(req('POST', '/auth/login', { body: { code } })),
      );
      mustOk(
        await app.dispatch(
          req('POST', '/families/join', {
            token: other.token,
            body: { inviteCode: familyDetail.family.inviteCode, displayName: code },
          }),
        ),
      );
    }

    // 本趟只带 1 个虚拟成员同行 → 行程 2 人，家庭 3 人（数字必须不同才算测到口径）
    mustOk(
      await app.dispatch(
        req('POST', `/trips/${s.tripId}/members`, {
          token: s.token,
          body: { displayName: '外婆', isVirtual: true },
        }),
      ),
    );

    const list = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/trips', { token: s.token })),
    );
    const item = list.items.find((i) => String(i['id']) === s.tripId);
    expect(item?.['memberCount']).toBe(2);
    expect(item?.['myRole']).toBe('LEADER');
    expect(item?.['myAccessLevel']).toBe('ACTIVE');

    // 家庭人数确实不是 2 —— 防止「口径写回家庭人数也一样过」的假绿
    const family = mustOk<{ memberCount?: number; members?: unknown[] }>(
      await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
    );
    const familyMemberCount = family.memberCount ?? family.members?.length ?? 0;
    expect(familyMemberCount).toBe(3);
  });
});
