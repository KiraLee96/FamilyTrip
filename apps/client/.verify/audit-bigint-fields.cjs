/**
 * 审计：各域 `*_BIGINT_FIELDS` 是否覆盖其实际序列化模型的全部 BigInt 列
 * ============================================================================
 * 背景（2026-10-15 真后端验收发现）：
 *   服务端响应统一走 `res.json(envelope)`，而 `JSON.stringify` 遇到 BigInt 直接抛
 *   `TypeError: Do not know how to serialize a BigInt` → HTTP 500 **且不走信封**
 *   （响应体退化成 Nest 默认 `{statusCode:500,...}`，客户端信封解析全乱）。
 *   各域靠 `serializeRow(row, X_BIGINT_FIELDS)` 白名单把 BigInt 转 string。
 *
 *   单测跑的是 MemoryTableDriver —— 行以 JS 对象落内存，`version` 等列是 number，
 *   `typeof v === 'bigint'` 恒 false → **白名单漏列在单测里永远不暴露**；
 *   真 MySQL（Prisma）下 BigInt 列回的就是 BigInt → 一漏即 500。
 *
 *   首个实证实例：`TRIP_BIGINT_FIELDS` 漏 `version`
 *   （schema: `version BigInt @default(1) @db.UnsignedBigInt`）
 *   → 真后端 POST /trips、GET /trips、GET /trips/:id、PATCH /trips/:id 全部 500。
 *
 * 关联口径（避免误报）：对每一处 `serializeRow(x, CONST)` 调用，
 *   取**其所在函数体**内出现的模型名（insert/findUnique/findMany/update/findFirst），
 *   再与该模型在 schema.prisma 中声明的 BigInt 列求差集。
 *
 * 用法：CI=true node .verify/audit-bigint-fields.cjs
 * 退出码：有漏列则非 0
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
const SRC = path.join(SERVER, 'src');

// ── 1. Prisma schema：模型 → BigInt 列 ─────────────────────────────
const schemaText = fs.readFileSync(path.join(SERVER, 'prisma', 'schema.prisma'), 'utf8');
const models = new Map();
for (const m of schemaText.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
  const [, name, body] = m;
  const bigints = new Set();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('@@')) continue;
    const f = t.match(/^(\w+)\s+BigInt(\?|\[\])?/);
    if (f) bigints.add(f[1]);
  }
  models.set(name, bigints);
}

// ── 2. 文件遍历 ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

/** 取 pos 所在的函数体文本（向上找最近的函数签名，再花括号配对） */
function enclosingBody(text, pos) {
  const sigRe = /(?:async\s+)?[\w$]+\s*\([^)]*\)\s*(?::[^{;]*)?\{/g;
  let best = -1;
  let m;
  while ((m = sigRe.exec(text)) !== null) {
    if (m.index > pos) break;
    best = m.index + m[0].length - 1; // '{' 位置
  }
  if (best < 0) return text.slice(0, pos);
  let depth = 0;
  for (let i = best; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(best, i + 1);
    }
  }
  return text.slice(best);
}

const findings = [];
let callSites = 0;
const perConst = new Map(); // constName -> Set<model>

for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(SERVER, file).replace(/\\/g, '/');

  for (const m of text.matchAll(/serializeRow\(\s*[^,]+,\s*(\w+BIGINT_FIELDS)\s*\)/g)) {
    const constName = m[1];
    callSites++;
    const body = enclosingBody(text, m.index);

    const usedModels = new Set();
    for (const mm of body.matchAll(/\.(?:insert|findUnique|findMany|update|findFirst)\(\s*'(\w+)'/g)) {
      usedModels.add(mm[1]);
    }

    for (const modelName of usedModels) {
      const key = modelName.charAt(0).toUpperCase() + modelName.slice(1);
      const declared = models.get(key);
      if (!declared) continue;

      const cg = perConst.get(constName) ?? { covered: null, models: new Set() };
      cg.models.add(key);
      perConst.set(constName, cg);

      // 常量定义（同文件内查找）
      const defRe = new RegExp(`const\\s+${constName}\\s*=\\s*\\[([^\\]]*)\\]`);
      const def = text.match(defRe);
      const covered = def ? [...def[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
      cg.covered = covered;

      const missing = [...declared].filter((f) => !covered.includes(f));
      if (missing.length > 0) {
        findings.push({
          file: rel,
          constName,
          model: key,
          declared: [...declared],
          covered,
          missing,
        });
      }
    }
  }
}

// ── 3. 报告 ────────────────────────────────────────────────────────
console.log('===== BigInt 序列化白名单审计 =====\n');
console.log(`Prisma 模型 ${models.size} 个 | serializeRow 调用点 ${callSites} 处 | 常量 ${perConst.size} 个\n`);

const seen = new Set();
const uniq = findings.filter((f) => {
  const k = `${f.constName}|${f.model}|${f.missing.join(',')}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (uniq.length === 0) {
  console.log('✅ 未发现漏列');
  process.exit(0);
}

console.log(`❌ 发现 ${uniq.length} 处「模型 BigInt 列未被白名单覆盖」`);
console.log('   （真 MySQL 下命中即 500，且响应不走信封）\n');

for (const f of uniq) {
  console.log(`  ${f.file}`);
  console.log(`    ${f.constName} ← 模型 ${f.model}`);
  console.log(`    模型 BigInt 列: ${f.declared.join(', ')}`);
  console.log(`    白名单覆盖    : ${f.covered.join(', ') || '(空)'}`);
  console.log(`    🔴 漏         : ${f.missing.join(', ')}\n`);
}

// 汇总每个常量受影响的模型
console.log('--- 按常量汇总 ---');
for (const [name, info] of perConst) {
  if (!info.covered) continue;
  const hit = uniq.filter((f) => f.constName === name);
  if (hit.length === 0) continue;
  console.log(`  ${name}: 覆盖模型 ${[...info.models].join('/')}，漏列模型 ${[...new Set(hit.map((h) => h.model))].join('/')}`);
}

console.log('\n修复方向（二选一或并用）：');
console.log('  A. 把漏列补进对应常量（最小改动）；');
console.log('  B. 在 HTTP 边界加 BigInt 安全序列化兜底 —— `res.json` 前用');
console.log('     JSON.parse(JSON.stringify(env, (k,v)=>typeof v==="bigint"?v.toString():v))，');
console.log('     让漏列退化为「多转一个字段」而不是 500 且丢信封；');
console.log('  C. 长期：白名单改为按 schema 自动派生（本脚本即可作为 CI 门禁）。');
process.exit(1);
