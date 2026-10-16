#!/usr/bin/env node
/**
 * 审计 v3：各域 `*_BIGINT_FIELDS` 是否覆盖其实际序列化模型的全部 BigInt 列
 * ============================================================================
 * 背景（2026-10-15 真后端验收发现，派发单 D-2026-10-15-02）：
 *   服务端响应统一走 `res.json(envelope)`，而 `JSON.stringify` 遇到 BigInt 直接抛
 *   `TypeError: Do not know how to serialize a BigInt` → HTTP 500 **且不走信封**
 *   （响应体退化成 Nest 默认 `{statusCode:500,...}`，客户端信封解析全乱）。
 *   各域靠 `serializeRow(row, X_BIGINT_FIELDS)` 白名单把 BigInt 转 string。
 *
 *   单测跑的是 MemoryTableDriver —— 行以 JS 对象落内存，`version` 等列是 number，
 *   `typeof v === 'bigint'` 恒 false → **白名单漏列在单测里永远不暴露**；
 *   真 MySQL（Prisma）下 BigInt 列回的就是 BigInt → 一漏即 500。
 *
 * 版本演进：
 *   v1 用「函数体内出现的模型名」关联 —— 把只做权限校验的 findMany 误判为
 *      被序列化的模型（大量误报），又把行经**参数传入**的序列化点漏在关联之外（漏报）。
 *   v2 引入行来源追踪 + 策略豁免，但函数体定位被 `if`/`for` 块与复杂签名干扰，
 *      46/63 调用点退化为「不可追踪」，门禁强度不足。
 *   v3 用「注释/字符串/模板/正则清洗 + 花括号栈」做作用域分析，声明追踪覆盖
 *      全部可直接/链式追溯的调用点；不可追踪点（行经函数参数传入）降级为警告。
 *
 * 策略口径（改这里必须同步更新本说明）：
 *   ① `version` 类计数器列**故意不进白名单** —— HTTP 边界兜底
 *      （envelope.ts `bigintSafeReplacer`）对安全整数内的 BigInt 输出 number，
 *      与客户端 `version: number` 契约、内存驱动口径逐字一致；若加进白名单，
 *      真库出 string 而内存驱动出 number，反而制造驱动间口径分叉（本类缺陷的根源）。
 *   ② `changeLog`（审计日志）只写不序列化，行不出现在响应里，无需覆盖。
 *
 * ⚠️ 残留边界（诚实披露）：不可追踪调用点只警告不失败，依赖人工核对 ——
 *    2026-10-16 已全部人工核对并补齐（见 UNTRACEABLE_NOTES）。
 *    对「500」的最终防线是 HTTP 边界兜底 + 真 driver 冒烟（apps/server/.verify/real-driver-smoke.cjs），
 *    本脚本的职责是「显式类型完整度」。
 *
 * 用法：node .verify/audit-bigint-fields.cjs
 * 退出码：有漏列则非 0
 */

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', '..', 'server');
const SRC = path.join(SERVER, 'src');

// ── 1. 策略豁免 ────────────────────────────────────────────────────

/** 计数器列：经 HTTP 边界兜底输出 number（安全整数内），与客户端契约一致。 */
const EXEMPT_COLUMNS = new Set(['version']);

/**
 * 只写不序列化的模型（审计日志类）：行不出现在任何响应里。
 * v3 行来源追踪下这类模型不会被关联到任何 serializeRow 调用点，
 * 本清单目前为空（留作登记处；新增只写模型且被旧版误报时在此登记）。
 */
const WRITE_ONLY_MODELS = new Set();

/** 不可追踪调用点的人工核对备忘（2026-10-16 D-2026-10-15-02 盘点）。 */
const UNTRACEABLE_NOTES = {
  'src/domains/itinerary/itinerary.service.ts':
    'projectBlocks 行经参数传入（ItineraryItem 行）—— 2026-10-16 已人工补 rateBy',
  'src/domains/booking/booking.service.ts':
    'decryptRow 行经参数传入（Booking 行）—— 2026-10-16 已人工补 rateBy',
  'src/domains/memory/memory.service.ts':
    'toListItem 等行经参数传入（MemoryArchive 行，列 id/familyId/refId 已全覆盖）—— 2026-10-16 已人工核对',
  'src/domains/auth/auth.service.ts':
    'session(user) 行经参数传入（User 行，仅 id 一列已覆盖）—— 2026-10-16 已人工核对',
  'src/domains/media/media.service.ts':
    'detail 行经参数传入（MediaAsset 行，列已全覆盖）—— 2026-10-16 已人工核对；' +
    'filePending（预签工单）只写不序列化，presign 只回 fileKey+url，无需白名单',
};

