/**
 * 驱动语义一致性测试（`MemoryTableDriver` ≡ `PrismaTableDriver`）
 * ============================================================================
 * 🔴 为什么这个测试最重要：
 *
 *   整套「域代码只依赖 `TableDriver` 接口」的可替换性承诺，**全部押在**
 *   「两个驱动对同一输入给出同一结果」上。若二者语义有偏差，就会出现
 *   最坏的情况：**测试全绿（跑内存驱动）、生产错值（跑 Prisma 驱动）**。
 *
 *   所以这里不测「各自的行为」，而是测「二者是否一致」：
 *   同一批种子数据 + 同一批查询，两个驱动必须返回同样的行（按 id 排序后比对）。
 *
 * 实现方式：
 *   `MemoryTableDriver` 是真驱动；`PrismaTableDriver` 后面挂一个
 *   「把 where/orderBy/take/skip 在内存里执行」的假 Prisma —— 但它**不是**
 *   复制内存驱动的逻辑，而是走 `PrismaTableDriver` 自己的 `toPrismaWhere` /
 *   `toPrismaOrderBy` 翻译，再由假 Prisma 按「Prisma 语义」执行。
 *   这样若翻译层写错（例如把 null 翻成 undefined），两边就会分叉。
 */

import { describe, expect, it } from 'vitest';
import { MemoryTableDriver, type Row, type TableDriver, type Where } from './table-client.js';
import { PrismaTableDriver } from './prisma-table-driver.js';

// ─────────────────────────────────────────────────────────────────────────────
// 假 Prisma：按「Prisma 查询对象语义」在内存里执行
// ─────────────────────────────────────────────────────────────────────────────

type Db = Record<string, Row[]>;

/** 判断单行是否满足**已翻译过的** Prisma where */
function rowMatchesPrisma(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = cond as Array<Record<string, unknown>>;
      if (clauses.length === 0) return false; // SQL: OR 空集恒假
      if (!clauses.some((c) => rowMatchesPrisma(row, c))) return false;
      continue;
    }
    if (key === 'AND') {
      const clauses = cond as Array<Record<string, unknown>>;
      if (!clauses.every((c) => rowMatchesPrisma(row, c))) return false;
      continue;
    }

    const actual = row[key] ?? null;

    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const ops = cond as Record<string, unknown>;
      if ('in' in ops) {
        const list = ops['in'] as unknown[];
        if (!list.some((x) => eq(x, actual))) return false;
        continue;
      }
      if ('gt' in ops && !(cmp(actual, ops['gt']) > 0)) return false;
      if ('gte' in ops && !(cmp(actual, ops['gte']) >= 0)) return false;
      if ('lt' in ops && !(cmp(actual, ops['lt']) < 0)) return false;
      if ('lte' in ops && !(cmp(actual, ops['lte']) <= 0)) return false;
      if ('not' in ops && eq(ops['not'], actual)) return false;
      continue;
    }

    if (!eq(cond, actual)) return false;
  }
  return true;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return toComparableKey(a) === toComparableKey(b);
  return false;
}

/**
 * 归一化成可比较的字符串键。
 *
 * ⚠️ 不能对 unknown 直接用模板串 / `String()` —— 对象会得到 `"[object Object]"`，
 *    让不同值被判为相等（这正是 `row-key.ts` 要根除的静默错值）。
 *    这里只接受标量，其余显式拒绝。
 */
function toComparableKey(v: unknown): string {
  if (typeof v === 'bigint') return v.toString(10);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return String(v);
  if (v === null || v === undefined) return '\u0000null';
  throw new Error(`parity.test: 不支持比较非标量值: ${Object.prototype.toString.call(v)}`);
}

