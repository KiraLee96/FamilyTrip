/**
 * D-2026-10-26-03 · 列宽守卫：枚举字面量必须装得进对应列
 * ============================================================================
 * 为什么需要这条测试（这是线上一次 P0 500 的止血带）：
 *
 *   `trip_member.access_level` 建成 VARCHAR(16)，而代码写的是
 *   `'HISTORICAL_READONLY'`（19 字符）—— MySQL 严格模式直接 1406
 *   「Data too long」，整个 `finish` 事务回滚 → `POST /trips/:id/finish` 恒 500。
 *
 *   这一层**内存驱动永远测不出来**：它不校验列宽、不校验 SQL 方言，
 *   于是 24 个测试文件全绿、线上必炸。同类隐患还有
 *   `{expense,booking,itinerary_item}.rate_source VARCHAR(8)` ← `'SAME_CURRENCY'`（13）。
 *
 * 本测试守的不变量（纯静态，不需要 MySQL）：
 *   ① schema.prisma 里每个 `String @db.VarChar(n)` 列，宽度 n 已知；
 *   ② 源码里形如 `field: 'UPPER_CASE'` 或 `field: SOME_CONST`（常量值也是大写字面量）
 *      的赋值，其值长度必须 ≤ 该字段名下所有模型的**最小**宽度。
 *
 * ⚠️ 覆盖面声明（别高估它）：
 *   · 只覆盖「大写枚举字面量」这一种形态；拼出来的字符串（模板串 / 变量）覆盖不到；
 *   · 同名字段取跨模型最小宽度（保守，宁可误报）；
 *   · 真要彻底兜住这一层，仍需 CI 起 MySQL 容器跑迁移（本单 §5 建议，另单推进）。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/server（本测试位于 apps/server/test/ 下） */
const SERVER_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface ScannerResult {
  /** 字段名 → 跨模型最小 VarChar 宽度 */
  widths: Map<string, number>;
  /** 字段名 → 源码里出现过的枚举字面量 */
  values: Map<string, Set<string>>;
  /** 列宽总数（用于基线断言，防止解析退化） */
  varcharColumns: number;
}

function scanVarCharWidths(): { widths: Map<string, number>; columns: number } {
  const schema = readFileSync(join(SERVER_ROOT, 'prisma/schema.prisma'), 'utf8');
  const widths = new Map<string, number>();
  let columns = 0;

  for (const line of schema.split('\n')) {
    const m = /^\s*(\w+)\s+String\??\s.*@db\.VarChar\((\d+)\)/.exec(line);
    if (!m) continue;
    const field = m[1];
    const raw = m[2];
    if (field === undefined || raw === undefined) continue;
    const width = Number(raw);
    columns += 1;
    const prev = widths.get(field);
    widths.set(field, prev === undefined ? width : Math.min(prev, width));
  }
  return { widths, columns };
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (name.endsWith('.ts') && !name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

function scanEnumLiterals(files: readonly string[]): Map<string, Set<string>> {
  // 先建常量表：`const ACTIVE_RATE_TIER = 'SPOT_SELL'` 这类间接写法也要能追到值
  const consts = new Map<string, string>();
  const texts: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    texts.push(text);
    for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) {
      consts.set(m[1]!, m[2]!);
    }
  }

  const values = new Map<string, Set<string>>();
  const add = (field: string, value: string): void => {
    const set = values.get(field);
    if (set) set.add(value);
    else values.set(field, new Set([value]));
  };

  for (const text of texts) {
    // 直接字面量：`accessLevel: 'HISTORICAL_READONLY'`
    for (const m of text.matchAll(/\b(\w+)\s*:\s*'([A-Z][A-Z0-9_]*)'/g)) {
      add(m[1]!, m[2]!);
    }
    // 常量引用：`tier: ACTIVE_RATE_TIER`（排除函数调用 / 类型位置）
    for (const m of text.matchAll(/\b(\w+)\s*:\s*([A-Z][A-Z0-9_]{2,})\b(?!\s*[(.<])/g)) {
      const value = consts.get(m[2]!);
      if (value !== undefined) add(m[1]!, value);
    }
  }
  return values;
}

function scan(): ScannerResult {
  const { widths, columns } = scanVarCharWidths();
  const values = scanEnumLiterals(collectSourceFiles(join(SERVER_ROOT, 'src')));
  return { widths, values, varcharColumns: columns };
}

describe('D-2026-10-26-03 · 枚举字面量 vs 列宽（内存驱动测不出的那一层）', () => {
  const result = scan();

  it('扫描基线有效（防止正则退化导致「什么都没扫到」的假绿）', () => {
    expect(result.varcharColumns).toBeGreaterThan(50);
    expect(result.widths.get('accessLevel')).toBeTypeOf('number');
    expect(result.widths.get('rateSource')).toBeTypeOf('number');
    // 这两个值必须被扫到，否则说明源码扫描失效
    expect(result.values.get('accessLevel')?.has('HISTORICAL_READONLY')).toBe(true);
    expect(result.values.get('rateSource')?.has('SAME_CURRENCY')).toBe(true);
  });

  it('每个枚举字面量都装得进对应列（否则真库 1406 → 整事务回滚 → 500）', () => {
    const violations: string[] = [];
    for (const [field, set] of result.values) {
      const width = result.widths.get(field);
      if (width === undefined) continue; // 不是 DB 列（业务对象 / 局部变量），不管
      for (const value of set) {
        if (value.length > width) {
          violations.push(`${field} = '${value}'（${value.length} 字符）> VARCHAR(${width})`);
        }
      }
    }
    expect(violations, `列宽溢出：\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  it('回归钉：历史事故的两个列宽不得回退', () => {
    // access_level 要装 HISTORICAL_READONLY(19)；rate_source 要装 SAME_CURRENCY(13)
    expect(result.widths.get('accessLevel') ?? 0).toBeGreaterThanOrEqual(19);
    expect(result.widths.get('rateSource') ?? 0).toBeGreaterThanOrEqual(13);
  });
});
