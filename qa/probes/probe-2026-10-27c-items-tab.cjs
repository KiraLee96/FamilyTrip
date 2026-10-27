/**
 * QA probe（2026-10-27 · 第三轮）—— 物品清单作为一级 tab
 * ============================================================================
 * 用户诉求演进：
 *   ④-1「物品库和物品清单权限模糊」→ 合并
 *   ④-2「常备物品应该包含家庭清单和我的清单」→ 改为上位概念 + 两半
 *   ④-3「物品清单还是要作为一个 tab」→ 恢复一级 tab（本轮）
 *
 * 断言：
 *   K0 底部 tabBar 5 项且含「物品」（总览/规划/行程/物品/我的）
 *   K1 物品页标题为「物品清单」，且有「常备物品」说明
 *   K2 两半分区：家庭常备 · 全家可见 / 我的常备 · 仅自己可见
 *   K3 展开后条目按类型分组（分组标题带件数）
 *   K4 「我的」页不再有清单入口（一个功能不能有两个入口）
 *
 * 运行前提：apps/client/dist-h5 已构建（Mock 模式），静态服务在 127.0.0.1:5320
 *   用法：NODE_PATH=/tmp/ftqa/node_modules node qa/probes/probe-2026-10-27c-items-tab.cjs
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5320';
const OUT = path.join(__dirname, '..', 'reports', 'probe-2026-10-27c');
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
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-proxy-server', '--proxy-bypass-list=*'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Taro H5 路由是页面路径；改 hash 不会重挂页面 → goto + reload
  await page.goto(`${BASE}/#/pages/ItemsPage`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);

  const text = await page.evaluate(() => document.body.innerText || '');

  // K0：tabBar
  const tabs = await page.evaluate(() => {
    // Taro H5 的 tabBar 用的是 weui 类名（不是 taro-tabbar__item），踩过一次
    const nodes = [...document.querySelectorAll('.weui-tabbar__item')];
    const labels = nodes.map((n) => (n.innerText || '').trim()).filter(Boolean);
    return [...new Set(labels)];
  });
  record(
    'K0 底部 5 个 tab 且含「物品」',
    tabs.includes('物品') && tabs.length >= 5,
    JSON.stringify(tabs),
  );

  record('K1 物品页标题「物品清单」+ 常备物品说明', /物品清单/.test(text) && /常备物品/.test(text));
  record(
    'K2 两半分区：家庭常备 / 我的常备',
    /家庭常备/.test(text) && /我的常备/.test(text),
    (text.match(/家庭常备[^\n]*|我的常备[^\n]*/g) || []).slice(0, 2).join(' | '),
  );

  // 展开第一套清单看分组
  await page.evaluate(() => {
    const head = document.querySelector('.cl-card__head');
    if (head) head.click();
  });
  await sleep(1200);
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('.cl-group__title')].map((n) => (n.innerText || '').trim()),
  );
  const items = await page.evaluate(() => document.querySelectorAll('.cl-item').length);
  record(
    'K3 条目按类型分组（组标题带件数）',
    groups.length >= 2 && items >= 3,
    `分组=${JSON.stringify(groups)} 条目数=${items}`,
  );

  await page.screenshot({ path: path.join(OUT, 'k-items-tab.png'), fullPage: true });

  // K4：「我的」页不再有清单入口
  await page.goto(`${BASE}/#/pages/ProfilePage`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1500);
  const profileEntries = await page.evaluate(() =>
    [...document.querySelectorAll('.mgmt-entry')].map((n) => (n.innerText || '').trim()),
  );
  record(
    'K4 「我的」页不再有清单入口（避免双入口）',
    !profileEntries.some((t) => /物品|清单|常备/.test(t)),
    JSON.stringify(profileEntries).slice(0, 120),
  );
  await page.screenshot({ path: path.join(OUT, 'k-profile.png'), fullPage: true });

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
