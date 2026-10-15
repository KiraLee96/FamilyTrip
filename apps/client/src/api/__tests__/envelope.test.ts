/**
 * 网络层信封回归测试（真后端模式）
 * ============================================================================
 * 覆盖 2026-10-15 用户反馈「行程还是无法删除」的根因：
 *
 *   后端 DELETE 成功响应的契约是 `{ code: 0, message, data: null }`
 *   （见派发单 D-2026-10-15-01 §三：`DELETE /trips/:id` → data = null）。
 *   而 `unwrap()` 把 `data === null` 判为异常（`ApiError(-1, '响应 data 为空')`），
 *   导致 9 个 DELETE 端点「服务端删成功、客户端抛异常」，界面表现为删不掉。
 *
 * 本测试直接驱动真实实现（`createHttpClient`），只把 `Taro.request` 换成桩：
 *   · 红线相关路径（信封解析 / code 判定 / 投影）全部走真实代码；
 *   · Mock 模式不经信封，因此这组断言只能在这里兜住。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Taro.request 桩：由每个用例注入待返回的信封 */
const requestSpy = vi.fn();

vi.mock('@tarojs/taro', () => ({
  default: {
    request: (...args: unknown[]) => requestSpy(...args) as unknown,
    removeStorageSync: (): void => undefined,
    setStorageSync: (): void => undefined,
  },
}));

import { ApiError } from '../client';
import { createHttpClient } from '../http';

/** 让下一次 Taro.request 返回给定信封 */
function respondWith(env: unknown): void {
  requestSpy.mockResolvedValueOnce({ statusCode: 200, data: env });
}

describe('信封解析 · DELETE 成功（data = null）', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('deleteTrip 在 {code:0,data:null} 下应当成功（本体回归用例）', async () => {
    respondWith({ code: 0, message: 'ok', data: null });
    const api = createHttpClient();

    await expect(api.deleteTrip('101')).resolves.toBeUndefined();
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [req] = requestSpy.mock.calls[0] as [{ url: string; method: string }];
    expect(req.method).toBe('DELETE');
    expect(req.url).toContain('/trips/101');
  });

  it('其余 8 个删除端点同样不被空 data 误判', async () => {
    const api = createHttpClient();
    const calls: Array<[string, () => Promise<void>]> = [
      ['dissolveFamily', () => api.dissolveFamily('10')],
      ['removeFamilyMember', () => api.removeFamilyMember('7002')],
      ['removeTripMember', () => api.removeTripMember('9001')],
      ['deleteItineraryItem', () => api.deleteItineraryItem('301')],
      ['deleteChecklistItem', () => api.deleteChecklistItem('401')],
      ['deleteExpense', () => api.deleteExpense('501')],
      ['deleteItem', () => api.deleteItem('801')],
      ['deleteMediaAsset', () => api.deleteMediaAsset('601')],
    ];

    for (const [name, call] of calls) {
      respondWith({ code: 0, message: 'ok', data: null });
      await expect(call(), `${name} 应成功`).resolves.toBeUndefined();
    }
    expect(requestSpy).toHaveBeenCalledTimes(calls.length);
  });

  it('失败信封仍按错误码上抛（403 不可删除要能被界面区分）', async () => {
    respondWith({ code: 4030, message: '仅主导者或创建者可删除', data: null });
    const api = createHttpClient();

    await expect(api.deleteTrip('101')).rejects.toMatchObject({
      name: 'ApiError',
      code: 4030,
    });
  });
});

describe('信封解析 · 读路径守卫保持不变', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('读单个实体时 data 为 null 仍视为异常（防止空体被当成功）', async () => {
    // 只排队一个响应，因此这里必须复用同一个 promise：
    // 若写成两次 api.getTrip('101')，第二次会拿到 undefined 而抛 TypeError，
    // 断言就会误报（这是测试桩的坑，不是实现的坑）。
    respondWith({ code: 0, message: 'ok', data: null });
    const api = createHttpClient();

    const pending = api.getTrip('101');
    await expect(pending).rejects.toBeInstanceOf(ApiError);
    await expect(pending).rejects.toThrow('响应 data 为空');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('列表信封 {items,meta} 仍被正确拆包', async () => {
    respondWith({
      code: 0,
      message: 'ok',
      data: {
        items: [
          {
            id: '101',
            familyId: '10',
            title: '青岛亲子游',
            status: 'PLANNED',
            startDate: '2026-10-01T00:00:00.000Z',
            endDate: '2026-10-03T00:00:00.000Z',
            version: 2,
          },
        ],
        meta: { total: 1 },
      },
    });
    const api = createHttpClient();

    const trips = await api.listTrips();
    expect(trips).toHaveLength(1);
    expect(trips[0]?.title).toBe('青岛亲子游');
    expect(trips[0]?.startDate).toBe('2026-10-01');
  });
});

describe('行程更新信封（PATCH → {trip,updatedAt}）', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('updateTrip 需拆一层 {trip}，否则会得到 id 为空的空行程', async () => {
    respondWith({
      code: 0,
      message: 'ok',
      data: {
        trip: {
          id: '101',
          familyId: '10',
          title: '青岛亲子游（改期版）',
          status: 'PLANNED',
          startDate: '2026-10-02T00:00:00.000Z',
          endDate: '2026-10-05T00:00:00.000Z',
          destinationsJson: JSON.stringify([{ name: '西安' }]),
          version: 3,
        },
        updatedAt: '2026-10-15T08:00:00.000Z',
      },
    });
    const api = createHttpClient();

    const trip = await api.updateTrip('101', { version: 2, title: '青岛亲子游（改期版）' });
    expect(trip.id).toBe('101');
    expect(trip.title).toBe('青岛亲子游（改期版）');
    expect(trip.version).toBe(3);
    expect(trip.startDate).toBe('2026-10-02');
    expect(trip.destinations).toEqual([{ name: '西安' }]);
  });
});
