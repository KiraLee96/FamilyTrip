/**
 * 一次性审计脚本（不入库）：扫出「代码里写了比列宽更长的字面量」这类
 * 内存驱动测不出、真库必报 1406 的隐患。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const schemaPath = process.env.SCHEMA_PATH ?? join(root, 'prisma/schema.prisma');
const schema = readFileSync(schemaPath, 'utf8');
console.log('schema:', schemaPath);

// 1) 解析 model → { field: varcharWidth }
const models = new Map();
let current = null;
for (const line of schema.split('\n')) {
  const m = /^model\s+(\w+)\s*\{/.exec(line);
  if (m) {
    current = { name: m[1], fields: {} };
    models.set(m[1], current);
    continue;
  }
  if (current && /^\}/.test(line)) {
    current = null;
    continue;
  }
  if (!current) continue;
  const f = /^\s*(\w+)\s+String\??.*@db\.VarChar\((\d+)\)/.exec(line);
  if (f) current.fields[f[1]] = Number(f[2]);
}

// 2) 收集 src 里 `field: 'UPPER_CASE_LITERAL'`
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(full);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
  }
})(join(root, 'src'));

const lits = new Map(); // field -> Set(values)
const consts = new Map(); // CONST_NAME -> literal
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*'([A-Z][A-Z0-9_]*)'/g)) {
    consts.set(m[1], m[2]);
  }
}
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\b(\w+)\s*:\s*'([A-Z][A-Z0-9_]*)'/g)) {
    const [, field, value] = m;
    if (!lits.has(field)) lits.set(field, new Set());
    lits.get(field).add(value);
  }
  // 常量引用形态：`tier: ACTIVE_RATE_TIER`
  for (const m of text.matchAll(/\b(\w+)\s*:\s*([A-Z][A-Z0-9_]{2,})\b(?!\s*\()/g)) {
    const [, field, name] = m;
    const value = consts.get(name);
    if (value === undefined) continue;
    if (!lits.has(field)) lits.set(field, new Set());
    lits.get(field).add(value);
  }
}

// 3) 比对：同名字段取所有 model 的最小宽度（保守）
const widthOf = new Map();
for (const model of models.values()) {
  for (const [field, w] of Object.entries(model.fields)) {
    const prev = widthOf.get(field);
    widthOf.set(field, prev === undefined ? w : Math.min(prev, w));
  }
}

const bad = [];
for (const [field, values] of lits) {
  const w = widthOf.get(field);
  if (w === undefined) continue;
  for (const v of values) {
    if (v.length > w) bad.push({ field, value: v, len: v.length, width: w });
  }
}

console.log('VarChar 列数：', [...models.values()].reduce((n, m) => n + Object.keys(m.fields).length, 0));
if (bad.length === 0) console.log('✅ 未发现超宽字面量');
else {
  console.log(`❌ 发现 ${bad.length} 处超宽：`);
  for (const b of bad) console.log(`  ${b.field} = '${b.value}'（${b.len} 字符）> VARCHAR(${b.width})`);
}
