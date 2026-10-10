/**
 * A2 · CI 门禁：权限声明完整性 + 敏感面静态审查
 * ============================================================================
 * 「单人公司」模式下，自己写的代码自己复核等于没复核。
 * 因此把对抗性校验**固化成可执行的检查**，让 CI 扮演那个「说不的人」。
 *
 * 检查项（逐条对应交付物）：
 *   ① 权限矩阵资源数 = 15，且无重复 (resource, mode) 组合
 *   ② 所有 controller 公开方法：要么 @Public()，要么 @RequireAccess(...)
 *      —— 默认拒绝不留暗门
 *   ③ 加密字段读取必须经 toBuffer()（红线 R1）
 *      —— 静态扫描 `decipher.update(` 的实参
 *   ④ 生产环境不得出现汇率抓取（红线 R7）
 *   ⑤ 不得依赖运行时密钥擦除作为安全边界（红线 R9）
 *
 * 本文件既可被单测调用（断言当前代码库合规），
 * 也可由 CI 直接 `node dist/ci/access-gate.js` 执行。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PERMISSION_MATRIX, assertMatrixSize } from '../auth/require-access.js';

export interface GateViolation {
  file: string;
  line?: number;
  rule: string;
  detail: string;
}

export interface GateReport {
  ok: boolean;
  violations: GateViolation[];
  checkedFiles: number;
  matrixSize: number;
}

/** 递归收集 .ts 源文件（跳过测试与生成物） */
export function collectSourceFiles(root: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(root, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.test.ts')) continue;
    acc.push(full);
  }
  return acc;
}

/**
 * 规则 ③：加密字段读取必须经 toBuffer()。
 *
 * 检查形态：`decipher.update(<ident>)` 中直接传变量，而非 toBuffer(...) 结果。
 * 允许：
 *   decipher.update(ciphertext)            // ciphertext 来自 parseCiphertext（已是 Buffer）
 *   decipher.update(toBuffer(raw, '...'))  // 显式适配
 * 禁止：
 *   decipher.update(row.orderLinkEnc, ...) // 裸 DB 值
 */
export function checkToBufferDiscipline(file: string, source: string): GateViolation[] {
  const out: GateViolation[] = [];
  const lines = source.split('\n');

  lines.forEach((text, i) => {
    // 只关心 crypto 解密调用
    const m = /decipher\.update\(\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (!m) return;

    const arg = m[1] as string;
    // 白名单：来自 parseCiphertext 的局部变量名（约定命名）
    const safeNames = new Set([
      'ciphertext',
      'ct',
      'payload',
      'body',
      'encrypted',
      'input',
      'bytes',
    ]);
    if (safeNames.has(arg)) return;

    // 形如 row.xxx / 含 Enc 后缀的直接字段访问 → 违规
    if (/Enc$/.test(arg) || /(row|record|entity|data)\./.test(text.slice(0, m.index))) {
      out.push({
        file,
        line: i + 1,
        rule: 'R1-toBuffer',
        detail: `decipher.update() 直接传入疑似 DB 二进制值 "${arg}"，必须经 toBuffer()（红线 R1，会导致静默解密失败）`,
      });
    }
  });

  return out;
}

/** 规则 ④：生产环境禁止抓取汇率 */
export function checkNoRateScraping(file: string, source: string): GateViolation[] {
  const out: GateViolation[] = [];
  const patterns = [/https?:\/\/(www\.)?(finance|fx|rate)[\w.-]*\.\w+/i, /axios\.get\(['"`]https?:\/\//i, /fetch\(['"`]https?:\/\//i];

  source.split('\n').forEach((text, i) => {
    if (text.includes('//') && text.trimStart().startsWith('//')) return;
    if (text.includes('docs') || text.includes('@example') || text.includes('注释')) return;
    for (const p of patterns) {
      if (p.test(text)) {
        out.push({
          file,
          line: i + 1,
          rule: 'R7-no-scraping',
          detail: '发现疑似外部 URL 取数；生产环境禁止抓取汇率（红线 R7），汇率源必须走合规授权源',
        });
        break;
      }
    }
  });

  return out;
}

/** 规则 ⑤：不得把运行时擦除当安全边界 */
export function checkNoWipeAsBoundary(file: string, source: string): GateViolation[] {
  const out: GateViolation[] = [];
  source.split('\n').forEach((text, i) => {
    // 允许 wipe() 的实现体本身；禁止在「安全边界」语义处依赖它
    if (/\.fill\(0\)/.test(text) && !file.endsWith('dek-store.ts')) {
      out.push({
        file,
        line: i + 1,
        rule: 'R9-no-wipe-boundary',
        detail: '出现 fill(0) 擦除调用；Node.js 无法真正擦除密钥，不得依赖运行时擦除作为安全边界（红线 R9）',
      });
    }
  });
  return out;
}

/**
 * 规则 ②：controller 方法必须显式声明访问策略。
 *
 * 静态判定：检查带有 HTTP 方法装饰器（@Get/@Post/@Put/@Patch/@Delete）的方法，
 * 其向上若干行内是否出现 @RequireAccess / @Public。
 */
export function checkAccessDeclaration(file: string, source: string): GateViolation[] {
  const out: GateViolation[] = [];
  const lines = source.split('\n');
  const httpDecorator = /^\s*@(Get|Post|Put|Patch|Delete)\s*\(/;

  lines.forEach((text, i) => {
    if (!httpDecorator.test(text)) return;

    // 向上找 6 行，确认有访问策略声明
    const from = Math.max(0, i - 6);
    const window = lines.slice(from, i).join('\n');
    if (/@RequireAccess\s*\(/.test(window) || /@Public\s*\(/.test(window)) return;

    // 向下 3 行（装饰器顺序可能相反）
    const to = Math.min(lines.length, i + 4);
    const windowDown = lines.slice(i, to).join('\n');
    if (/@RequireAccess\s*\(/.test(windowDown) || /@Public\s*\(/.test(windowDown)) return;

    out.push({
      file,
      line: i + 1,
      rule: 'D2-access-declared',
      detail: 'HTTP 路由未声明 @RequireAccess 或 @Public（fail-closed 要求默认拒绝不留暗门）',
    });
  });

  return out;
}

/**
 * 汇总所有检查。
 */
export function runAccessGate(rootDir: string): GateReport {
  const violations: GateViolation[] = [];
  const files = collectSourceFiles(rootDir);

  // ① 矩阵规模
  try {
    assertMatrixSize();
  } catch (e) {
    violations.push({
      file: 'common/auth/require-access.ts',
      rule: 'C1-matrix-size',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ②–⑤ 逐文件扫描
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(rootDir, file).replace(/\\/g, '/');

    violations.push(...checkAccessDeclaration(rel, source));
    violations.push(...checkToBufferDiscipline(rel, source));
    violations.push(...checkNoRateScraping(rel, source));
    violations.push(...checkNoWipeAsBoundary(rel, source));
  }

  return {
    ok: violations.length === 0,
    violations,
    checkedFiles: files.length,
    matrixSize: PERMISSION_MATRIX.length,
  };
}

/** 人类可读报告（CI 输出） */
export function formatGateReport(report: GateReport): string {
  const head = `权限门禁：扫描 ${report.checkedFiles} 个文件，矩阵 ${report.matrixSize} 格，违规 ${report.violations.length} 项`;
  if (report.ok) return `${head}\n✅ 全部通过`;
  const body = report.violations
    .map((v) => `  ❌ [${v.rule}] ${v.file}${v.line ? `:${v.line}` : ''}\n     ${v.detail}`)
    .join('\n');
  return `${head}\n${body}`;
}
