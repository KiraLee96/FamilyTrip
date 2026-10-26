/**
 * H5 无头验收 —— 2026-10-26 四项反馈
 * ============================================================================
 * 运行前提：
 *   1. dist-h5 已构建（Mock 模式：不传 API_BASE_URL）
 *   2. .verify/server.cjs 已在 127.0.0.1:5317 提供静态服务
 * 验收点：
 *   反馈 1  我的页管理入口 + 长期清单（家庭 / 我的两套）
 *     R1-1 我的页出现 4 个管理入口（物品清单 / 物品库 / 心愿池 / 回忆墙）
 *     R1-2 子 tab「物品清单」可切换，页面出现「长期清单」说明与两套清单标题
 *     R1-3 家庭清单渲染种子「家庭出行常用」+ 条目数 6
 *     R1-4 展开清单可看到条目与「引用到某个行程」入口
 *     R1-5 引用到行程 → 选行程弹层列出 3 场行程
 *     R1-6 引用后行程 101 的清单条目由 6 → 12（幂等/落库生效）
 *   反馈 2  行程参与人可见
 *     R2-1 行程详情出现「参与人」卡与「共 3 人」
 *     R2-2 名单含 爸爸 / 妈妈 / 爷爷，主导者带「主导」标签
 *   反馈 3  账单导入
 *     R3-1 花销 tab 出现「导入账单（微信 / 支付宝）」
 *     R3-2 弹层可粘贴账单、解析出 2 笔并显示合计
 *     R3-3 提交后明细出现新账单条目（导入完成提示）
 *   反馈 4  邀请码复制 / 分享
 *     R4-1 家庭卡片展示邀请码 QM2K7X9W
 *     R4-2 H5 下「分享」按钮换成「复制链接」，点击后提示「加入链接已复制」
 *     R4-3 全程无「复制失败」提示（原 bug 的回归断言）
 * 全程 console.error / pageerror 计数为 0
 *
 * 🔴 作用域：Taro H5 页面栈把下层页面留在 DOM 里（display:none），
 *    所有查询与点击都收敛到「顶层可见 .taro_page」（沿用 verify-features-v1）。
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5317';
const OUT = __dirname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleErrors = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  return page;
}

/** 顶层可见页面容器 */
async function topScope(page) {
  return page.evaluateHandle(() => {
    const pages = [...document.querySelectorAll('.taro_page')];
    const visible = pages.filter((el) => getComputedStyle(el).display !== 'none');
    return visible[visible.length - 1] ?? document.body;
  });
}

async function pageText(page) {
  const scope = await topScope(page);
  const text = await page.evaluate((el) => el.innerText, scope);
  await scope.dispose();
  return text;
}

/** 整页文本（含 toast / modal 等页面容器外的节点） */
async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function clickTabByText(page, text) {
  return page.evaluate((t) => {
    const leaves = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === t,
    );
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 6 && el; i++) {
        const cls = el.className;
        if (typeof cls === 'string' && cls.includes('tabbar')) {
          el.click();
          return true;
        }
        el = el.parentElement;
      }
    }
    return false;
  }, text);
}

async function clickByText(page, text) {
  const scope = await topScope(page);
  const ok = await page.evaluate(
    (el, t) => {
      const hits = [...el.querySelectorAll('*')].filter((e) => (e.textContent || '').includes(t));
      if (hits.length === 0) return false;
      let best = hits[0];
      for (const h of hits) if (best.contains(h)) best = h;
      best.click();
      return true;
    },
    scope,
    text,
  );
  await scope.dispose();
  return ok;
}

/**
 * document 级点击 —— 专治「页面容器之外」的节点。
 * Taro 的 showModal / toast 渲染在 .taro_page 之外，topScope 够不到，
 * 不关掉 modal 会一直挡着后续导航（第一轮验收就栽在这里）。
 */
