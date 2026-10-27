/**
 * 心愿投票 · 信封回归（2026-10-27）
 * ============================================================================
 * 用户反馈：「心愿池无法投票」。
 *
 * 根因：`POST /wishes/:id/vote` 的真实信封是
 *   `{ wishId, voteCount, votedByMe }`  —— **只回计票结果，不回整个 wish**
 * 而客户端按 `{ wish }` 读 → `r.wish` 为 undefined → `toWish(undefined)` 抛 TypeError
 * → 页面的 `catch {}` 把它吞掉 → **界面毫无反应**。
 *
 * 🔴 为什么必须写用例：这个误读在首页、规划页、心愿池页**各写了一遍**，
 *    三处一起错、一起静默。只有把「信封形状」钉死在测试里，
 *    才不会下次改契约时又漏一处。
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

import { createHttpClient } from '../http';

function respondWith(env: unknown): void {
  requestSpy.mockResolvedValueOnce({ statusCode: 200, data: env });
}

describe('voteWish · 服务端只回计票结果', () => {
  it('把 { voteCount, votedByMe } 映射成 { votes, votedByMe }，且不抛错', async () => {
    requestSpy.mockReset();
    respondWith({
      code: 0,
      message: 'ok',
      data: { wishId: '9', voteCount: 7, votedByMe: true },
    });

    const api = createHttpClient();
    // 🔴 以前这里会抛 TypeError（toWish(undefined)），被页面空 catch 吞掉
    const r = await api.voteWish('9');

    expect(r.votes).toBe(7);
    expect(r.votedByMe).toBe(true);

    // 请求路径与入参也一并钉住：vote:true 是幂等语义的前提
    const [init, path] = requestSpy.mock.calls[0] as [
      { url?: string; data?: { vote?: boolean } },
      string?,
    ];
    expect(init.data?.vote).toBe(true);
    expect(String(init.url ?? '')).toContain('/wishes/9/vote');
    void path;
  });

  it('服务端字段缺失时不炸（降级为 0 / false，避免整页挂掉）', async () => {
    requestSpy.mockReset();
    respondWith({ code: 0, message: 'ok', data: { wishId: '9' } });

    const api = createHttpClient();
    await expect(api.voteWish('9')).resolves.toEqual({ votes: 0, votedByMe: false });
  });

  it('业务错误照常上抛（不能被吞成"成功"）', async () => {
    requestSpy.mockReset();
    respondWith({ code: 4040, message: '资源不存在', data: null, meta: {} });

    const api = createHttpClient();
    await expect(api.voteWish('9')).rejects.toMatchObject({ code: 4040 });
  });
});
