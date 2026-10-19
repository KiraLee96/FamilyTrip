/**
 * 真实微信 exchanger（`createJscode2SessionExchanger` / `resolveWechatExchanger`）测试
 * ============================================================================
 * 🔴 这里守的是**本次线上事故的根因**：开发桩把 code 当 openid，每次登录
 *    都是新 openid → 新用户行 → "我的"页永远默认值。真实实现的契约是
 *    「同一微信用户 → 稳定 openid」，且失败必须分档（凭证被拒 4010 /
 *    上游不可用 5000），否则客户端无法判断该重登还是该重试。
 */

import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../../common/errors/error-code.js';
import { createJscode2SessionExchanger, resolveWechatExchanger } from './wechat-jscode2session.js';

/** 最小 Response 形状 —— exchanger 只消费 json()，不依赖完整 DOM Response 类型 */
interface FakeResponse {
  json(): Promise<unknown>;
}

/** 造一个返回固定 JSON 的假 fetch；calls 计数用于断言重试次数 */
function fakeFetch(
  body: unknown,
  opts: { calls?: { n: number }; status?: number } = {},
): typeof fetch {
  const impl = async (): Promise<FakeResponse> => {
    if (opts.calls !== undefined) opts.calls.n += 1;
    return { json: async () => body };
  };
  return vi.fn(impl) as unknown as typeof fetch;
}

describe('createJscode2SessionExchanger · 成功路径', () => {
  it('成功兑换：返回 openid（无 unionid）', async () => {
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ openid: 'oX123', session_key: 'sk' }),
    });

    await expect(exchanger.exchange('code-abc')).resolves.toEqual({ openid: 'oX123' });
  });

  it('成功兑换：带 unionid 时一并返回', async () => {
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ openid: 'oX123', unionid: 'uX9' }),
    });

    await expect(exchanger.exchange('code-abc')).resolves.toEqual({
      openid: 'oX123',
      unionid: 'uX9',
    });
  });

  it('请求 URL 带齐 appid / secret / js_code / grant_type 四参', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string): Promise<FakeResponse> => {
      seen.push(url);
      return { json: async () => ({ openid: 'oX' }) };
    }) as unknown as typeof fetch;

    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-appid',
      secret: 'sec-value',
      fetchImpl,
    });
    await exchanger.exchange('the-code');

    expect(seen).toHaveLength(1);
    const url = new URL(seen[0]!);
    expect(url.origin + url.pathname).toBe('https://api.weixin.qq.com/sns/jscode2session');
    expect(url.searchParams.get('appid')).toBe('wx-appid');
    expect(url.searchParams.get('secret')).toBe('sec-value');
    expect(url.searchParams.get('js_code')).toBe('the-code');
    expect(url.searchParams.get('grant_type')).toBe('authorization_code');
  });
});

describe('createJscode2SessionExchanger · 微信明确拒绝（4010，不重试）', () => {
  it('errcode=40029（code 无效）→ UNAUTHORIZED，且只请求一次', async () => {
    const calls = { n: 0 };
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ errcode: 40029, errmsg: 'invalid code' }, { calls }),
    });

    await expect(exchanger.exchange('bad-code')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCode.UNAUTHORIZED,
    });
    // 凭证被拒重试无意义 —— 必须一次定失败
    expect(calls.n).toBe(1);
  });

  it('errcode=40163（code 已复用）→ UNAUTHORIZED', async () => {
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ errcode: 40163, errmsg: 'code been used' }),
    });

    await expect(exchanger.exchange('used-code')).rejects.toMatchObject({
      name: 'AppError',
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('errcode=45011（限频）→ UNAUTHORIZED', async () => {
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ errcode: 45011, errmsg: 'freq limit' }),
    });

    await expect(exchanger.exchange('c')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });
});

