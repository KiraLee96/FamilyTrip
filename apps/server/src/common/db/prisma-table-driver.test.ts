/**
 * `PrismaTableDriver` 单元测试
 * ============================================================================
 * 为什么用「记录式 Mock Prisma」而不是连真库：
 *
 *   本适配器的**全部风险**在于「`TableDriver` 方言 → Prisma 查询对象」的翻译
 *   是否精确。这类缺陷的特点是 **type-check 全过、连真库也可能看似正常**，
 *   但在特定 where 组合下静默查错（例如把 `{ OR: [...] }` 当成列等值 → 恒空）。
 *
 *   真库集成测试能发现「连不上/字段名错」，但发现不了「翻译语义偏移」——
 *   因为那需要一个能对照预期 SQL 的断言点。记录式 Mock 正好提供这个断言点：
 *   它把「驱动实际发给 Prisma 的查询对象」原样捕获下来，逐字段比对。
 *
 * 覆盖点：
 *   · update → updateMany（CAS 语义，返回 count）
 *   · findUnique → findFirst（非唯一选择器）
 *   · where：标量等值 / null / Date / 数组→in
 *   · where：未知操作符必须**抛错**而非静默降级
 *   · orderBy / take / skip 透传
 *   · dbNow 走 SELECT NOW(3)
 *   · run() 事务：body 内所有操作复用同一个 tx 客户端（不回退外层）
 *   · run() 事务：body 抛错 → 异常向上传播（由 Prisma 负责回滚）
 *   · 未知模型名 → 明确报错
 */

import { describe, expect, it, vi } from 'vitest';
import { PrismaTableDriver } from './prisma-table-driver.js';
import type { TableDriver } from './table-client.js';

// ─────────────────────────────────────────────────────────────────────────────
// 记录式 Mock
// ─────────────────────────────────────────────────────────────────────────────

interface CallRecord {
  model: string;
  method: string;
  args: unknown;
}

/**
 * 造一个假 PrismaClient。
 *
 * @param opts.rows           findFirst / findMany / count 的返回值
 * @param opts.updateCount    updateMany 返回的 count
 * @param opts.nowValue       $queryRaw 返回的 NOW(3)
 * @param opts.txRows         （仅 run 内）事务客户端返回的行；用于验证 tx 走了哪个客户端
 */
function makeFakePrisma(
  opts: {
    rows?: unknown[];
    updateCount?: number;
    nowValue?: Date;
    txRows?: unknown[];
    models?: readonly string[];
  } = {},
): {
  prisma: Record<string, unknown>;
  calls: CallRecord[];
  seenBy: Array<{ call: CallRecord; client: string }>;
} {
  const calls: CallRecord[] = [];
  /** 标记「用的是哪个客户端」：'outer' 还是 'tx' */
  const seenBy: Array<{ call: CallRecord; client: string }> = [];

  const nowValue = opts.nowValue ?? new Date('2026-10-10T12:00:00.000Z');
  const models = opts.models ?? ['booking', 'item', 'familyMember', 'changeLog', 'exchangeRate'];

  /** 每张表造一组委托；每次调用都记录（含「用的是外层还是 tx 客户端」） */
  function buildDelegates(clientTag: 'outer' | 'tx'): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const model of models) {
      const record = (method: string, args: unknown): void => {
        const call = { model, method, args };
        calls.push(call);
        seenBy.push({ call, client: clientTag });
      };
      out[model] = {
        create: (args: unknown) => {
          record('create', args);
          return Promise.resolve({});
        },
        findFirst: (args: unknown) => {
          record('findFirst', args);
          const src = clientTag === 'tx' ? (opts.txRows ?? opts.rows) : opts.rows;
          return Promise.resolve(src?.[0] ?? null);
        },
        findMany: (args: unknown) => {
          record('findMany', args);
          const src = clientTag === 'tx' ? (opts.txRows ?? opts.rows) : opts.rows;
          return Promise.resolve(src ?? []);
        },
        updateMany: (args: unknown) => {
          record('updateMany', args);
          return Promise.resolve({ count: opts.updateCount ?? 1 });
        },
        count: (args: unknown) => {
          record('count', args);
          return Promise.resolve(opts.rows?.length ?? 0);
        },
      };
    }
    return out;
  }

  const prisma = {
    ...buildDelegates('outer'),
    $queryRaw: (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      calls.push({ model: '$raw', method: '$queryRaw', args: null });
      return Promise.resolve([{ now: nowValue }]);
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => {
      calls.push({ model: '$raw', method: '$transaction', args: null });
      return fn({ ...buildDelegates('tx') });
    },
    $disconnect: () => Promise.resolve(),
  };

  return { prisma, calls, seenBy };
}

