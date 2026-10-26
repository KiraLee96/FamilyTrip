/**
 * H5 无头验收 —— 2026-10-26 第二轮（信息架构+状态流转）
 * ============================================================================
 * 运行前提：dist-h5 已构建（Mock 模式）；.verify/server.cjs 已在 127.0.0.1:5317 起服务
 *
 * 验收点：
 *   A 信息架构：邀请码/参与人不再各占一张卡
 *     A1 详情页首屏不再出现「同行邀请码」独立区
 *     A2 详情页出现「N 人同行」信息行与「行程管理 ›」入口
 *     A3 出现「邀请同行人」按钮（她要求的"最上面加一个按钮"）
 *   B 行程管理页
 *     B1 点「行程管理 ›」进入管理页，出现「邀请同行人 / 同行邀请码 / TRIP7QM2」
 *     B2 管理页出现「参与人 / 共 3 人 / 爸爸 妈妈 爷爷 / 主导」
 *     B3 管理页出现「重置邀请码」与「凭码加入」
 *   C 内容 tab 保持原样
 *     C1 详情页仍有 行程/清单/花销/照片/回忆 五个 tab，逐个可切
 *   D 到期与归档
 *     D1 日期已过的行程显示「这场行程的日期已经结束」+「标记完成」
 *     D2 点「标记完成」后状态转已完成，提示条消失、编辑入口消失
 *     D3 已归档行程照片 tab 仍有「上传照片」格子（用户要求"只能加/删照片"）
 *   E 控制台无 error
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

/** 点 class 精确匹配的元素（避免「行程管理」文本命中外层整卡） */
async function clickByClass(page, cls) {
  const scope = await topScope(page);
  const ok = await page.evaluate((el, c) => {
    const hit = el.querySelector(`.${c}`);
    if (!hit) return false;
    hit.click();
    return true;
  }, scope, cls);
  await scope.dispose();
  return ok;
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

/** document 级点击（Taro modal 在页面容器之外） */
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

/**
 * 点 modal 里的按钮 —— 必须**限定在 modal 容器内**。
 * 「标记完成」这种文案同时出现在页面提示条按钮和 modal 确认键上，
 * 用全局文本匹配会点回提示条本身（第一轮 D2 就栽在这），modal 永远关不掉。
 */
async function clickModalBtn(page, text) {
  return page.evaluate((t) => {
    const btns = [
      ...document.querySelectorAll('[class*="modal"] [class*="btn"], [class*="dialog"] [class*="btn"]'),
    ].filter((e) => (e.textContent || '').trim() === t);
    const b = btns[btns.length - 1];
    if (!b) return false;
    b.click();
    return true;
  }, text);
}

async function countInScope(page, selector) {
  const scope = await topScope(page);
  const n = await page.evaluate((el, sel) => el.querySelectorAll(sel).length, scope, selector);
  await scope.dispose();
  return n;
}

async function shot(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name) });
}

async function openTrip(page, title) {
  await clickTabByText(page, '行程');
  await sleep(1200);
  await clickByText(page, title);
  await sleep(1800);
}

async function goBackToTrips(page) {
  await clickByText(page, '返回行程列表');
  await sleep(1400);
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

    // ── A 信息架构 ──
    await openTrip(page, '国庆 · 青岛看海');
    let text = await pageText(page);
    record('A1 详情页无独立「同行邀请码」区', !text.includes('同行邀请码'), '');
    record(
      'A2 出现参与人信息行 + 行程管理入口',
      text.includes('人同行') && text.includes('行程管理'),
      '',
    );
    record('A3 出现「邀请同行人」按钮', text.includes('邀请同行人'), '');
    await shot(page, 'r1-detail-no-invite-card.png');

    // ── C 内容 tab 保持原样（先验，因为后面会改状态）──
    const tabLabels = ['行程', '清单', '花销', '照片', '回忆'];
    let tabsOk = true;
    for (const label of tabLabels) {
      const ok = await clickTabBtn(page, label);
      await sleep(500);
      if (!ok) tabsOk = false;
    }
    record('C1 五个内容 tab 都在且可切', tabsOk, tabLabels.join('/'));

    // 照片 tab：日期已过但未归档 → 也应允许上传
    await clickTabBtn(page, '照片');
    await sleep(800);
    const photoCells = await countInScope(page, '.photo-cell--add');
    record('C2 照片 tab 有上传格子', photoCells === 1, `add-cell=${photoCells}`);

    // ── D1 到期提示 ──
    await clickTabBtn(page, '行程');
    await sleep(600);
    text = await pageText(page);
    record(
      'D1 日期已过 → 出现「标记完成」提示条',
      text.includes('这场行程的日期已经结束') && text.includes('标记完成'),
      '',
    );
    await shot(page, 'r2-finish-bar.png');

    // ── B 行程管理页 ──
    await clickByClass(page, 'trip__manage');
    await sleep(1600);
    text = await pageText(page);
    record('B1 进入行程管理页并展示邀请码', text.includes('同行邀请码') && text.includes('TRIP7QM2'), '');
    record(
      'B2 参与人区块：共 3 人 + 名单 + 主导标签',
      text.includes('共 3 人') &&
        ['爸爸', '妈妈', '爷爷', '主导'].every((k) => text.includes(k)),
      '',
    );
    record(
      'B3 有重置邀请码与凭码加入',
      text.includes('重置邀请码') && text.includes('凭码加入'),
      '',
    );
    await shot(page, 'r3-trip-manage.png');

    // ── D2 标记完成 ──
    await clickByText(page, '返回行程详情');
    await sleep(1500);
    const openedBar = await clickByClass(page, 'finish-bar__btn');
    record('D1c 提示条按钮可点中', openedBar, '');
    await sleep(700);
    const modalHit = await clickModalBtn(page, '标记完成');
    record('D1b modal 确认键可点中', modalHit, modalHit ? '' : '未找到 modal 内的确认按钮');
    await sleep(2000);
    text = await pageText(page);
    record(
      'D2 标记后转已完成：提示条消失、信息锁定',
      !text.includes('这场行程的日期已经结束') &&
        text.includes('行程已结束') &&
        !text.includes('编辑行程'),
      '',
    );
    await shot(page, 'r4-finished-detail.png');

    // ── D3 归档后照片仍可加/删 ──
    await clickTabBtn(page, '照片');
    await sleep(900);
    const cellAfter = await countInScope(page, '.photo-cell--add');
    record('D3 归档后照片仍有上传格子', cellAfter === 1, `add-cell=${cellAfter}`);
    await shot(page, 'r5-photo-after-archive.png');

    // 已归档的另一场（暑假·云南 103）也验一遍
    await goBackToTrips(page);
    await openTrip(page, '暑假 · 云南亲子环线');
    text = await pageText(page);
    record('D4 已归档行程进入即只读', text.includes('行程已结束'), '');
    await clickTabBtn(page, '照片');
    await sleep(900);
    const cell103 = await countInScope(page, '.photo-cell--add');
    record('D5 已归档行程照片可上传', cell103 === 1, `add-cell=${cell103}`);

    // ── E 控制台 ──
    record('E 控制台无 error', consoleErrors.length === 0, `errors=${consoleErrors.length}`);
    if (consoleErrors.length > 0) console.log(consoleErrors.slice(0, 5).join('\n'));
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} 通过 ===`);
  fs.writeFileSync(
    path.join(OUT, 'verify-2026-10-26-b-report.json'),
    JSON.stringify({ results, consoleErrors, at: new Date().toISOString() }, null, 2),
  );
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
