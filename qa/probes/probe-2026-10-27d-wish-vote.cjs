/**
 * QA probe（2026-10-27 · 第四轮）—— 心愿投票真的能点了
 * ============================================================================
 * 修的是「心愿池无法投票」：服务端只回 `{ voteCount, votedByMe }`，
 * 客户端按 `{ wish }` 读 → undefined → TypeError → 页面空 catch 吞掉 → 点了没反应。
 *
 * 断言（行为级，不是静态）：
 *   V1 心愿池页有投票按钮
 *   V2 点一下：票数 +1 且出现「已投」
 *   V3 再点一下：票数回落且回到「投票」（取消投票）
 *   V4 全程无 console error（以前的 TypeError 会出现在这里）
 *
 * 运行前提：dist-h5 已构建（Mock），静态服务 127.0.0.1:5321
 *   用法：NODE_PATH=/tmp/ftqa/node_modules node qa/probes/probe-2026-10-27d-wish-vote.cjs
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5321';
const OUT = path.join(__dirname, '..', 'reports', 'probe-2026-10-27d');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 读第一个投票按钮的状态：票数 + 文案 */
async function readVote(page) {
  return page.evaluate(() => {
    const btn = document.querySelector('.vote');
    if (!btn) return null;
    return {
      n: (btn.querySelector('.vote__n')?.innerText || '').trim(),
      cap: (btn.querySelector('.vote__cap')?.innerText || '').trim(),
      on: btn.className.includes('vote--on'),
    };
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--proxy-bypass-list=*'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.goto(`${BASE}/#/pages/WishPoolPage`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);

  const before = await readVote(page);
  record('V1 心愿池有投票按钮', before !== null, JSON.stringify(before));

  if (before === null) {
    await page.screenshot({ path: path.join(OUT, 'v-wish-vote.png'), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  await page.screenshot({ path: path.join(OUT, 'v-wish-before.png'), fullPage: true });

  // 第一次点击：**切换**（种子数据可能已是「已投」，所以不能假设方向）
  // 真正要验的是「点了会变、且票数与已投状态一致」，不是"一定是加一"。
  await page.evaluate(() => document.querySelector('.vote')?.click());
  await sleep(900);
  const a1 = await readVote(page);
  const flipped = a1 !== null && a1.cap !== before.cap;
  const delta = a1 === null ? 0 : Number(a1.n) - Number(before.n);
  const consistent =
    a1 !== null && (a1.cap === '已投' ? delta === 1 : delta === -1);
  record(
    'V2 点一下：已投状态翻转，且票数同步 ±1（方向与状态一致）',
    flipped && consistent,
    `${before.n}/${before.cap} → ${a1?.n}/${a1?.cap}`,
  );
  await page.screenshot({ path: path.join(OUT, 'v-wish-after.png'), fullPage: true });

  // 第二次点击：切回原状态
  await page.evaluate(() => document.querySelector('.vote')?.click());
  await sleep(900);
  const a2 = await readVote(page);
  const restored = a2 !== null && Number(a2.n) === Number(before.n) && a2.cap === before.cap;
  record(
    'V3 再点一下：切回原状态（投票/取消双向都通）',
    restored,
    `${a1?.n}/${a1?.cap} → ${a2?.n}/${a2?.cap}`,
  );

  record('V4 全程无 console error', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  const report = {
    ranAt: new Date().toISOString(),
    base: BASE,
    results,
    consoleErrors,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  fs.writeFileSync(path.join(OUT, 'probe-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n== ${report.passed} passed / ${report.failed} failed, consoleErrors=${consoleErrors.length}`);

  await browser.close();
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
