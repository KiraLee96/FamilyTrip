/**
 * H5 无头验收 —— family-trip 「我的」tab / 家庭邀请 / 行程成员 / 行程邀请码
 * ============================================================================
 * 运行前提：
 *   1. dist-h5 已构建（pnpm build:h5，Mock 模式）
 *   2. .verify/server.js 已在 127.0.0.1:5317 提供静态服务
 * 验收点：
 *   A. 首页渲染：tabBar 五标签（总览/规划/行程/物品/我的）+ 回忆墙入口
 *   B. 「我的」tab 可点击切换 → ProfilePage 渲染（账号卡 + 我的家庭 + 邀请码）
 *   C. 回忆墙入口可进入 MemoryPage
 *   D. 新建行程页：同行成员多选可toggle；创建流程 → 邀请卡渲染邀请码
 *   E. 行程详情页：同行邀请卡渲染（邀请码/复制/分享/重置/凭码加入）
 *   F. JoinTripPage：?invite=CODE 预填输入框
 *   G. 全程 console.error 计数为 0
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

/** 点击页面中含指定文本的 tab 项（Taro H5 tabBar） */
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
          return cls;
        }
        el = el.parentElement;
      }
    }
    return null;
  }, text);
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  try {
    // ── A. 首页 ──
    let page = await newPage(browser);
    await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2000);
    const homeText = await page.evaluate(() => document.body.innerText);
    record('A1 首页渲染（含 tabBar 与回忆入口）', /总览|下一站|回忆/.test(homeText), '');
    const tabTexts = await page.evaluate(() => {
      const bar = document.querySelector('[class*="tabbar"]');
      return bar ? bar.innerText.replace(/\s+/g, ' ') : '';
    });
    record(
      'A2 tabBar 含五个标签（总览/规划/行程/物品/我的）',
      ['总览', '规划', '行程', '物品', '我的'].every((t) => tabTexts.includes(t)),
      tabTexts.slice(0, 80),
    );
    await page.screenshot({ path: path.join(OUT, '01-home.png') });

    // ── B. 我的 tab ──
    const tabCls = await clickTabByText(page, '我的');
    await sleep(1500);
    const urlAfterTab = page.url();
    const profileText = await page.evaluate(() => document.body.innerText);
    record(
      'B1 点击「我的」tab 跳转 ProfilePage',
      urlAfterTab.includes('ProfilePage'),
      `tabbar class=${tabCls} url=${urlAfterTab.split('#')[1] ?? ''}`,
    );
    record(
      'B2 ProfilePage 渲染（我的家庭 + 账号）',
      /我的家庭|账号/.test(profileText),
      profileText.includes('我的家庭') ? '含「我的家庭」' : '未找到「我的家庭」',
    );
    const hasInviteUi = /邀请码/.test(profileText);
    record('B3 我的页含邀请码机制', hasInviteUi, hasInviteUi ? '邀请码 UI 在 DOM' : '未见邀请码');
    await page.screenshot({ path: path.join(OUT, '02-profile.png') });

    // ── C. 回忆从首页进入 ──
    await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
    await sleep(1500);
    const memClicked = await page.evaluate(() => {
      // Taro H5 下 Link 渲染为 taro-view-core 宿主，文本与图标是兄弟节点，
      // 按容器文本匹配而非叶子文本
      const els = [...document.querySelectorAll('taro-view-core.section-title__side')];
      const target = els.find((e) => (e.textContent || '').trim().startsWith('回忆墙'));
      if (!target) return false;
      target.click();
      return true;
    });
    await sleep(2000);
    const memUrl = page.url();
    const memText = await page.evaluate(() => document.body.innerText);
    record(
      'C1 首页「回忆墙」入口进入 MemoryPage',
      memClicked && memUrl.includes('MemoryPage'),
      `url=${memUrl.split('#')[1] ?? ''}`,
    );
    record('C2 MemoryPage 渲染', /回忆/.test(memText), '');
    await page.screenshot({ path: path.join(OUT, '03-memory.png') });

    // ── D. 新建行程：成员多选 + 创建 → 邀请卡 ──
    await page.goto(BASE + '/#/pages/TripCreatePage', { waitUntil: 'networkidle0' });
    await sleep(2000);
    await page.waitForSelector('.member--pick', { timeout: 10000 }).catch(() => {});
    const memberCount = await page.$$eval('.member--pick', (els) => els.length);
    record('D1 同行成员多选列表渲染', memberCount > 0, `${memberCount} 位成员`);

    if (memberCount > 1) {
      // 第二行成员（第一行通常是「我」，不可 toggle）：
      // 点一下取消、再点一下恢复。用索引定位，避开 nth-child 与卡片头的错位
      const rowAt = (i) =>
        page.$$eval('.member--pick', (els, idx) => (els[idx] ? els[idx].className : ''), i);
      const before = await rowAt(1);
      await (await page.$$('.member--pick'))[1].click();
      await sleep(400);
      const after = await rowAt(1);
      await (await page.$$('.member--pick'))[1].click();
      await sleep(400);
      const restored = await rowAt(1);
      record(
        'D2 成员勾选可 toggle（on→off→on）',
        before.includes('member--on') &&
          !after.includes('member--on') &&
          restored.includes('member--on'),
        `on→off→on 完成`,
      );
    }

    // 填标题并创建（Taro Input 的真实 <input> 是 light-DOM 子元素）
    await page.type('.field input', '无头验收 · 测试行程');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, '04-trip-create.png') });
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.btn--block')];
      const b = btns.find((el) => el.innerText.includes('创建行程'));
      if (b) b.click();
    });
    await page.waitForSelector('.invite__code', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const inviteText = await page.evaluate(() => document.body.innerText);
    const codeMatch = inviteText.match(/[A-Z2-9]{8}/);
    record('D3 创建成功进入邀请步骤（含邀请码）', Boolean(codeMatch), codeMatch ? `邀请码=${codeMatch[0]}` : '未见邀请码');
    await page.screenshot({ path: path.join(OUT, '05-invite-step.png') });

    // ── E. 进入行程详情 → 邀请卡 ──
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.btn--block')];
      const b = btns.find((el) => el.innerText.trim() === '进入行程');
      if (b) b.click();
    });
    await sleep(2500);
    const detailUrl = page.url();
    const detailText = await page.evaluate(() => document.body.innerText);
    record(
      'E1 进入行程详情页',
      detailUrl.includes('TripDetailPage'),
      `url=${detailUrl.split('#')[1] ?? ''}`,
    );
    record(
      'E2 详情页含同行邀请卡（邀请码 + 凭码加入）',
      /同行邀请码/.test(detailText) && /凭码加入/.test(detailText),
      /同行邀请码/.test(detailText) ? '邀请卡渲染' : '未见邀请卡',
    );
    await page.screenshot({ path: path.join(OUT, '06-trip-detail.png') });

    // ── F. JoinTripPage 邀请码预填 ──
    await page.goto(BASE + '/#/pages/JoinTripPage?invite=TEST123', {
      waitUntil: 'networkidle0',
    });
    await sleep(2000);
    const prefill = await page.evaluate(() => {
      const input = document.querySelector('.input');
      return input ? input.value : null;
    });
    record('F1 JoinTripPage 邀请码预填', prefill === 'TEST123', `input value=${prefill}`);
    const joinText = await page.evaluate(() => document.body.innerText);
    record('F2 JoinTripPage 渲染（加入行程 + 引导文案）', /加入行程/.test(joinText), '');
    await page.screenshot({ path: path.join(OUT, '07-join-trip.png') });

    await page.close();
  } finally {
    await browser.close();
  }

  record('G 全程 console.error 计数为 0', consoleErrors.length === 0, `${consoleErrors.length} 条`);
  if (consoleErrors.length > 0) {
    console.log('---- console errors ----');
    consoleErrors.slice(0, 10).forEach((e) => console.log('  ' + e.slice(0, 200)));
  }

  const report = {
    time: new Date().toISOString(),
    base: BASE,
    results,
    consoleErrors,
    pass: results.filter((r) => r.ok).length,
    total: results.length,
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n===== ${report.pass}/${report.total} 通过 =====`);
  process.exit(report.pass === report.total ? 0 : 1);
}

main().catch((e) => {
  console.error('验收脚本异常：', e);
  process.exit(2);
});
