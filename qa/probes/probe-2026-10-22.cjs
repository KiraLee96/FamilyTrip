/**
 * QA probe（2026-10-22）—— 针对本次新写用例的行为级取证
 * ============================================================================
 * 目的：验证代码审查发现的两个高风险点，输出可复现证据（截图 + 文本）。
 * 运行前提：dist-h5（Mock）已构建，静态服务在 127.0.0.1:5317
 *   用法：NODE_PATH="<workspace>/node_modules" node qa/probes/probe-2026-10-22.cjs
 *
 * 取证项：
 *   P1 回忆墙照片：单击照片格是否直接删除（无二次确认）
 *   P2 行程详情照片：删除角标是否无二次确认
 *   P3 花销明细：币种非 CNY 时是否双币展示
 *   P4 已结束行程：只读态下是否仍可复制/分享邀请码
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5317';
const OUT = path.join(__dirname, '..', 'reports', 'probe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const goto = async (hash) => {
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle2' });
    await sleep(1800);
  };
  const visible = async () => {
    const el = await page.$('.taro_page_show');
    return el ? await el.evaluate((n) => n.innerText) : '';
  };
  const countVisible = async (sel) => {
    const el = await page.$('.taro_page_show');
    if (!el) return 0;
    return el.evaluate((n, s) => n.querySelectorAll(s).length, sel);
  };

  // ── P1 回忆墙照片：单击是否直接删除 ──────────────────────────────
  await goto('/pages/MemoryPage');
  const before = await countVisible('.photo-cell');
  const cellsBefore = await countVisible('.photo-cell__img, .photo-cell__ph');
  const textBefore = await visible();
  await page.screenshot({ path: path.join(OUT, 'p1-memory-before.png') });

  // 🔴 必须排除「上传照片」格（photo-cell--add），否则点到的是文件选择器而非照片
  const target = await page.$('.taro_page_show .photo-cell:not(.photo-cell--add)');
  if (target) {
    await target.click();
    await sleep(1200);
  }
  const after = await countVisible('.photo-cell');
  const cellsAfter = await countVisible('.photo-cell__img, .photo-cell__ph');
  const textAfter = await visible();
  await page.screenshot({ path: path.join(OUT, 'p1-memory-after.png') });

  const confirmShown =
    textAfter.includes('确定删除') || textAfter.includes('确认删除') || (await countVisible('.taro-modal'));
  const photoDropped = cellsAfter < cellsBefore;
  record(
    'P1 回忆墙：单击照片即删除且无二次确认（缺陷复现）',
    photoDropped && !confirmShown,
    `照片格 ${cellsBefore} → ${cellsAfter}；确认弹层=${confirmShown ? '有' : '无'}；容器数 ${before} → ${after}`,
  );

  // ── P3 花销明细双币展示 ────────────────────────────────────────
  await goto('/pages/TripDetailPage?id=104&tab=expense');
  const expenseText = await visible();
  await page.screenshot({ path: path.join(OUT, 'p3-expense.png') });
  record(
    'P3 花销明细双币展示（需求 §5.2）',
    /JPY|USD|EUR/.test(expenseText),
    /JPY|USD|EUR/.test(expenseText) ? '明细含外币标识' : '明细仅见 ¥ 金额，无币种区分',
  );

  // ── P4 已结束行程：只读态仍可复制/分享邀请码 ───────────────────
  await goto('/pages/TripDetailPage?id=103&tab=memory&readonly=1');
  const roText = await visible();
  await page.screenshot({ path: path.join(OUT, 'p4-readonly-invite.png') });
  const hasCopy = roText.includes('复制');
  const hasShare = roText.includes('分享');
  const hasReset = roText.includes('重置邀请码');
  record(
    'P4 只读行程仍展示邀请码复制/分享（待产品确认）',
    !(hasCopy || hasShare),
    `复制=${hasCopy} 分享=${hasShare} 重置=${hasReset}`,
  );

  // ── 全局 console 错误 ─────────────────────────────────────────
  record('G 本次探针全程 console.error 计数为 0', consoleErrors.length === 0, `${consoleErrors.length} 条`);

  await browser.close();
  fs.writeFileSync(
    path.join(OUT, 'probe-report.json'),
    JSON.stringify({ results, consoleErrors, generatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== PROBE SUMMARY =====\ntotal=${results.length} pass=${pass} fail=${results.length - pass}`);
}

main().catch((e) => {
  console.error('PROBE CRASHED:', e);
  process.exit(1);
});
