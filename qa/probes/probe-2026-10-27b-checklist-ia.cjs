/**
 * QA probe（2026-10-27 · 第二轮）—— 常备物品信息架构
 * ============================================================================
 * 验证用户第二次反馈的结构诉求：
 *   「家庭清单或者个人清单都要根据类型分类，常备物品其实就应该包含
 *     家庭清单和我的清单」
 *
 * 断言：
 *   K1 页面出现「常备物品」这个**上位**标题（不再是三个并列区块）
 *   K2 两半分区：「家庭常备 · 全家可见」/「我的常备 · 仅自己可见」
 *   K3 展开一套清单后，条目**按类型分组**（出现分组标题 + 件数）
 *   K4 不再出现「物品库」这个独立入口（第二套模型已收敛）
 *
 * 运行前提：apps/client/dist-h5 已构建（Mock 模式），静态服务在 127.0.0.1:5319
 *   用法：NODE_PATH=/tmp/ftqa/node_modules node qa/probes/probe-2026-10-27b-checklist-ia.cjs
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5319';
const OUT = path.join(__dirname, '..', 'reports', 'probe-2026-10-27b');
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

  // Taro H5 路由是页面路径，且改 hash 不会重挂页面 → goto + reload
  await page.goto(`${BASE}/#/pages/ProfilePage`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1600);

  // 进入「物品与清单」
  const entered = await page.evaluate(() => {
    const hit = [...document.querySelectorAll('.mgmt-entry')].find((n) =>
      (n.innerText || '').includes('物品'),
    );
    if (!hit) return false;
    hit.click();
    return true;
  });
  await sleep(1500);

  const text = await page.evaluate(() => document.body.innerText || '');
  record('K1 出现「常备物品」上位标题', /常备物品/.test(text), entered ? '已进入清单页' : '未找到入口');
  record(
    'K2 两半分区：家庭常备 / 我的常备',
    /家庭常备/.test(text) && /我的常备/.test(text),
    (text.match(/家庭常备[^\n]*|我的常备[^\n]*/g) || []).slice(0, 2).join(' | '),
  );
  // K4：判定的是「还有没有物品库这个入口」，不是页面上还能不能出现这四个字 ——
  //     旧数据并入提示里出现「旧物品库」是对的（那是在告诉用户数据还在）。
  const legacyEntry = await page.evaluate(() =>
    [...document.querySelectorAll('.mgmt-entry, .taro-tabbar__item')].some((n) =>
      (n.innerText || '').includes('物品库'),
    ),
  );
  record('K4 无「物品库」独立入口（只剩旧数据并入提示）', legacyEntry === false,
    legacyEntry ? '仍有入口' : '入口已收敛');

  // 展开第一套家庭常备清单，看条目分组
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
    'K3 展开后条目按类型分组（分组标题带件数）',
    groups.length >= 2 && items >= 3,
    `分组=${JSON.stringify(groups)} 条目数=${items}`,
  );

  await page.screenshot({ path: path.join(OUT, 'k-checklist-ia.png'), fullPage: true });

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
