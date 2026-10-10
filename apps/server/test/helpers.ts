/**
 * 测试公共脚手架
 * ============================================================================
 * 为什么抽出来：
 *   4 个集成测试文件（concurrency-e / crypto-booking / permission-d / sync-b1）
 *   各自复制了一份 `req` / `mustOk` / `scaffold`，且 `scaffold` 只差出行日期。
 *   重复的脚手架是测试维护成本的主要来源 —— 接口一变要改四处。
 *
 * 🔴 测试里对 `data` 的断言必须走**信封真实结构**（`{trip:{...}}` 而不是裸对象）。
 *    本文件把所有 shape 假设集中在这里，避免每个用例各自猜。
 */

import { expect } from 'vitest';
import type { BuiltApp } from '../src/composition-root.js';
import type { RawRequest } from '../src/common/middleware/dispatcher.js';

/** 构造一次请求（header 注入 token，可选 body / query） */
export function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; query?: Record<string, string> } = {},
): RawRequest {
  const headers: Record<string, string | undefined> = {};
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  return {
    method: method.toUpperCase(),
    path,
    headers,
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
  };
}

/** dispatcher 返回形状（测试只需这三项） */
export interface DispatchResult {
  httpStatus: number;
  envelope: { code: number; message: string; data: unknown };
}

/** 断言 2xx 并取出 `envelope.data` */
export function mustOk<T>(r: DispatchResult): T {
  expect(r.httpStatus, `期望 2xx，实得 ${r.httpStatus} / ${r.envelope.message}`).toBeLessThan(300);
  return r.envelope.data as T;
}

/** 建立「用户 + 家庭 + 出行」脚手架后拿到的三个 id 与 token */
export interface Scaffold {
  token: string;
  userId: string;
  familyId: string;
  tripId: string;
}

/**
 * 建立脚手架：登录 → 建家庭 → 建出行。
 *
 * @param code 微信 code，同时决定 openid（`openid_${code}`），用于区分不同用户
 * @param dates 出行起止日期；默认给一组固定值，需要隔离数据时由调用方传
 */
export async function scaffold(
  app: BuiltApp,
  code: string,
  dates: { startDate: string; endDate: string } = { startDate: '2026-08-01', endDate: '2026-08-03' },
): Promise<Scaffold> {
  const login = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  const family = mustOk<{ family: { id: string } }>(
    await app.dispatch(req('POST', '/families', { token: login.token, body: { name: `${code}家` } })),
  );
  const trip = mustOk<{ trip: { id: string } }>(
    await app.dispatch(
      req('POST', '/trips', {
        token: login.token,
        body: {
          familyId: family.family.id,
          title: `${code} 出行`,
          startDate: dates.startDate,
          endDate: dates.endDate,
        },
      }),
    ),
  );
  return {
    token: login.token,
    userId: login.user.id,
    familyId: family.family.id,
    tripId: trip.trip.id,
  };
}

/**
 * 取驱动的整表快照（物理行）。
 *
 * 加密域 / 软删的验收点断言的是**落库物理行**，而业务读路径故意不暴露这些字段，
 * 只能从驱动层取。生产适配器可以不实现 `dump`，因此这里先断言存在。
 */
export function dumpTable(app: BuiltApp, model: string): Record<string, unknown>[] {
  const driver = app.driver;
  const dump = driver.dump?.bind(driver);
  expect(dump, '当前驱动未实现 dump()，无法做落库物理断言').toBeTypeOf('function');
  // 已显式 bind 到 driver：可选方法脱离对象会丢 this（unbound-method）。
  return dump!(model);
}