describe('createJscode2SessionExchanger · 上游不可用（5000，带重试）', () => {
  it('传输失败：重试 1 次后仍失败 → INTERNAL_ERROR，共请求 2 次', async () => {
    const calls = { n: 0 };
    const fetchImpl = vi.fn(async () => {
      calls.n += 1;
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl,
    });

    await expect(exchanger.exchange('c')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(calls.n).toBe(2);
  });

  it('传输失败后第二次成功 → 放行（重试生效）', async () => {
    const calls = { n: 0 };
    const fetchImpl = vi.fn(async (): Promise<FakeResponse> => {
      calls.n += 1;
      if (calls.n === 1) throw new TypeError('fetch failed');
      return { json: async () => ({ openid: 'oX-retry' }) };
    }) as unknown as typeof fetch;

    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl,
    });

    await expect(exchanger.exchange('c')).resolves.toEqual({ openid: 'oX-retry' });
    expect(calls.n).toBe(2);
  });

  it('微信 -1 系统繁忙：可重试；耗尽后 → INTERNAL_ERROR（不是 4010）', async () => {
    const calls = { n: 0 };
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ errcode: -1, errmsg: 'system error' }, { calls }),
    });

    await expect(exchanger.exchange('c')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(calls.n).toBe(2);
  });

  it('200 但缺 openid（契约破坏）→ INTERNAL_ERROR，不重试', async () => {
    const calls = { n: 0 };
    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl: fakeFetch({ session_key: 'sk' }, { calls }),
    });

    await expect(exchanger.exchange('c')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(calls.n).toBe(1);
  });

  it('超时：abort 后按传输失败重试，耗尽 → INTERNAL_ERROR', async () => {
    const calls = { n: 0 };
    // 永不 resolve，只在 signal abort 时 reject —— 真实超时形态
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls.n += 1;
      return new Promise<FakeResponse>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });
    }) as unknown as typeof fetch;

    const exchanger = createJscode2SessionExchanger({
      appid: 'wx-test',
      secret: 's3cret',
      fetchImpl,
      timeoutMs: 10,
    });

    await expect(exchanger.exchange('c')).rejects.toMatchObject({
      code: ErrorCode.INTERNAL_ERROR,
    });
    expect(calls.n).toBe(2);
  });
});

describe('resolveWechatExchanger · 环境分流', () => {
  it('开发态 + 两者皆缺 → undefined（组合根回落 stubWechat，行为不变）', () => {
    expect(resolveWechatExchanger({ NODE_ENV: 'development' })).toBeUndefined();
    expect(resolveWechatExchanger({})).toBeUndefined();
  });

  it('生产 + 两者皆缺 → 拒绝启动（正是线上事故的形态）', () => {
    expect(() => resolveWechatExchanger({ NODE_ENV: 'production' })).toThrow(/WECHAT_APPID/);
  });

  it('只配其中一个 → 拒绝启动（半配置比不配置更危险）', () => {
    expect(() => resolveWechatExchanger({ WECHAT_APPID: 'wx-x', NODE_ENV: 'development' })).toThrow(
      /成对/,
    );
    expect(() => resolveWechatExchanger({ WECHAT_SECRET: 'sec', NODE_ENV: 'development' })).toThrow(
      /成对/,
    );
  });

  it('成对配置（生产）→ 真实 exchanger，走通一次成功兑换', async () => {
    const exchanger = resolveWechatExchanger({
      NODE_ENV: 'production',
      WECHAT_APPID: 'wx-real',
      WECHAT_SECRET: 'real-secret',
    });
    expect(exchanger).toBeDefined();

    // 用注入 fetch 的同参数实例验证行为（resolve 出来的实例用全局 fetch，无法在此打桩）
    const stubbed = createJscode2SessionExchanger({
      appid: 'wx-real',
      secret: 'real-secret',
      fetchImpl: fakeFetch({ openid: 'oStable' }),
    });
    await expect(stubbed.exchange('code')).resolves.toEqual({ openid: 'oStable' });
  });

  it('空白值（空格）视为未配置', () => {
    expect(resolveWechatExchanger({ WECHAT_APPID: '  ', WECHAT_SECRET: '  ' })).toBeUndefined();
    expect(() =>
      resolveWechatExchanger({ NODE_ENV: 'production', WECHAT_APPID: '  ', WECHAT_SECRET: '  ' }),
    ).toThrow(/WECHAT_APPID/);
  });
});