// ── 2. Prisma schema：模型 → BigInt 列 ─────────────────────────────
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

// ── 3. 文件遍历 ────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) out.push(p);
  }
  return out;
}

// ── 4. 词法清洗 + 作用域分析 ───────────────────────────────────────

/**
 * 单遍扫描：把注释 / 字符串 / 模板串 / 正则字面量置为空格（保留长度与位置），
 * 使花括号计数只受真实代码结构影响。模板串整体置空是brace中性的
 * （`${...}` 内的表达式花括号自成平衡）。
 */
function sanitize(text) {
  const out = text.split('');
  const n = text.length;
  let i = 0;
  let prevSig = ''; // 上一个非空白字符（用于辨别 / 是除号还是正则起点）
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) out[k] = ' ';
  };
  while (i < n) {
    const c = text[i];
    const nx = text[i + 1];
    if (c === '/' && nx === '/') {
      while (i < n && text[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && nx === '*') {
      blank(i, i + 2);
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out[i] = ' ';
        i++;
      }
      blank(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      blank(i, i + 1);
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\') {
          out[i] = ' ';
          i++;
        }
        out[i] = ' ';
        i++;
      }
      blank(i, i + 1);
      i++;
      prevSig = c;
      continue;
    }
    if (c === '`') {
      blank(i, i + 1);
      i++;
      while (i < n && text[i] !== '`') {
        if (text[i] === '\\') {
          out[i] = ' ';
          i++;
        }
        out[i] = ' ';
        i++;
      }
      blank(i, i + 1);
      i++;
      prevSig = '`';
      continue;
    }
    if (c === '/' && /[(,=:[!&|?{;]/.test(prevSig)) {
      // 正则字面量：扫到未转义的 /（跳过 [...] 字符类）
      blank(i, i + 1);
      i++;
      let inClass = false;
      while (i < n) {
        if (text[i] === '\\') {
          blank(i, i + 2);
          i += 2;
          continue;
        }
        if (text[i] === '[') inClass = true;
        else if (text[i] === ']') inClass = false;
        else if (text[i] === '/' && !inClass) break;
        else if (text[i] === '\n') break; // 误判为除号时止损
        out[i] = ' ';
        i++;
      }
      blank(i, i + 1);
      i++;
      prevSig = '/';
      continue;
    }
    if (!/\s/.test(c)) prevSig = c;
    i++;
  }
  return out.join('');
}

/**
 * 花括号栈：返回 pos 的所有外层块（由外到内），每块 { open, end, text }。
 * 在清洗后的文本上计数，但块文本取自原文（保留可读性，索引一致）。
 */
function enclosingBlocks(sanitized, original, pos) {
  const stack = [];
  for (let i = 0; i < pos; i++) {
    const c = sanitized[i];
    if (c === '{') stack.push(i);
    else if (c === '}') stack.pop();
  }
  const blocks = [];
  for (const open of stack) {
    let depth = 0;
    let end = sanitized.length - 1;
    for (let i = open; i < sanitized.length; i++) {
      const c = sanitized[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    blocks.push({ open, end, text: original.slice(open, end + 1) });
  }
  return blocks; // 由外到内
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 判断块是否为 class 体（类体会把兄弟方法的声明卷进搜索范围，必须排除）。
 */
function isClassBody(original, block) {
  const before = original.slice(Math.max(0, block.open - 300), block.open);
  return /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[\w$]+[^{}\n]*$/.test(before);
}

/** 在单个块内查找 name 的「最后一条」声明（直接驱动调用），返回模型名或 null */
function directDeclIn(block, name, pos) {
  const re = new RegExp(
    `(?:const|let)\\s+${esc(name)}\\s*=\\s*(?:await\\s+)?[\\w$.]+\\.(?:findUnique|findMany)\\('(\\w+)'`,
    'g',
  );
  let hit = null;
  let m;
  while ((m = re.exec(block.text)) !== null) {
    const at = block.open + m.index;
    if (at >= pos) break;
    hit = m[1];
  }
  return hit;
}

/** 在单个块内查找 name 的链式派生（slice/filter/sort/map/展开/裸赋值），返回源变量或 null */
function chainSourceIn(block, name, pos) {
  // 注意 `\s*` 允许跨行方法链（prettier 会把长链折行）
  const re = new RegExp(
    `(?:const|let\\s+)?${esc(name)}\\s*=\\s*(?:\\[\\.\\.\\.(\\w+)\\]|(\\w+)\\s*\\.\\s*(?:slice|filter|sort|map)\\s*\\()`,
    'g',
  );
  let m;
  while ((m = re.exec(block.text)) !== null) {
    const at = block.open + m.index;
    if (at >= pos) break;
    const src = m[1] ?? m[2];
    if (src) return src;
  }
  return null;
}

/**
 * 从 `.map(` 调用点向前走，取迭代表达式的基变量名。
 * 支持 `x.map(` / `x.slice(..).map(` / `x.filter(..).sort(..).map(`；
 * 遇 `= , : { } ;` 等语句边界即止。向后走时不断覆盖 base，最终取最外层基名。
 */
function iterableBaseBefore(text, dotIdx) {
  let i = dotIdx - 1;
  let base = null;
  const skipWs = () => {
    while (i >= 0 && /\s/.test(text[i])) i--;
  };
  for (;;) {
    skipWs();
    if (i < 0) break;
    const c = text[i];
    if (c === ')' || c === ']') {
      const open = c === ')' ? '(' : '[';
      let depth = 0;
      while (i >= 0) {
        if (text[i] === c) depth++;
        else if (text[i] === open) {
          depth--;
          if (depth === 0) break;
        }
        i--;
      }
      i--; // 跳过开括号，继续向前
      continue;
    }
    if (/[\w$]/.test(c)) {
      let j = i;
      while (j >= 0 && /[\w$]/.test(text[j])) j--;
      base = text.slice(j + 1, i + 1);
      i = j;
      continue;
    }
    if (c === '.') {
      i--;
      continue;
    }
    break; // 语句边界
  }
  return base;
}

/**
 * 找行变量的候选迭代源（块内、pos 前），按可信度排序：
 *   ① `.map((VAR` / `.map(({...VAR...})` 的迭代表达式基名（向后走括号配对）
 *   ② `for (const VAR of ITER)` 的 ITER（push 循环构建的集合只有这一条路）
 * 返回数组，由调用方依次尝试解析。
 */
function iterableSourcesIn(block, varName, pos) {
  const safe = esc(varName);
  const out = [];
  // ① map 回调参数（简单 `(v` / `(v,` 或解构 `({ a, v }` / `({ v }`）
  const mapRe = new RegExp(`\\.map\\(\\s*\\(\\s*\\{?\\s*[^)}]*?${safe}\\s*[,:})]`, 'g');
  let m;
  let lastAt = -1;
  while ((m = mapRe.exec(block.text)) !== null) {
    const at = block.open + m.index;
    if (at >= pos) break;
    lastAt = at;
  }
  if (lastAt >= 0) {
    const base = iterableBaseBefore(block.text, lastAt - block.open);
    if (base) out.push(base);
  }
  // ② for-of
  const forRe = new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+${safe}\\s+of\\s+([\\w$]+)`, 'g');
  while ((m = forRe.exec(block.text)) !== null) {
    const at = block.open + m.index;
    if (at >= pos) break;
    out.push(m[1]);
  }
  return out;
}

/**
 * 追踪变量声明来源模型：由内层块到外层块，每层「直接声明 → 链式派生」。
 * 只采信出现在 pos 之前的声明；类体块跳过（会把兄弟方法的声明卷进来）；
 * 最深 6 跳，追不到返回 null。
 */
function resolveVarModel(blocks, san, orig, name, pos, depth = 0) {
  if (depth > 6 || !name) return null;
  for (let bi = blocks.length - 1; bi >= 0; bi--) {
    const block = blocks[bi];
    if (isClassBody(orig, block)) continue;
    const direct = directDeclIn(block, name, pos);
    if (direct) return direct;
    const src = chainSourceIn(block, name, pos);
    if (src && src !== name) {
      const got = resolveVarModel(blocks, san, orig, src, pos, depth + 1);
      if (got) return got;
    }
  }
  return null;
}

/** 从 serializeRow 第一个参数提取行变量名（容忍 `x ?? {}` / `x || {}` 后缀） */
function rowVarOf(argText) {
  const m = argText.match(/^\s*(\w+)\s*(?:\?\?|\|\||$)/);
  return m ? m[1] : null;
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

// ── 5. 逐调用点分析 ────────────────────────────────────────────────
const findings = [];
const warnings = [];
let callSites = 0;
const perConst = new Map(); // constName -> { covered, models:Set }

for (const file of walk(SRC)) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(SERVER, file).replace(/\\/g, '/');
  const san = sanitize(text);

  for (const m of text.matchAll(/serializeRow\(\s*([^,]+?),\s*(\w+BIGINT_FIELDS)\s*\)/g)) {
    const argText = m[1];
    const constName = m[2];
    callSites++;
    const blocks = enclosingBlocks(san, text, m.index);
    const varName = rowVarOf(argText);

    // 行来源追踪：直接/链式声明 → map/for 迭代源 → 放弃（警告）
    let modelName = resolveVarModel(blocks, san, text, varName, m.index);
    if (!modelName) {
      const iters = [];
      for (let bi = blocks.length - 1; bi >= 0; bi--) {
        if (isClassBody(text, blocks[bi])) continue; // 类体块的迭代源属兄弟方法，跳过
        iters.push(...iterableSourcesIn(blocks[bi], varName, m.index));
      }
      for (const it of iters) {
        modelName = resolveVarModel(blocks, san, text, it, m.index);
        if (modelName) break;
      }
    }

    if (!modelName) {
      warnings.push({ rel, line: lineOf(text, m.index), constName, arg: argText.trim() });
      continue;
    }

    const key = modelName.charAt(0).toUpperCase() + modelName.slice(1);
    if (WRITE_ONLY_MODELS.has(key)) continue;
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

    const missing = [...declared].filter((f) => !covered.includes(f) && !EXEMPT_COLUMNS.has(f));
    if (missing.length > 0) {
      findings.push({ file: rel, line: lineOf(text, m.index), constName, model: key, declared: [...declared], covered, missing });
    }
  }
}

// ── 6. 报告 ────────────────────────────────────────────────────────
console.log('===== BigInt 序列化白名单审计（v3 · 作用域追踪）=====\n');
console.log(`Prisma 模型 ${models.size} 个 | serializeRow 调用点 ${callSites} 处 | 常量 ${perConst.size} 个\n`);
console.log(`策略豁免：${[...EXEMPT_COLUMNS].join(' / ')}（计数器 → 边界兜底出 number，见 envelope.ts bigintSafeReplacer）`);
if (WRITE_ONLY_MODELS.size > 0) {
  console.log(`只写模型：${[...WRITE_ONLY_MODELS].join(' / ')}（行不出现在响应）`);
}

const seen = new Set();
const uniq = findings.filter((f) => {
  const k = `${f.constName}|${f.model}|${f.missing.join(',')}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

if (uniq.length === 0) {
  console.log('✅ 未发现漏列');
} else {
  console.log(`❌ 发现 ${uniq.length} 处「模型 BigInt 列未被白名单覆盖」`);
  console.log('   （真 MySQL 下命中即 500，且响应不走信封）\n');
  for (const f of uniq) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    ${f.constName} ← 模型 ${f.model}`);
    console.log(`    模型 BigInt 列: ${f.declared.join(', ')}`);
    console.log(`    白名单覆盖    : ${f.covered.join(', ') || '(空)'}`);
    console.log(`    🔴 漏         : ${f.missing.join(', ')}\n`);
  }
  console.log('修复方向（二选一或并用）：');
  console.log('  A. 把漏列补进对应常量（最小改动）；');
  console.log('  B. 在 HTTP 边界加 BigInt 安全序列化兜底（已落地：envelope.ts bigintSafeReplacer，');
  console.log('     main.ts 以 express `json replacer` 全局装配），让漏列退化为「多转一个字段」；');
  console.log('  C. 长期：白名单改为按 schema 自动派生（本脚本即可作为 CI 门禁）。\n');
}

if (warnings.length > 0) {
  console.log(`⚠️ ${warnings.length} 个调用点无法静态追踪行来源（行经函数参数传入），需人工核对：`);
  for (const w of warnings) {
    console.log(`  ${w.rel}:${w.line} —— serializeRow(${w.arg}, ${w.constName})`);
    const note = UNTRACEABLE_NOTES[w.rel];
    if (note) console.log(`    人工核对备忘：${note}`);
  }
  console.log('');
}

console.log('--- 按常量汇总（行来源追踪结果）---');
for (const [name, info] of perConst) {
  if (!info.covered) continue;
  console.log(`  ${name}: 序列化模型 ${[...info.models].join('/')}`);
}

process.exit(uniq.length > 0 ? 1 : 0);