function cmp(a: unknown, b: unknown): number {
  const na = a instanceof Date ? a.getTime() : typeof a === 'bigint' ? Number(a) : (a as number);
  const nb = b instanceof Date ? b.getTime() : typeof b === 'bigint' ? Number(b) : (b as number);
  if (typeof na === 'number' && typeof nb === 'number') return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = toComparableKey(a);
  const sb = toComparableKey(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 造一个假 Prisma，把已翻译的查询对象按 Prisma 语义执行 */
function fakePrismaOver(db: Db, nowValue: Date): Record<string, unknown> {
  const models = Object.keys(db);
  const client: Record<string, unknown> = {};

  const delegate = (model: string): Record<string, unknown> => ({
    create: ({ data }: { data: Row }) => {
      const table = db[model] ?? (db[model] = []);
      if (table.some((r) => eq(r['id'], data['id']))) {
        return Promise.reject(new Error('unique constraint'));
      }
      table.push({ ...data });
      return Promise.resolve({});
    },
    findFirst: ({ where }: { where: Record<string, unknown> }) => {
      const rows = (db[model] ?? []).filter((r) => rowMatchesPrisma(r, where));
      return Promise.resolve(rows[0] === undefined ? null : rows[0]);
    },
    findMany: ({ where, orderBy, take, skip }: Record<string, unknown>) => {
      let rows = (db[model] ?? []).filter((r) => rowMatchesPrisma(r, where as Record<string, unknown>));
      const ob = orderBy as Array<Record<string, 'asc' | 'desc'>> | undefined;
      if (ob !== undefined && ob.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const clause of ob) {
            for (const [f, dir] of Object.entries(clause)) {
              const r = cmp(a[f], b[f]);
              if (r !== 0) return dir === 'desc' ? -r : r;
            }
          }
          return 0;
        });
      }
      if (typeof skip === 'number') rows = rows.slice(skip);
      if (typeof take === 'number') rows = rows.slice(0, take);
      return Promise.resolve(rows.map((r) => ({ ...r })));
    },
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Row }) => {
      let count = 0;
      for (const row of db[model] ?? []) {
        if (!rowMatchesPrisma(row, where)) continue;
        for (const [k, v] of Object.entries(data)) if (k !== 'id') row[k] = v;
        count += 1;
      }
      return Promise.resolve({ count });
    },
    count: ({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve((db[model] ?? []).filter((r) => rowMatchesPrisma(r, where)).length),
  });

  for (const m of models) client[m] = delegate(m);
  client['$queryRaw'] = () => Promise.resolve([{ now: nowValue }]);
  client['$transaction'] = (fn: (tx: unknown) => Promise<unknown>) => {
    // 简化：不实现真回滚（本测试只比对查询语义，不测回滚）
    const txClient: Record<string, unknown> = {};
    for (const m of models) txClient[m] = delegate(m);
    return fn(txClient);
  };
  client['$disconnect'] = () => Promise.resolve();

  return client;
}

// ─────────────────────────────────────────────────────────────────────────────
// 种子数据
// ─────────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-10T12:00:00.000Z');

const SEED: Db = {
  wish: [
    { id: 1n, familyId: 10n, title: '看海', status: 'OPEN', deletedAt: null, createdBy: 100n },
    { id: 2n, familyId: 10n, title: '爬山', status: 'DONE', deletedAt: null, createdBy: 100n },
    { id: 3n, familyId: 20n, title: '滑雪', status: 'OPEN', deletedAt: null, createdBy: 200n },
    { id: 4n, familyId: 20n, title: '已删', status: 'OPEN', deletedAt: NOW, createdBy: 200n },
  ],
  changeLog: [
    { id: 1n, entityType: 'wish', familyId: 10n, tripId: null, changedAt: new Date('2026-10-10T10:00:00.000Z') },
    { id: 2n, entityType: 'wish', familyId: 10n, tripId: null, changedAt: new Date('2026-10-10T10:00:00.000Z') },
    { id: 3n, entityType: 'trip', familyId: null, tripId: 30n, changedAt: new Date('2026-10-10T11:00:00.000Z') },
    { id: 4n, entityType: 'item', familyId: 20n, tripId: null, changedAt: new Date('2026-10-10T11:00:00.000Z') },
  ],
  item: [
    { id: 1n, ownerId: 100n, familyId: 10n, name: '雨伞', qty: 1, deletedAt: null },
    { id: 2n, ownerId: 100n, familyId: 10n, name: '帽子', qty: 2, deletedAt: null },
    { id: 3n, ownerId: 200n, familyId: 20n, name: '手套', qty: 5, deletedAt: null },
  ],
};

