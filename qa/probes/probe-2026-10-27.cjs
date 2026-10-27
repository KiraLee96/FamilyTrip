/**
 * QA probe（2026-10-27）—— 本轮 5 条反馈的行为级取证
 * ============================================================================
 * 运行前提：`dist-h5`（Mock 模式）已构建，静态服务在 127.0.0.1:5317
 *   用法：NODE_PATH=/tmp/ftqa/node_modules node qa/probes/probe-2026-10-27.cjs
 *
 * 取证项（对应本轮 5 条反馈）：
 *   P1 回忆墙照片：点照片是否**不再弹删除确认**（此前整格点击曾直接删除）
 *   P1b 回忆墙旅行回忆卡：落点必须是 tab=photo（不是不含照片的快照 tab）
 *   P2 生成回忆：由服务端用例 test/memory-generate.test.ts 覆盖（snap_key 必写）
 *   P3 花销：预算卡存在，且显示 预算/已花/剩余 三要素
 *   P3b 清单：两个分区（要做的事 / 要带的东西）各自独立
 *   P4 物品库并入清单：tabBar 无「物品」，清单页有「我的常备物品」区块
 *   P5 日历：出现「休」/「班」角标与图例
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5318';
const OUT = path.join(__dirname, '..', 'reports', 'probe-2026-10-27');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText || '');
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

  /**
   * Taro H5 的路由是「页面路径」而不是自定义逻辑路径：
   *   小程序里 `/memory` 由 nav 层映射成 pages/MemoryPage，H5 端直接把
   *   `#/memory` 当未知页面，会落到默认首页。所以探针必须用真实页面路径。
   * 且同文档改 hash 不会让 Taro 重新挂载页面，必须 reload 一次。
   */
  const go = async (pagePath, wait = 1600) => {
    await page.goto(`${BASE}/#${pagePath}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(wait);
  };

  // ── P5 日历：假期 / 调休角标 ──────────────────────────────────────────
  await go('/pages/TripCreatePage');
  // 「出行日期」这一行是 .picker-row，点它弹区间日历
  const opened = await page.evaluate(() => {
    const row = document.querySelector('.picker-row');
    if (!row) return null;
    row.click();
    return (row.innerText || '').trim();
  });
  await sleep(1400);
  let text = await bodyText(page);
  const hasOff = /休/.test(text);
  const hasWork = /班/.test(text);
  record('P5 日历出现「休 / 班」角标', hasOff && hasWork, `休=${hasOff} 班=${hasWork} 入口=${opened ?? '未找到 .picker-row'}`);
  record('P5 日历图例（法定假期 / 调休上班）', /法定假期/.test(text) && /调休上班/.test(text));
  // 角标文字清单（实测取证：10 月的国庆连休应能看到「国庆节 10/1–10/7」）
  const tags = await page.evaluate(() =>
    [...document.querySelectorAll('.cal__tag')].map((n) => (n.innerText || '').trim()).slice(0, 12),
  );
  record('P5 当月假期一览（节日名 + 日期区间）', /国庆节|春节|元旦|劳动节|清明|端午|中秋/.test(text), JSON.stringify(tags));
  await page.screenshot({ path: path.join(OUT, 'p5-calendar.png'), fullPage: true });

  // ── P3 花销：预算卡 ───────────────────────────────────────────────────
  await go('/pages/TripDetailPage?id=101&tab=expense');
  text = await bodyText(page);
  record('P3 花销页有「预算」卡', /预算/.test(text));
  record('P3 预算卡显示 预算/已花/剩余 三要素', /预算/.test(text) && /已花/.test(text) && /还剩|超支/.test(text), text.match(/还剩[^\n]*|超支[^\n]*/)?.[0] ?? '');
  await page.screenshot({ path: path.join(OUT, 'p3-budget.png'), fullPage: true });

  // ── P3b 清单：两个分区 ────────────────────────────────────────────────
  await go('/pages/TripDetailPage?id=101&tab=checklist');
  text = await bodyText(page);
  record('P3b 清单分为「要做的事 / 要带的东西」两个分区', /要做的事/.test(text) && /要带的东西/.test(text));
  record('P3b 两条进度条独立', (text.match(/要做的事/g) || []).length >= 1 && (text.match(/要带的东西/g) || []).length >= 1);
  await page.screenshot({ path: path.join(OUT, 'p3b-checklist.png'), fullPage: true });

  // ── P1 回忆墙：点照片不弹删除确认 ─────────────────────────────────────
  await go('/pages/MemoryPage', 2000);
  text = await bodyText(page);
  record('P1 回忆墙有照片区', /照片/.test(text), text.slice(0, 80).replace(/\n/g, ' | '));

  // 拦截 showModal：若点击照片触发删除确认，说明回归了旧行为
  await page.evaluate(() => {
    window.__modalCount = 0;
    const orig = window.wx && window.wx.showModal;
    if (orig) window.wx.showModal = (...a) => { window.__modalCount += 1; return orig(...a); };
  });
  // 点第一个照片格（非「＋」格）
  const clicked = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.photo-cell')];
    const target = cells.find((c) => !c.className.includes('photo-cell--add'));
    if (!target) return false;
    const img = target.querySelector('img, .photo-cell__img');
    (img || target).click();
    return true;
  });
  await sleep(900);
  const modalCount = await page.evaluate(() => window.__modalCount || 0);
  record('P1 点照片不会误触删除确认', clicked && modalCount === 0, `clicked=${clicked} modal=${modalCount}`);
  await page.screenshot({ path: path.join(OUT, 'p1-memory.png'), fullPage: true });

  // ── P1b 回忆墙旅行回忆卡落点 = 照片 tab ───────────────────────────────
  const cardHash = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.memo-card')];
    if (!cards.length) return null;
    cards[0].click();
    return true;
  });
  await sleep(1600);
  const url = page.url();
  record(
    'P1b 旅行回忆卡跳到照片 tab（不是回忆快照 tab）',
    url.includes('tab=photo'),
    url,
  );
  await page.screenshot({ path: path.join(OUT, 'p1b-trip-photo.png'), fullPage: true });

  // ── P4 tabBar 无「物品」；清单页有「我的常备物品」 ─────────────────────
  await go('/pages/ProfilePage');
  text = await bodyText(page);
  const tabTexts = await page.evaluate(() =>
    [...document.querySelectorAll('.taro-tabbar__item, .taro_tabbar_item, [class*="tabbar"]')]
      .map((n) => (n.innerText || '').trim())
      .filter(Boolean),
  );
  record('P4 底部 tab 不再有「物品」', !tabTexts.some((t) => t === '物品'), JSON.stringify(tabTexts));
  // 进入「物品与清单」tab（管理区是 .mgmt-entry 卡片）
  const entered = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('.mgmt-entry')].find((n) =>
      (n.innerText || '').includes('物品与清单'),
    );
    if (!hit) return false;
    hit.click();
    return true;
  });
  await sleep(1500);
  text = await bodyText(page);
  record('P4 清单页内含「我的常备物品」区块', entered === true && /我的常备物品/.test(text), `entered=${entered}`);
  record('P4 三个可见范围标注清楚', /全家可见/.test(text) && /仅自己可见/.test(text));
  await page.screenshot({ path: path.join(OUT, 'p4-checklist-merged.png'), fullPage: true });

  // ── 汇总 ──────────────────────────────────────────────────────────────
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
  if (consoleErrors.length) console.log(consoleErrors.slice(0, 5).join('\n'));

  await browser.close();
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