const asDriver = (fake: ReturnType<typeof makeFakePrisma>): TableDriver =>
  new PrismaTableDriver(fake.prisma as never);

// ─────────────────────────────────────────────────────────────────────────────
// update → updateMany（CAS 语义）
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · update 走 updateMany（E7 CAS 语义）', () => {
  it('CAS 的 {id, version, deletedAt} 非唯一选择器被原样翻译，且返回 count', async () => {
    const fake = makeFakePrisma({ updateCount: 1 });
    const driver = asDriver(fake);

    const affected = await driver.update(
      'booking',
      { id: 100n, version: 3, deletedAt: null },
      { title: '改后', version: 4 },
    );

    expect(affected).toBe(1);
    const call = fake.calls.find((c) => c.method === 'updateMany');
    expect(call).toBeDefined();
    expect(call!.args).toEqual({
      where: { id: 100n, version: 3, deletedAt: null },
      data: { title: '改后', version: 4 },
    });
  });

  it('CAS 失配（0 行）时 count 为 0 —— 上层据此抛 409', async () => {
    const fake = makeFakePrisma({ updateCount: 0 });
    const driver = asDriver(fake);

    const affected = await driver.update('item', { id: 1n, version: 9 }, { version: 10 });
    expect(affected).toBe(0);
  });

  it('绝不调用 Prisma 的 update（它只收唯一选择器）', async () => {
    const fake = makeFakePrisma({ models: ['booking'] });
    const driver = asDriver(fake);

    // 给 mock 加一个 update 探针：若驱动误用 update 就会打到它
    const spy = vi.fn();
    (fake.prisma as unknown as Record<string, Record<string, unknown>>)['booking']!['update'] = spy;

    await driver.update('booking', { id: 1n, version: 1 }, { version: 2 });
    expect(spy).not.toHaveBeenCalled();
    expect(fake.calls.some((c) => c.method === 'updateMany')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findUnique → findFirst
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · findUnique 走 findFirst', () => {
  it('非唯一组合选择器可用（{familyId,userId,role,deletedAt}）', async () => {
    const fake = makeFakePrisma({ rows: [{ id: 7n, role: 'OWNER' }] });
    const driver = asDriver(fake);

    const row = await driver.findUnique('familyMember', {
      familyId: 1n,
      userId: 2n,
      role: 'OWNER',
      deletedAt: null,
    });

    expect(row).toEqual({ id: 7n, role: 'OWNER' });
    const call = fake.calls.find((c) => c.method === 'findFirst');
    expect(call!.args).toEqual({
      where: { familyId: 1n, userId: 2n, role: 'OWNER', deletedAt: null },
    });
  });

  it('无命中返回 null（而非 undefined）', async () => {
    const fake = makeFakePrisma({ rows: [] });
    const driver = asDriver(fake);
    const row = await driver.findUnique('item', { id: 404n });
    expect(row).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// where 方言翻译
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · where 方言翻译', () => {
  it('空 where → {}（不是 undefined）', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog', { where: {} });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: {} });
  });

  it('省略 options → where 仍为 {}', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog');
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: {} });
  });

  it('数组值 → in 语义', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('item', { where: { ownerId: [1n, 2n, 3n] } });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { ownerId: { in: [1n, 2n, 3n] } } });
  });

  it('空数组 → in: []（保持恒假语义，不特殊处理）', async () => {
    const fake = makeFakePrisma({ rows: [] });
    const rows = await asDriver(fake).findMany('item', { where: { ownerId: [] } });
    expect(rows).toEqual([]);
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { ownerId: { in: [] } } });
  });

  it('null 值 → 等值 null（软删过滤）', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('booking', { where: { deletedAt: null } });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { deletedAt: null } });
  });

  it('Date 值 → 原样透传（不被误判为操作符对象）', async () => {
    const fake = makeFakePrisma();
    const at = new Date('2026-10-10T00:00:00.000Z');
    await asDriver(fake).findMany('exchangeRate', { where: { rateDate: at } });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { rateDate: at } });
  });

  it('🔴 未登记的操作符必须抛错，绝不静默透传', async () => {
    const fake = makeFakePrisma();
    const driver = asDriver(fake);

    // startsWith 不是已登记操作符 → 整个对象被判定为「无法识别的取值」
    await expect(
      driver.findMany('changeLog', { where: { changedAt: { startsWith: 'x' } } }),
    ).rejects.toThrow(/无法识别的对象取值/);
    expect(fake.calls.some((c) => c.method === 'findMany')).toBe(false);
  });

  it('🔴 已登记操作符名但取值非法组合时仍走翻译路径', async () => {
    const fake = makeFakePrisma();
    const driver = asDriver(fake);

    // gt 已登记，因此进入操作符翻译；但若键全为 undefined 则拒绝
    await expect(
      driver.findMany('changeLog', { where: { changedAt: { gt: undefined } } }),
    ).rejects.toThrow(/操作符对象为空/);
  });

  it('🔴 无法识别的对象取值必须抛错（不静默当等值）', async () => {
    const fake = makeFakePrisma();
    const driver = asDriver(fake);

    await expect(
      driver.findMany('changeLog', { where: { changedAt: { foo: 1, bar: 2 } } }),
    ).rejects.toThrow(/无法识别的对象取值/);
    expect(fake.calls.some((c) => c.method === 'findMany')).toBe(false);
  });

  it('操作符对象全为 undefined 时抛错（避免条件被静默放宽）', async () => {
    const fake = makeFakePrisma();
    const driver = asDriver(fake);

    await expect(
      driver.findMany('changeLog', { where: { changedAt: { gt: undefined } } }),
    ).rejects.toThrow(/操作符对象为空/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 区间操作符与逻辑组合（同步游标所需）
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · 区间操作符', () => {
  it('gt 透传为 Prisma 的 gt', async () => {
    const fake = makeFakePrisma();
    const at = new Date('2026-10-10T00:00:00.000Z');
    await asDriver(fake).findMany('changeLog', { where: { changedAt: { gt: at } } });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { changedAt: { gt: at } } });
  });

  it('多操作符组合（gte + lte）同时透传', async () => {
    const fake = makeFakePrisma();
    const a = new Date('2026-10-01T00:00:00.000Z');
    const b = new Date('2026-10-31T00:00:00.000Z');
    await asDriver(fake).findMany('changeLog', { where: { changedAt: { gte: a, lte: b } } });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { changedAt: { gte: a, lte: b } } });
  });

  it('not 透传', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('item', { where: { status: { not: 'DELETED' } } });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { status: { not: 'DELETED' } } });
  });

  it('操作符对象内的 in 透传', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('item', { where: { ownerId: { in: [1n, 2n] } } });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { ownerId: { in: [1n, 2n] } } });
  });
});