/** 复制种子（两个驱动各自独立一份，避免互相污染） */
const cloneSeed = (): Db =>
  Object.fromEntries(Object.entries(SEED).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));

function makeMemory(): TableDriver {
  const d = new MemoryTableDriver({ freezeAt: NOW });
  for (const [model, rows] of Object.entries(cloneSeed())) d.seed(model, rows);
  return d;
}

function makePrisma(): TableDriver {
  return new PrismaTableDriver(fakePrismaOver(cloneSeed(), NOW) as never);
}

/** 按 id 稳定排序，便于比对 */
const byId = (rows: Row[]): Row[] => [...rows].sort((a, b) => Number(a['id']) - Number(b['id']));

// ─────────────────────────────────────────────────────────────────────────────
// 一致性断言
// ─────────────────────────────────────────────────────────────────────────────

/** 同一 where 在两个驱动上必须返回同一批行 */
async function expectSameRows(
  model: string,
  where: Where,
  options?: { take?: number; skip?: number },
): Promise<Row[]> {
  const mem = await makeMemory().findMany(model, {
    where,
    ...(options?.take !== undefined ? { take: options.take } : {}),
    ...(options?.skip !== undefined ? { skip: options.skip } : {}),
  });
  const pri = await makePrisma().findMany(model, {
    where,
    ...(options?.take !== undefined ? { take: options.take } : {}),
    ...(options?.skip !== undefined ? { skip: options.skip } : {}),
  });
  expect(byId(pri)).toEqual(byId(mem));
  return byId(mem);
}

describe('驱动语义一致性 · 等值 / null', () => {
  it('等值过滤一致', async () => {
    const rows = await expectSameRows('wish', { familyId: 10n, deletedAt: null });
    expect(rows.length).toBe(2);
  });

  it('null 等值（软删过滤）一致', async () => {
    const rows = await expectSameRows('wish', { deletedAt: null });
    expect(rows.length).toBe(3);
  });

  it('非 null 判定：deletedAt 不等于 null 的行', async () => {
    const rows = await expectSameRows('wish', { deletedAt: { not: null } });
    expect(rows.length).toBe(1);
    expect(rows[0]!['id']).toBe(4n);
  });

  it('多字段组合一致', async () => {
    const rows = await expectSameRows('wish', { familyId: 20n, status: 'OPEN', deletedAt: null });
    expect(rows.length).toBe(1);
  });

  it('无匹配返回空数组一致', async () => {
    const rows = await expectSameRows('wish', { familyId: 999n });
    expect(rows).toEqual([]);
  });
});

describe('驱动语义一致性 · IN（数组）', () => {
  it('数组 → IN 一致', async () => {
    const rows = await expectSameRows('changeLog', { familyId: [10n, 20n] });
    expect(rows.length).toBe(3);
  });

  it('单元素数组一致', async () => {
    const rows = await expectSameRows('changeLog', { familyId: [10n] });
    expect(rows.length).toBe(2);
  });

  it('🔴 空数组两边都恒假（不是「不过滤」）', async () => {
    const rows = await expectSameRows('changeLog', { familyId: [] });
    expect(rows).toEqual([]);
  });
});

