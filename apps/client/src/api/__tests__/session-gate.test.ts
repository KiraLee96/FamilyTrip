/**
 * 登录闸门回归（2026-10-27）
 * ============================================================================
 * 修的是线上反复出现的一条红字：`GET /api/trips 401`。
 *
 * 根因不是权限，是**冷启动竞态**：页面一挂载就发请求，而 `useLaunch` 里的
 * `bootstrapSession()` 还没拿到 token → 请求裸奔（无 Authorization）→
 * 服务端 `4010 缺少 Authorization` → 白触发一次静默重登。
 * 用户侧表现：每次冷启动 Console 都红一条 401，看起来像"登录坏了"。
 *
 * 现在的契约：**无 token 时请求先等闸门**（= 一次登录），登录完成再发。
 *
 * 🔴 这个测试守的是"顺序"，不是"结果" —— 结果两种写法都能拿到数据，
 *    只有顺序错了才会多打一次必然 401 的请求。所以断言必须落在
 *    「闸门放行前，网络没被调用」。
 */

import { describe, expect, it, vi } from 'vitest';

const requestSpy = vi.fn();

vi.mock('@tarojs/taro', () => ({
  default: {
    request: (...args: unknown[]) => requestSpy(...args) as unknown,
    getStorageSync: (): string => '',
    setStorageSync: (): void => undefined,
    removeStorageSync: (): void => undefined,
  },
}));

import { createHttpClient, installSessionGate, setToken } from '../http';

/** 让出几个微任务，给 request() 里 await 闸门的挂起点执行的机会 */
async function tick(n = 4): Promise<void> {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe('登录闸门 · 首屏请求不再裸奔', () => {
  it('无 token 时请求先等闸门；登录完成后带 Authorization 发出', async () => {
    requestSpy.mockReset();
    requestSpy.mockResolvedValue({
      statusCode: 200,
      data: { code: 0, message: 'ok', data: { items: [] } },
    });

    const api = createHttpClient();

    let release!: () => void;
    installSessionGate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    // ① 闸门未放行：请求应挂起，网络一次都没打
    const pending = api.listTrips();
    await tick();
    expect(requestSpy).not.toHaveBeenCalled();

    // ② 登录完成（token 就位 + 闸门放行）：请求才真正发出，且带上了凭证
    setToken('tk-1');
    release();
    await pending;

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const init = requestSpy.mock.calls[0]?.[0] as { header?: Record<string, string> };
    expect(init.header?.['Authorization']).toBe('Bearer tk-1');

    setToken(undefined);
  });

  it('已持有（可能过期的）token 时**也**先等闸门', async () => {
    requestSpy.mockReset();
    requestSpy.mockResolvedValue({
      statusCode: 200,
      data: { code: 0, message: 'ok', data: { items: [] } },
    });

    const api = createHttpClient();

    // 模拟冷启动时 Storage 里躺着一个过期 token
    setToken('stale-token');

    let release!: () => void;
    installSessionGate(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const pending = api.listTrips();
    await tick();
    // 🔴 关键：带着旧 token 直接发出去，就是那条"每次都出现"的 401
    expect(requestSpy).not.toHaveBeenCalled();

    // 闸门放行时凭证已被换成新的
    setToken('fresh-token');
    release();
    await pending;

    const init = requestSpy.mock.calls[0]?.[0] as { header?: Record<string, string> };
    expect(init.header?.['Authorization']).toBe('Bearer fresh-token');

    setToken(undefined);
  });

  it('闸门失败不阻塞请求：照常发出，交给 401 重登兜底', async () => {
    requestSpy.mockReset();
    requestSpy.mockResolvedValue({
      statusCode: 200,
      data: { code: 0, message: 'ok', data: { items: [] } },
    });

    const api = createHttpClient();
    installSessionGate(() => Promise.reject(new Error('登录失败')));

    await expect(api.listTrips()).resolves.toEqual([]);
    // 闸门挂了也要发请求 —— 否则整个 App 在登录失败时会"全部静默不动"
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });
});
