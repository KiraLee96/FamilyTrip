/**
 * `/media/memories` 能力探测的回归基线（2026-10-27）
 * ============================================================================
 * 场景：生产仍是旧版后端，没有 `/media/memories` 路由。
 * 用户侧看到的是「一进首页 Console 就红一条 404」，反复进反复红，
 * 很容易被当成编译错误（2026-10-27 实际发生）。
 *
 * 现在的行为契约：
 *   ① 首次 4040 → 置「本后端没有该路由」的会话级标记 + 打一条**解释性 warn**；
 *   ② 本会话内再次调用 → 直接抛同形状错误，**不再发网络请求**（Console 只红一次）；
 *   ③ 只有 4040 会置标记；4010 等其它错误不置（登权重试后仍应有机会成功）；
 *   ④ 不持久化（重启小程序即重置）—— 后端部署后自动恢复，不存在缓存锁死。
 *
 * 🔴 为什么这个测试必须存在：②③ 是「省掉一次网络」这种**看不见的**行为，
 *    没有断言的话，谁把 try/catch 挪一下就会悄悄退回「每次都打网络」。
 *
 * 🔴 为什么不用 vi.resetModules 起全新模块实例：
 *    能力标记是模块级变量，本可以用 resetModules 隔离，但那样会逼 vitest
 *    重新走 SSR 转换并把缓存写进 %TEMP% —— 在受限环境里直接 EPERM
 *    （2026-10-27 实测）。改用**声明顺序**：只有最后一个用例置标记，
 *    前面的用例在未置位状态下跑，天然互不污染。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestSpy = vi.fn();

vi.mock('@tarojs/taro', () => ({
  default: {
    request: (...args: unknown[]) => requestSpy(...args) as unknown,
    removeStorageSync: (): void => undefined,
    setStorageSync: (): void => undefined,
    getStorageSync: (): string => '',
  },
}));

import { createHttpClient } from '../http';

const api = createHttpClient();

/** 让下一次 Taro.request 返回给定信封 */
function respondWith(env: unknown, statusCode = 200): void {
  requestSpy.mockResolvedValueOnce({ statusCode, data: env });
}

const NOT_FOUND = { code: 4040, message: '资源不存在', data: null, meta: {} };

describe('listPhotoMemories · 后端缺路由时的行为', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  // ⚠️ 顺序有意义：只有最后一个用例会置「缺路由」标记，请勿调换。
  it('① 4010 等非 4040 错误不置标记：下次仍会真的发请求', async () => {
    respondWith({ code: 4010, message: '缺少 Authorization', data: null, meta: {} }, 401);
    await expect(api.listPhotoMemories({ familyId: '10' })).rejects.toMatchObject({ code: 4010 });
    expect(requestSpy).toHaveBeenCalledTimes(1);

    // 登权重登后重试仍有机会成功 —— 不能被误记成「后端没有这个路由」
    respondWith({ code: 0, message: 'ok', data: { items: [] } });
    await expect(api.listPhotoMemories({ familyId: '10' })).resolves.toEqual([]);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('② 后端正常时：解析分组，且只打一次请求', async () => {
    respondWith({
      code: 0,
      message: 'ok',
      data: {
        items: [
          {
            kind: 'TRIP',
            tripId: '101',
            month: null,
            title: '国庆 · 青岛看海',
            subtitle: '2026-10-01 ~ 2026-10-05',
            cover: 'https://media.test/f/1/a.jpg',
            photoCount: 3,
            photos: ['https://media.test/f/1/a.jpg'],
            lastAt: '2026-10-05T10:00:00.000Z',
          },
        ],
      },
    });

    // 显式传 familyId：跳过 resolveFamilyId 的 /families 请求，专注本用例
    const groups = await api.listPhotoMemories({ familyId: '10', limit: 8 });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('TRIP');
    expect(groups[0]?.tripId).toBe('101');
    expect(groups[0]?.photoCount).toBe(3);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('③ 首次 4040 后：本会话不再发请求，Console 只红一次', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    respondWith(NOT_FOUND, 404);

    // 第一次：真的打了一次网络，抛 4040
    await expect(api.listPhotoMemories({ familyId: '10' })).rejects.toMatchObject({ code: 4040 });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    // 解释性 warn 必须打出来（不然看日志的人只能靠猜）
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('/media/memories');

    // 第二次：形状一致地失败，但**没有新的网络请求**
    await expect(api.listPhotoMemories({ familyId: '10' })).rejects.toMatchObject({ code: 4040 });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    // warn 也不重复刷
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });
});
