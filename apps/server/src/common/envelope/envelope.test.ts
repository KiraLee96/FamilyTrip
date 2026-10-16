/**
 * 信封 · BigInt 安全出口单测（派发单 D-2026-10-15-02 P0-B）
 * ============================================================================
 * 这组用例的存在理由，正是「旧测试为什么没抓到该缺陷」：
 *   服务端 277 个单测跑的是 MemoryTableDriver，`version` 在那里是 JS number，
 *   `typeof === 'bigint'` 恒假 —— 白名单漏列的 BigInt 列**永远不会**被序列化路径碰到。
 *   真 MySQL 下同一份代码直接 `TypeError` → 500 且丢信封。
 * 因此这里显式构造 BigInt，把「真库才会出现的输入」钉进单测。
 */

import { describe, expect, it } from 'vitest';
import { bigintSafeReplacer, dbTimeToIso, fail, noContent, ok } from './envelope.js';
import { ErrorCode } from '../errors/error-code.js';

/** 与运行期装配方式一致：把 replacer 交给 JSON.stringify */
function stringify(value: unknown): string {
  return JSON.stringify(value, bigintSafeReplacer);
}

describe('envelope · bigintSafeReplacer（BigInt 安全出口）', () => {
  it('回归证明：裸 JSON.stringify 遇 BigInt 直接抛 —— 这就是真库 500 的成因', () => {
    expect(() => JSON.stringify({ version: 3n })).toThrow(TypeError);
  });

  it('version 落到 number —— 与内存驱动口径逐字一致（客户端类型也是 number）', () => {
    const parsed = JSON.parse(stringify({ version: 3n })) as Record<string, unknown>;
    expect(parsed['version']).toBe(3);
    expect(typeof parsed['version']).toBe('number');
  });

  it('安全整数范围内的取值输出 number', () => {
    const parsed = JSON.parse(stringify({ id: 101n, rateBy: null })) as Record<string, unknown>;
    expect(parsed['id']).toBe(101);
    expect(parsed['rateBy']).toBeNull();
  });

  it('超出安全整数范围不丢精度，降级为字符串', () => {
    const huge = 9007199254740993n; // 2^53 + 1，Number 无法精确表示
    const parsed = JSON.parse(stringify({ id: huge })) as Record<string, unknown>;
    expect(parsed['id']).toBe('9007199254740993');
    expect(parsed['id']).toBe(huge.toString());
  });

  it('边界值 2^53-1 仍是 number，2^53 起转字符串', () => {
    const maxSafe = 9007199254740991n; // Number.MAX_SAFE_INTEGER
    const parsed = JSON.parse(stringify({ a: maxSafe, b: maxSafe + 1n })) as Record<
      string,
      unknown
    >;
    expect(parsed['a']).toBe(Number.MAX_SAFE_INTEGER);
    expect(typeof parsed['a']).toBe('number');
    expect(parsed['b']).toBe('9007199254740992');
    expect(typeof parsed['b']).toBe('string');
  });

  it('非 BigInt 值原样透传，不做任何转型', () => {
    const payload = { n: 7, s: '7', b: true, z: null, o: { x: 1 }, a: [1, '2'] };
    const parsed = JSON.parse(stringify(payload)) as Record<string, unknown>;
    expect(parsed['n']).toBe(7);
    expect(parsed['s']).toBe('7');
    expect(parsed['b']).toBe(true);
    expect(parsed['z']).toBeNull();
    expect(parsed['o']).toEqual({ x: 1 });
    expect(parsed['a']).toEqual([1, '2']);
  });

  it('嵌套结构（data / 数组 / meta）里的 BigInt 一并覆盖', () => {
    const env = ok(
      { trip: { id: 101n, version: 3n }, members: [{ id: 201n, managedBy: null }] },
      { total: 1, cursor: 'c1' },
    );
    const parsed = JSON.parse(stringify(env)) as {
      code: number;
      data: { trip: Record<string, unknown>; members: Array<Record<string, unknown>> };
      meta: Record<string, unknown>;
    };
    expect(parsed.code).toBe(0);
    expect(parsed.data.trip).toEqual({ id: 101, version: 3 });
    expect(parsed.data.members).toEqual([{ id: 201, managedBy: null }]);
    expect(parsed.meta).toEqual({ total: 1, cursor: 'c1' });
  });

  it('失败信封与 204 语义信封保持同形且可序列化', () => {
    const notFound = JSON.parse(stringify(fail(ErrorCode.NOT_FOUND, '资源不存在'))) as Record<
      string,
      unknown
    >;
    expect(notFound).toEqual({
      code: ErrorCode.NOT_FOUND,
      message: '资源不存在',
      data: null,
    });

    const empty = JSON.parse(
      stringify(noContent({ updatedAt: dbTimeToIso(new Date('2026-10-15T00:00:00.000Z')) })),
    ) as Record<string, unknown>;
    expect(empty['code']).toBe(0);
    expect(empty['data']).toBeNull();
  });
});