describe('驱动语义一致性 · 区间操作符', () => {
  it('gt 一致', async () => {
    const t = new Date('2026-10-10T10:30:00.000Z');
    const rows = await expectSameRows('changeLog', { changedAt: { gt: t } });
    expect(rows.length).toBe(2);
  });

  it('gte 一致（含边界）', async () => {
    const t = new Date('2026-10-10T10:00:00.000Z');
    const rows = await expectSameRows('changeLog', { changedAt: { gte: t } });
    expect(rows.length).toBe(4);
  });

  it('lt 一致', async () => {
    const t = new Date('2026-10-10T11:00:00.000Z');
    const rows = await expectSameRows('changeLog', { changedAt: { lt: t } });
    expect(rows.length).toBe(2);
  });

  it('lte 一致', async () => {
    const t = new Date('2026-10-10T11:00:00.000Z');
    const rows = await expectSameRows('changeLog', { changedAt: { lte: t } });
    expect(rows.length).toBe(4);
  });

  it('gt + lt 组合（开区间）一致', async () => {
    const a = new Date('2026-10-10T09:00:00.000Z');
    const b = new Date('2026-10-10T11:00:00.000Z');
    const rows = await expectSameRows('changeLog', { changedAt: { gt: a, lt: b } });
    expect(rows.length).toBe(2);
  });

  it('not 一致', async () => {
    const rows = await expectSameRows('wish', { status: { not: 'OPEN' } });
    expect(rows.length).toBe(1);
    expect(rows[0]!['status']).toBe('DONE');
  });
});

describe('驱动语义一致性 · 逻辑组合（复合游标）', () => {
  it('🔴 buildCursorPredicate 的 OR 结构两边一致 —— 这是同步正确性的核心', async () => {
    const at = new Date('2026-10-10T10:00:00.000Z');
    const afterId = 1n;

    // 与 buildCursorPredicate 完全同构的产出
    const predicate: Where = {
      OR: [{ changedAt: { gt: at } }, { changedAt: at, id: { gt: afterId } }],
    };

    const rows = await expectSameRows('changeLog', predicate);
    // 期望：id=2（同毫秒但 id 更大）、id=3、id=4；id=1 被排除
    expect(rows.map((r) => r['id'])).toEqual([2n, 3n, 4n]);
  });

  it('OR 叠加范围限定（游标 + 可见家庭）一致', async () => {
    const at = new Date('2026-10-10T09:00:00.000Z');
    const rows = await expectSameRows('changeLog', {
      OR: [{ changedAt: { gt: at } }, { changedAt: at, id: { gt: 0n } }],
      familyId: { in: [10n] },
    });
    expect(rows.map((r) => r['id'])).toEqual([1n, 2n]);
  });

  it('AND 组合一致', async () => {
    const rows = await expectSameRows('changeLog', {
      AND: [{ familyId: 10n }, { changedAt: { gte: new Date('2026-10-10T10:00:00.000Z') } }],
    });
    expect(rows.length).toBe(2);
  });

  it('🔴 空 OR 两边都恒假', async () => {
    const rows = await expectSameRows('changeLog', { OR: [] });
    expect(rows).toEqual([]);
  });

  it('🔴 空 AND 两边都恒真（等价于无该条件）', async () => {
    const rows = await expectSameRows('changeLog', { AND: [] });
    expect(rows.length).toBe(4);
  });
});

