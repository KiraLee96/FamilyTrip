/**
 * 验收 v4 —— 行程安排「参考截图样式」+ 时间段端到端
 * 断言：
 *  A 卡片样式：暖灰底(card-sunk) / 无铁轨 / 时间段下划线 / 标题加粗
 *  B 种子数据时间段渲染：09:30-13:10 等
 *  C 新增带结束时间 → 卡片显示时间段（endAt 落库链路）
 *  D 编辑清除结束时间 → 卡片回落单时间
 *  E console.error = 0
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5318';
const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  const shot = (n) => page.screenshot({ path: path.join(OUT, 'v4-' + n + '.png'), fullPage: false });

  await page.goto(BASE + '/#/pages/TripDetailPage?id=101', { waitUntil: 'networkidle0' });
  await sleep(2500);

  // A. 卡片样式
  const style = await page.evaluate(() => {
    const card = document.querySelector('.tl__card');
    const time = document.querySelector('.tl__time');
    const title = document.querySelector('.tl__title');
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const cardCs = cs(card);
    const timeCs = cs(time);
    const titleCs = cs(title);
    return {
      cardBg: cardCs?.backgroundColor ?? null,
      cardRadius: cardCs?.borderRadius ?? null,
      cardShadow: cardCs?.boxShadow ?? null,
      timeText: time?.innerText ?? null,
      timeDeco: timeCs?.textDecorationLine ?? null,
      timeWeight: timeCs?.fontWeight ?? null,
      titleWeight: titleCs?.fontWeight ?? null,
      railCount: document.querySelectorAll('.tl__rail, .tl__dot, .tl__line').length,
      dayNo: document.querySelector('.day__no')?.innerText ?? null,
      dateText: document.querySelector('.day__date')?.innerText ?? null,
    };
  });
  rec('A1 卡片暖灰底 card-sunk(#efe8d6)', style.cardBg === 'rgb(239, 232, 214)', style.cardBg ?? '');
  // 注：Taro H5 全局 px→rem 缩放（designWidth 375 映射到 390 视口），
  //     源里 12px 在此视口渲染为 9.6px；断言「圆角存在且无阴影」即可。
  rec(
    'A2 卡片圆角 + 无阴影',
    parseFloat(style.cardRadius) >= 8 && (!style.cardShadow || style.cardShadow === 'none'),
    `${style.cardRadius} / shadow=${style.cardShadow}`,
  );
  rec('A3 时间段有下划线 + 加粗', style.timeDeco === 'underline' && Number(style.timeWeight) >= 600, `${style.timeDeco} w=${style.timeWeight}`);
  rec('A4 标题加粗', Number(style.titleWeight) >= 600, `w=${style.titleWeight}`);
  rec('A5 旧时间轴铁轨已移除', style.railCount === 0, `rail=${
    style.railCount
  }`);
  rec('A6 天头部含「第N天」', /^第\d+天$/.test(style.dayNo ?? ''), `${style.dayNo} | ${style.dateText}`);
  await shot('01-itinerary-style');

  // B. 种子时间段渲染
  const listText = await page.evaluate(() => document.querySelector('.tl')?.innerText ?? '');
  rec('B1 种子项显示时间段 09:30-13:10', listText.includes('09:30-13:10'), '');
  rec('B2 种子项显示时间段 15:00-16:00', listText.includes('15:00-16:00'), '');

  // C. 新增带结束时间
  await page.evaluate(() => {
    const pages = [...document.querySelectorAll('.taro_page')].filter((p) => p.offsetParent !== null);
    pages[pages.length - 1]?.querySelector('.add-bar')?.click();
  });
  await sleep(900);
  const typeInto = async (idx, txt) => {
    await page.evaluate((i) => {
      const els = [...document.querySelectorAll('.taro_page .field input')];
      els[i]?.focus();
      els[i]?.click();
    }, idx);
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type(txt);
  };
  const visIdx = await page.$$eval('.taro_page .field input', (els) =>
    els.map((e, i) => (e.offsetParent !== null && e.getBoundingClientRect().width > 0 ? i : -1)).filter((i) => i >= 0),
  );
  await typeInto(visIdx[0], '时间段验证项');

  // 点「结束（选填）」picker → 弹层里点「确定」→ endTime = 当前开始时间
  const endPickerClicked = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.taro_page .picker-row')];
    // 第 3 个 picker-row = 结束时间
    const row = rows[2];
    if (!row) return false;
    row.click();
    return true;
  });
  await sleep(900);
  const popDump = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('.weui-picker__overlay')].find(
      (o) => getComputedStyle(o).display !== 'none',
    );
    return ov ? 'visible-popup' : 'none';
  });
  const confirmed = await page.evaluate(() => {
    // 关键：只在「可见」弹层里点确定（隐藏弹层也有同名按钮，会点错）
    const ov = [...document.querySelectorAll('.weui-picker__overlay')].find(
      (o) => getComputedStyle(o).display !== 'none',
    );
    if (!ov) return false;
    const okBtn = [...ov.querySelectorAll('.weui-picker__action')].find(
      (el) => (el.textContent || '').trim() === '确定',
    );
    if (!okBtn) return false;
    okBtn.click();
    return true;
  });
  await sleep(700);
  const endVal = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.taro_page .picker-row')];
    return rows[2]?.innerText?.trim() ?? null;
  });
  rec('C1 结束时间 picker 可选（弹层+确定）', endPickerClicked && confirmed, `${popDump} / endVal=${endVal}`);
  await shot('02-form-end-time');

  // 保存
  await page.evaluate(() => {
    const pages = [...document.querySelectorAll('.taro_page')].filter((p) => p.offsetParent !== null);
    const b = [...(pages[pages.length - 1]?.querySelectorAll('.btn--block') ?? [])].find((el) =>
      (el.innerText || '').trim() === '添加',
    );
    b?.click();
  });
  await sleep(1600);
  // 注意：新项会落到「对应日期」的那一天容器（可能是第 3 天的 .tl），
  // 断言必须取全部 .tl 文本（不能只取第一个）
  const allTlText = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.tl')]
        .map((t) => t.innerText)
        .join('\n'),
    );
  const afterAdd = await allTlText();
  const rangeOk = /09:00-09:00/.test(afterAdd);
  rec('C2 新增项显示时间段（endAt 端到端）', afterAdd.includes('时间段验证项') && rangeOk, rangeOk ? '09:00-09:00' : '未显示时间段');
  await shot('03-after-add-range');

  // D. 编辑清除结束时间
  const editClicked = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tl__card')];
    const target = cards.find((c) => (c.innerText || '').includes('时间段验证项'));
    const btn = target?.querySelector('.tl__ops .icon-btn');
    btn?.click();
    return !!btn;
  });
  await sleep(900);
  const clearClicked = await page.evaluate(() => {
    const t = [...document.querySelectorAll('*')].find(
      (el) => el.children.length === 0 && (el.textContent || '').trim() === '清除结束时间',
    );
    if (!t) return false;
    t.click();
    return true;
  });
  await sleep(400);
  await page.evaluate(() => {
    const pages = [...document.querySelectorAll('.taro_page')].filter((p) => p.offsetParent !== null);
    const b = [...(pages[pages.length - 1]?.querySelectorAll('.btn--block') ?? [])].find((el) =>
      (el.innerText || '').includes('保存修改'),
    );
    b?.click();
  });
  await sleep(1600);
  const afterClear = await allTlText();
  rec('D1 编辑清除结束时间 → 回落单时间', editClicked && clearClicked && !/09:00-09:00/.test(afterClear), `edit=${editClicked} clear=${clearClicked}`);
  await shot('04-after-clear');

  // 收尾：删掉验证项，保持种子数据干净
  const delOk = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tl__card')];
    const target = cards.find((c) => (c.innerText || '').includes('时间段验证项'));
    const btns = [...(target?.querySelectorAll('.tl__ops .icon-btn') ?? [])];
    btns[1]?.click();
    return btns.length > 1;
  });
  await sleep(800);
  await page.evaluate(() => document.querySelector('.taro-model__confirm')?.click());
  await sleep(1200);
  const finalText = await page.evaluate(() => document.querySelector('.tl')?.innerText ?? '');
  rec('E1 清理验证项成功', delOk && !finalText.includes('时间段验证项'), '');

  // E. 控制台
  rec('E2 console.error = 0', errs.length === 0, `${errs.length} 条`);
  errs.slice(0, 5).forEach((e) => log('   ' + e.slice(0, 160)));

  // 全页截图（新样式全景）
  await page.screenshot({ path: path.join(OUT, '05-final-fullpage.png'), fullPage: true });

  const pass = results.filter((r) => r.ok).length;
  log(`\n===== ${pass}/${results.length} 通过 =====`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
}
main().catch((e) => {
  console.error('异常：', e);
  process.exit(2);
});