describe('PrismaTableDriver · 逻辑组合（复合游标）', () => {
  it('buildCursorPredicate 的 OR 结构被正确翻译', async () => {
    const fake = makeFakePrisma();
    const at = new Date('2026-10-10T12:00:00.000Z');

    // 这正是 buildCursorPredicate 的产出形态
    await asDriver(fake).findMany('changeLog', {
      where: {
        OR: [{ changedAt: { gt: at } }, { changedAt: at, id: { gt: 100n } }],
        familyId: { in: [7n] },
      },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      take: 101,
    });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({
      where: {
        OR: [{ changedAt: { gt: at } }, { changedAt: at, id: { gt: 100n } }],
        familyId: { in: [7n] },
      },
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
      take: 101,
    });
  });

  it('AND 递归翻译', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog', {
      where: { AND: [{ familyId: 1n }, { tripId: { not: null } }] },
    });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: { AND: [{ familyId: 1n }, { tripId: { not: null } }] } });
  });

  it('嵌套 OR 内的 OR 也递归翻译', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog', {
      where: { OR: [{ OR: [{ id: 1n }, { id: 2n }] }, { id: 3n }] },
    });

    const call = fake.calls.find((c) => c.method === 'findMany');
    // 标量 bigint 保持标量；只有数组才转成 in
    expect(call!.args).toEqual({
      where: { OR: [{ OR: [{ id: 1n }, { id: 2n }] }, { id: 3n }] },
    });
  });

  it('OR 传非数组时抛错', async () => {
    const fake = makeFakePrisma();
    await expect(
      asDriver(fake).findMany('changeLog', { where: { OR: { changedAt: 1 } } }),
    ).rejects.toThrow(/'OR' 必须是子句数组/);
  });

  it('空 AND 数组被丢弃（恒真，等价于无条件）', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog', { where: { AND: [] } });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: {} });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orderBy / take / skip
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · 排序与分页透传', () => {
  it('orderBy + take + skip 原样翻译', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('familyMember', {
      where: { familyId: 1n, deletedAt: null },
      orderBy: [{ joinedAt: 'asc' }],
      take: 50,
      skip: 10,
    });

    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({
      where: { familyId: 1n, deletedAt: null },
      orderBy: [{ joinedAt: 'asc' }],
      take: 50,
      skip: 10,
    });
  });

  it('orderBy 为空数组时不产生 orderBy 键（避免 Prisma 报错）', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('item', { orderBy: [] });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: {} });
  });

  it('多字段降序 orderBy 透传', async () => {
    const fake = makeFakePrisma();
    await asDriver(fake).findMany('changeLog', {
      orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    });
    const call = fake.calls.find((c) => c.method === 'findMany');
    expect(call!.args).toEqual({ where: {}, orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dbNow
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · dbNow 取 DB 时钟', () => {
  it('返回 $queryRaw 的 NOW(3) 结果', async () => {
    const at = new Date('2026-10-10T08:30:00.123Z');
    const fake = makeFakePrisma({ nowValue: at });

    const now = await asDriver(fake).dbNow();
    expect(now).toEqual(at);
    expect(fake.calls.some((c) => c.method === '$queryRaw')).toBe(true);
  });

  it('$queryRaw 无返回行时抛错（不静默回退应用时钟）', async () => {
    const fake = makeFakePrisma({ models: ['item'] });
    // 覆盖 $queryRaw 返回空数组
    (fake.prisma)['$queryRaw'] = () => Promise.resolve([]);

    await expect(asDriver(fake).dbNow()).rejects.toThrow(/未返回任何行/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 事务
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · run() 事务', () => {
  it('body 内的操作全部落在同一个 tx 客户端上', async () => {
    const fake = makeFakePrisma({ rows: [{ id: 1n }] });
    const driver = new PrismaTableDriver(fake.prisma as never);

    await driver.run(async (tx) => {
      await tx.insert('booking', { id: 1n });
      await tx.findUnique('booking', { id: 1n });
      await tx.update('booking', { id: 1n, version: 1 }, { version: 2 });
    });

    const writeCalls = fake.seenBy.filter((s) => s.call.model === 'booking');
    expect(writeCalls.length).toBe(3);
    // 🔴 全部必须走 'tx' 客户端；有一个走 'outer' 就意味着脱离了事务
    expect(writeCalls.every((s) => s.client === 'tx')).toBe(true);
    expect(fake.calls.some((c) => c.method === '$transaction')).toBe(true);
  });

  it('body 返回值原样透出', async () => {
    const fake = makeFakePrisma({ txRows: [{ id: 42n, name: '甲' }] });
    const driver = new PrismaTableDriver(fake.prisma as never);

    const result = await driver.run(async (tx) => {
      const row = await tx.findUnique('item', { id: 42n });
      return row?.['name'];
    });

    expect(result).toBe('甲');
  });

  it('body 抛错时异常向上传播（回滚交由 Prisma）', async () => {
    const fake = makeFakePrisma();
    const driver = new PrismaTableDriver(fake.prisma as never);

    await expect(
      driver.run(async () => {
        throw new Error('业务校验失败');
      }),
    ).rejects.toThrow('业务校验失败');
  });

  it('事务内 CAS 的 0 行结果可被正确观测', async () => {
    const fake = makeFakePrisma({ updateCount: 0 });
    const driver = new PrismaTableDriver(fake.prisma as never);

    const affected = await driver.run(async (tx) =>
      tx.update('item', { id: 1n, version: 5, deletedAt: null }, { version: 6 }),
    );
    expect(affected).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 模型名守卫
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · 模型名守卫', () => {
  it('未知模型名抛错并列出已知模型', async () => {
    const fake = makeFakePrisma({ models: ['item'] });
    const driver = asDriver(fake);

    // 白名单守卫先于委托查找触发，错误信息里带上已知清单便于排查
    await expect(driver.findMany('totallyWrongModel')).rejects.toThrow(
      /'totallyWrongModel' 不在已知模型清单内。已知: item。/,
    );
  });

  it('构造时自动推导已知模型清单（排除 $ / _ 前缀）', async () => {
    const fake = makeFakePrisma({ models: ['item', 'booking'] });
    // 混入 Prisma 的内部属性，验证被正确排除
    (fake.prisma)['_engine'] = {};
    (fake.prisma)['$connect'] = () => Promise.resolve();

    const driver = new PrismaTableDriver(fake.prisma as never);
    // 下划线前缀的内部属性不在白名单里 → 命中守卫
    await expect(driver.findMany('_engine')).rejects.toThrow(/'_engine' 不在已知模型清单内/);
    // 正常模型不受影响
    await expect(driver.findMany('item')).resolves.toEqual([]);
  });

  it('显式传入白名单时，清单外模型被拒', async () => {
    const fake = makeFakePrisma({ models: ['item', 'booking'] });
    const driver = new PrismaTableDriver(fake.prisma as never, ['item']);

    await expect(driver.findMany('booking')).rejects.toThrow(/'booking' 不在已知模型清单内/);
    await expect(driver.findMany('item')).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dump 有意不实现
// ─────────────────────────────────────────────────────────────────────────────

describe('PrismaTableDriver · dump 不实现（设计决定）', () => {
  it('dump 为 undefined —— 生产不暴露整表快照', () => {
    const fake = makeFakePrisma();
    const driver = new PrismaTableDriver(fake.prisma as never);
    expect('dump' in driver).toBe(false);
  });
});