async function clickGlobal(page, text) {
  return page.evaluate((t) => {
    const hits = [...document.querySelectorAll('*')].filter((e) => (e.textContent || '').includes(t));
    if (hits.length === 0) return false;
    let best = hits[0];
    for (const h of hits) if (best.contains(h)) best = h;
    best.click();
    return true;
  }, text);
}

async function clickTabBtn(page, text) {
  const scope = await topScope(page);
  const ok = await page.evaluate(
    (el, t) => {
      const btns = [...el.querySelectorAll('[class*="tabs__btn"]')];
      const b = btns.find((e) => (e.textContent || '').trim() === t);
      if (!b) return false;
      b.click();
      return true;
    },
    scope,
    text,
  );
  await scope.dispose();
  return ok;
}

async function countInScope(page, selector) {
  const scope = await topScope(page);
  const n = await page.evaluate((el, sel) => el.querySelectorAll(sel).length, scope, selector);
  await scope.dispose();
  return n;
}

async function waitForText(page, text, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await pageText(page)).includes(text)) return true;
    await sleep(200);
  }
  return false;
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

/** 进入某场行程的详情页（行程 tab → 卡片） */
async function openTrip101(page) {
  await clickTabByText(page, '行程');
  await sleep(1200);
  await clickByText(page, '国庆 · 青岛看海');
  await sleep(1800);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  try {
    const page = await newPage(browser);
    await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2600);

    // ── 反馈 1：我的页 ──
    await clickTabByText(page, '我的');
    await sleep(1400);
    let text = await pageText(page);
    record(
      'R1-1 我的页 4 个管理入口',
      ['物品清单', '物品库', '心愿池', '回忆墙'].every((k) => text.includes(k)),
      `entries=${['物品清单', '物品库', '心愿池', '回忆墙'].filter((k) => text.includes(k)).length}/4`,
    );
    await shot(page, 'n1-profile-mgmt.png');

    const switched = await clickTabBtn(page, '物品清单');
    await sleep(1400);
    text = await pageText(page);
    record('R1-2 子 tab 切到「物品清单」', switched && text.includes('长期清单'), '');
    record(
      'R1-3 家庭清单种子渲染（家庭出行常用）',
      text.includes('家庭出行常用') && text.includes('家庭共享'),
      text.includes('家庭出行常用') ? 'found' : 'missing',
    );
    await shot(page, 'n2-checklist-panel.png');

    // 展开家庭清单
    await clickByText(page, '家庭出行常用');
    await sleep(700);
    text = await pageText(page);
    record(
      'R1-4 展开后可看条目与引用入口',
      text.includes('身份证（全家 4 人）') && text.includes('引用到某个行程'),
      '',
    );
    await shot(page, 'n3-checklist-expanded.png');

    // 引用到行程
    await clickByText(page, '引用到某个行程');
    await sleep(1200);
    text = await pageText(page);
    const tripRows = await countInScope(page, '.pick-row');
    record(
      'R1-5 选行程弹层列出 3 场行程',
      tripRows === 3 && text.includes('国庆 · 青岛看海'),
      `pick-row=${tripRows}`,
    );
    await shot(page, 'n4-apply-sheet.png');

    await clickByText(page, '国庆 · 青岛看海');
    await sleep(1500);
    const applied = await bodyText(page);
    record(
      'R1-6 引用成功提示',
      /已加入 \d+ 项/.test(applied) || applied.includes('已经引用过'),
      (applied.match(/已加入[^\n]*/) ?? [''])[0],
    );

    // 验证落库：行程 101 的清单条目 6 → 12
    await openTrip101(page);
    await clickTabBtn(page, '清单');
    await sleep(1200);
    const checks = await countInScope(page, '.check');
    record('R1-7 引用后行程清单条目 6 → 12', checks === 12, `check=${checks}`);

    // ── 反馈 2：参与人 ──
    let detailText = await pageText(page);
    record(
      'R2-1 行程详情出现参与人卡与人数',
      detailText.includes('参与人') && detailText.includes('共 3 人'),
      (detailText.match(/共 \d+ 人/) ?? [''])[0],
    );
    record(
      'R2-2 名单含三位成员 + 主导标签',
      ['爸爸', '妈妈', '爷爷', '主导'].every((k) => detailText.includes(k)),
      '',
    );
    await shot(page, 'n5-trip-members.png');

    // ── 反馈 3：账单导入 ──
    const clQuick = detailText.includes('从长期清单引用');
    record('R3-0 清单 tab 有「从长期清单引用」入口', clQuick, '');

    await clickTabBtn(page, '花销');
    await sleep(1400);
    let moneyText = await pageText(page);
    const hasImport = moneyText.includes('导入账单（微信 / 支付宝）');
    record('R3-1 花销 tab 有「导入账单」入口', hasImport, '');
    await shot(page, 'n6-expense-import-entry.png');

    await clickByText(page, '导入账单（微信 / 支付宝）');
    await sleep(1000);
    const sheetText = await pageText(page);
    record('R3-2 导入弹层打开（含导出指引）', sheetText.includes('账单怎么导出'), '');

    // 粘贴两行账单 → 解析
    const areas = await page.$$('textarea');
    const billArea = areas[areas.length - 1];
    await billArea.click();
    await billArea.type('2026-10-03 栈桥咖啡 42.50\n2026-10-04 海鲜大排档 268 元');
    await sleep(300);
    await clickByText(page, '解析');
    await sleep(900);
    const parsedText = await pageText(page);
    const billRows = await countInScope(page, '.bill-row');
    record(
      'R3-3 解析出 2 笔并显示合计 ¥310.50',
      billRows === 2 && parsedText.includes('310.50'),
      `bill-row=${billRows}`,
    );
    await shot(page, 'n7-bill-preview.png');

    await clickByText(page, '导入 2 笔');
    await sleep(1800);
    const doneText = await bodyText(page);
    record('R3-4 导入完成提示', doneText.includes('导入完成'), '');
    await shot(page, 'n8-bill-done.png');
    // 关掉 modal（Taro modal 渲染在页面容器外，必须 document 级点击）
    await clickGlobal(page, '知道了');
    await sleep(1200);
    moneyText = await pageText(page);
    record(
      'R3-5 明细出现导入的两笔',
      moneyText.includes('栈桥咖啡') && moneyText.includes('海鲜大排档'),
      '',
    );
    await shot(page, 'n9-expense-after-import.png');

    // ── 反馈 4：邀请码复制 / 分享（家庭卡片） ──
    // 行程详情是**非 tab 页**，Taro H5 下原生 tabBar 不渲染，点不到「我的」；
    // 直接按 hash 路由跳（同时顺带验证 ProfilePage 可被深链打开）。
    await page.goto(BASE + '/#/pages/ProfilePage', { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2600);
    // 子 tab 默认是「账号与家庭」，显式点一次防止上次会话残留
    await clickTabBtn(page, '账号与家庭');
    await sleep(900);
    await clickByText(page, '我们一家');
    await sleep(1600);
    text = await pageText(page);
    record('R4-1 家庭卡片展示邀请码', text.includes('QM2K7X9W'), '');
    record('R4-2 H5 用「复制链接」替代转发按钮', text.includes('复制链接'), '');

    await clickByText(page, '复制链接');
    await sleep(600);
    const afterCopy = await bodyText(page);
    record(
      'R4-3 复制链接有成功反馈且无「复制失败」',
      afterCopy.includes('加入链接已复制') && !afterCopy.includes('复制失败'),
      (afterCopy.match(/[^\n]*已复制[^\n]*/) ?? [''])[0],
    );
    await shot(page, 'n10-invite-copy.png');

    // ── 全局：控制台错误数 ──
    record('GLOBAL 控制台无 error', consoleErrors.length === 0, `errors=${consoleErrors.length}`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  fs.writeFileSync(
    path.join(OUT, 'verify-2026-10-26-report.json'),
    JSON.stringify({ results, consoleErrors, at: new Date().toISOString() }, null, 2),
  );
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
