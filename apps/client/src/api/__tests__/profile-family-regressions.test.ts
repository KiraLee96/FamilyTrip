/**
 * 账号 / 家庭网络层回归（真后端模式）
 * ============================================================================
 * 覆盖 2026-11-05 用户反馈中「前端可独立修复」的三处确定性缺陷：
 *
 *   ⑤ 改名后下次登录又没了 —— GET /auth/me 的 data 是 `{ user }`，
 *      旧实现把包裹层当裸 user 投影，得到空 id/空昵称并覆盖本地会话。
 *   ② 家庭成员变 2 人标签仍是 1 人 —— 后端 listMine 不返回 memberCount，
 *      旧实现 `|| 1` 恒回退；现在用详情 members.length 补齐。
 *
 * 测试直接驱动 createHttpClient，只桩掉 Taro.request；信封解析、拆包、
 * 投影、并发补齐全部走真实实现。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestSpy = vi.fn();

vi.mock('@tarojs/taro', () => ({
  default: {
    request: (...args: unknown[]) => requestSpy(...args) as unknown,
    removeStorageSync: (): void => undefined,
    setStorageSync: (): void => undefined,
  },
}));

import { createHttpClient } from '../http';

function respondWith(env: unknown): void {
  requestSpy.mockResolvedValueOnce({ statusCode: 200, data: env });
}

function ok(data: unknown): Record<string, unknown> {
  return { code: 0, message: 'ok', data };
}

const USER = {
  id: '1',
  nickname: '雪珂',
  avatarUrl: 'https://api.example.com/media-files/a/1/avatar.jpg',
  homeTimezone: 'Asia/Shanghai',
};

const MEMBERS = [
  {
    id: 'm1',
    familyId: '10',
    userId: '1',
    role: 'OWNER',
    isVirtual: false,
    managedBy: null,
    displayName: '雪珂',
    joinedAt: '2026-11-01T00:00:00.000Z',
  },
  {
    id: 'm2',
    familyId: '10',
    userId: '2',
    role: 'MEMBER',
    isVirtual: false,
    managedBy: null,
    displayName: '家人',
    joinedAt: '2026-11-02T00:00:00.000Z',
  },
];

describe('/auth/me 拆包（反馈⑤：改名重登丢失）', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('GET 返回 {user} 时投影出真实昵称与头像，而不是空对象', async () => {
    respondWith(ok({ user: USER }));
    const api = createHttpClient();

    const u = await api.me();

    expect(u.id).toBe('1');
    expect(u.nickname).toBe('雪珂');
    expect(u.avatarUrl).toBe(USER.avatarUrl);
    expect(u.homeTimezone).toBe('Asia/Shanghai');
  });

  it('兼容极老后端直接返回裸 user 行', async () => {
    respondWith(ok(USER));
    const api = createHttpClient();

    await expect(api.me()).resolves.toMatchObject({ id: '1', nickname: '雪珂' });
  });

  it('PATCH 返回 {user,updatedAt} 时回传新昵称并带上请求体', async () => {
    respondWith(
      ok({ user: { ...USER, nickname: '新昵称' }, updatedAt: '2026-11-05T00:00:00.000Z' }),
    );
    const api = createHttpClient();

    const u = await api.updateMe({ nickname: '新昵称' });

    expect(u.nickname).toBe('新昵称');
    const [req] = requestSpy.mock.calls[0] as [{ method: string; data: { nickname?: string } }];
    expect(req.method).toBe('PATCH');
    expect(req.data.nickname).toBe('新昵称');
  });
});

describe('家庭人数（反馈②：2 人仍显示 1 人）', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('详情成员数组覆盖 family 行缺省的 memberCount', async () => {
    respondWith(
      ok({
        family: { id: '10', name: '周末出游', ownerId: '1', inviteCode: 'ABC123' },
        members: MEMBERS,
      }),
    );
    const api = createHttpClient();

    const detail = await api.getFamily('10');

    expect(detail.members).toHaveLength(2);
    expect(detail.family.memberCount).toBe(2);
  });

  it('listFamilies 在后端不返回 memberCount 时并发拉详情补齐', async () => {
    respondWith(
      ok({
        items: [{ id: '10', name: '周末出游', ownerId: '1', myRole: 'OWNER' }],
        meta: { total: 1 },
      }),
    );
    respondWith(
      ok({
        family: { id: '10', name: '周末出游', ownerId: '1' },
        members: MEMBERS,
      }),
    );
    const api = createHttpClient();

    const families = await api.listFamilies();

    expect(families).toHaveLength(1);
    expect(families[0]?.memberCount).toBe(2);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('详情请求失败时保留列表口径，不让整个家庭列表挂掉', async () => {
    respondWith(ok({ items: [{ id: '10', name: '周末出游', ownerId: '1' }], meta: {} }));
    requestSpy.mockRejectedValueOnce(new Error('网络异常'));
    const api = createHttpClient();

    const families = await api.listFamilies();

    expect(families).toHaveLength(1);
    expect(families[0]?.memberCount).toBe(1);
  });
});
