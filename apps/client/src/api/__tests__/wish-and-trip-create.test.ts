/**
 * 「提心愿」与「创建行程带目的地」的 Mock 链路回归（2026-10-22 验收反馈）
 * ============================================================================
 * 覆盖两条本次修复的写入路径：
 *
 *   1. `POST /wishes`：用户反馈「提心愿点不动」。根因是按钮只 setState 无表单，
 *      但真正的新增能力（api.createWish）此前也不存在。这里直接驱动 Mock 实现，
 *      断言「写进去的能被下一次读出来」——防止出现「接口返回成功、列表还是旧数据」。
 *   2. `POST /trips` 的 `destinations`：新增「允许用户选择地区」，创建时就要带上目的地。
 *
 * Mock 实现不依赖 Taro（不 request、不 storage），因此可在 Node 里直接跑。
 */

import { describe, expect, it } from 'vitest';

import { createMockClient } from '../mock';

const api = createMockClient();

describe('createWish · 提心愿', () => {
  it('写入后能被 listWishes 读到，且字段口径与后端一致', async () => {
    const before = await api.listWishes('10');

    const wish = await api.createWish({
      familyId: '10',
      title: '验收：秋天去看日落',
      description: '10 月中旬，找个西向的海边',
    });

    expect(wish.title).toBe('验收：秋天去看日落');
    // 服务端字段 description → 客户端模型 note（投影在 http 层，Mock 保持同口径）
    expect(wish.note).toBe('10 月中旬，找个西向的海边');
    expect(wish.votes).toBe(0);
    expect(wish.votedByMe).toBe(false);
    expect(wish.status).toBe('OPEN');
    expect(wish.familyId).toBe('10');

    const after = await api.listWishes('10');
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((w) => w.id)).toContain(wish.id);
  });

  it('新心愿排在列表最前（用户提交后立刻能看到自己写的）', async () => {
    const wish = await api.createWish({ familyId: '10', title: '排序验证' });
    const list = await api.listWishes('10');
    expect(list[0]?.id).toBe(wish.id);
  });

  it('不传 description 时不产生空 note（避免界面渲染一行空白）', async () => {
    const wish = await api.createWish({ familyId: '10', title: '只写标题' });
    expect(wish.note).toBeUndefined();
  });

  it('重复标题允许存在（心愿本来就可能是同一件事的不同表述）', async () => {
    const a = await api.createWish({ familyId: '10', title: '重复标题' });
    const b = await api.createWish({ familyId: '10', title: '重复标题' });
    expect(a.id).not.toBe(b.id);
  });
});

describe('createTrip · destinations', () => {
  it('创建时带目的地，返回体与详情读回一致', async () => {
    const trip = await api.createTrip({
      familyId: '10',
      title: '验收：带目的地的行程',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      destinations: [{ name: '大理' }, { name: '丽江', note: '古城住一晚' }],
    });

    expect(trip.destinations).toEqual([{ name: '大理' }, { name: '丽江', note: '古城住一晚' }]);

    const readBack = await api.getTrip(trip.id);
    expect(readBack.destinations).toHaveLength(2);
    expect(readBack.destinations?.[1]?.note).toBe('古城住一晚');
    expect(readBack.startDate).toBe('2026-11-01');
    expect(readBack.endDate).toBe('2026-11-05');
  });

  it('不传 destinations 时为空数组（不沿用上一场行程——跨行程串数据的老坑）', async () => {
    const trip = await api.createTrip({ familyId: '10', title: '验收：无目的地' });
    expect(trip.destinations).toEqual([]);
  });

  it('新建行程自动生成本次出行的邀请码（不是复用别的行程）', async () => {
    const a = await api.createTrip({ familyId: '10', title: '邀请码 A' });
    const b = await api.createTrip({ familyId: '10', title: '邀请码 B' });

    const ia = await api.getTripInvite(a.id);
    const ib = await api.getTripInvite(b.id);

    expect(ia.tripId).toBe(a.id);
    expect(ib.tripId).toBe(b.id);
    expect(ia.inviteCode).not.toBe(ib.inviteCode);
    expect(ia.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });
});