describe('驱动语义一致性 · 排序与分页', () => {
  it('🔥 orderBy 多字段升序一致（游标分页依赖）', async () => {
    const mem = await makeMemory().findMany('changeLog', { orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    const pri = await makePrisma().findMany('changeLog', { orderBy: [{ changedAt: 'asc' }, { id: 'asc' }] });
    // 排序结果必须逐行相同（不能只是集合相同）
    expect(pri.map((r) => r['id'])).toEqual(mem.map((r) => r['id']));
    expect(mem.map((r) => r['id'])).toEqual([1n, 2n, 3n, 4n]);
  });

  it('orderBy 降序一致', async () => {
    const mem = await makeMemory().findMany('changeLog', { orderBy: [{ id: 'desc' }] });
    const pri = await makePrisma().findMany('changeLog', { orderBy: [{ id: 'desc' }] });
    expect(pri.map((r) => r['id'])).toEqual(mem.map((r) => r['id']));
    expect(mem.map((r) => r['id'])).toEqual([4n, 3n, 2n, 1n]);
  });

  it('take 一致', async () => {
    const rows = await expectSameRows('changeLog', {}, { take: 2 });
    expect(rows.length).toBe(2);
  });

  it('skip + take 一致（分页切片）', async () => {
    const mem = await makeMemory().findMany('changeLog', {
      orderBy: [{ id: 'asc' }],
      skip: 1,
      take: 2,
    });
    const pri = await makePrisma().findMany('changeLog', {
      orderBy: [{ id: 'asc' }],
      skip: 1,
      take: 2,
    });
    expect(pri.map((r) => r['id'])).toEqual(mem.map((r) => r['id']));
    expect(mem.map((r) => r['id'])).toEqual([2n, 3n]);
  });
});

describe('驱动语义一致性 · findUnique / update（CAS）', () => {
  it('findUnique 同条件取同一行', async () => {
    const mem = await makeMemory().findUnique('wish', { familyId: 10n, status: 'DONE', deletedAt: null });
    const pri = await makePrisma().findUnique('wish', { familyId: 10n, status: 'DONE', deletedAt: null });
    expect(pri).toEqual(mem);
  });

  it('findUnique 无命中两边都是 null', async () => {
    expect(await makeMemory().findUnique('wish', { id: 999n })).toBeNull();
    expect(await makePrisma().findUnique('wish', { id: 999n })).toBeNull();
  });

  it('🔴 CAS 命中：两边 affected 都是 1，且数据同步更新', async () => {
    const mem = makeMemory();
    const pri = makePrisma();

    const memAffected = await mem.update('wish', { id: 1n, status: 'OPEN', deletedAt: null }, { status: 'DONE' });
    const priAffected = await pri.update('wish', { id: 1n, status: 'OPEN', deletedAt: null }, { status: 'DONE' });

    expect(memAffected).toBe(1);
    expect(priAffected).toBe(1);
    expect((await mem.findUnique('wish', { id: 1n }))!['status']).toBe('DONE');
    expect((await pri.findUnique('wish', { id: 1n }))!['status']).toBe('DONE');
  });

  it('🔴 CAS 失配（version 对不上）：两边 affected 都是 0，且数据不变', async () => {
    const mem = makeMemory();
    const pri = makePrisma();

    // 用一个不存在的 version 触发失配
    const memAffected = await mem.update('wish', { id: 1n, version: 999 }, { version: 1000 });
    const priAffected = await pri.update('wish', { id: 1n, version: 999 }, { version: 1000 });

    expect(memAffected).toBe(0);
    expect(priAffected).toBe(0);
    // 数据必须没被改动
    expect((await mem.findUnique('wish', { id: 1n }))!['version']).toBeUndefined();
    expect((await pri.findUnique('wish', { id: 1n }))!['version']).toBeUndefined();
  });

  it('CAS 作用于已被软删的行：两边都拒绝（affected=0）', async () => {
    const mem = makeMemory();
    const pri = makePrisma();

    const memAffected = await mem.update('wish', { id: 4n, deletedAt: null }, { status: 'DONE' });
    const priAffected = await pri.update('wish', { id: 4n, deletedAt: null }, { status: 'DONE' });

    expect(memAffected).toBe(0);
    expect(priAffected).toBe(0);
  });
});

describe('驱动语义一致性 · dbNow', () => {
  it('两边返回同一冻结时刻', async () => {
    const mem = await makeMemory().dbNow();
    const pri = await makePrisma().dbNow();
    expect(pri).toEqual(mem);
    expect(mem).toEqual(NOW);
  });
});

describe('驱动语义一致性 · count', () => {
  it('count 带条件一致', async () => {
    expect(await makePrisma().count('wish', { deletedAt: null })).toBe(
      await makeMemory().count('wish', { deletedAt: null }),
    );
  });

  it('count 无参数一致', async () => {
    expect(await makePrisma().count('wish')).toBe(await makeMemory().count('wish'));
  });
});
