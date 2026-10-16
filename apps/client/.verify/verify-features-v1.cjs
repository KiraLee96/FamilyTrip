/**
 * H5 无头验收 —— 2026-10-16 四项需求
 * ============================================================================
 * 运行前提：
 *   1. dist-h5 已构建（Mock 模式）
 *   2. .verify/server.cjs 已在 127.0.0.1:5317 提供静态服务
 * 验收点：
 *   需求① 头像可修改（H5 走 chooseImage；小程序走 chooseAvatar，编译产物另行断言）
 *     R1-1 ProfilePage 渲染头像选择器（.avatar-pick，未设头像时图标兜底）
 *     R1-2 初始无头像时图标兜底（avatar-pick 内无 img）
 *     R1-3 点击头像 → 文件选择 → 上传链路（presign→confirm→updateMe）→ 「头像已更新」
 *     R1-4 头像更新为图片（avatar-pick 内出现 img）
 *     R1-5 patchSessionUser 广播：回总览页，页眉头像同步为图片
 *   需求② 回忆入口行程只读
 *     R2-1 回忆墙渲染 TRIP 回忆卡（暑假·云南亲子环线）
 *     R2-2 链接携带 readonly=1 与 tab=memory（nav query 透传，无双重 ?）
 *     R2-3 只读 banner 展示（来自回忆墙的行程仅可查看）
 *     R2-5 回忆 tab 无「生成本次出行回忆」按钮
 *     R2-6 行程 tab 无「添加安排」
 *     R2-7 行程 tab 无单条编辑/删除（.tl__ops 不存在）
 *     R2-8 清单 tab 无添加卡（无「仅我自己」scope 片）
 *     R2-9 花销 tab 无「记一笔花销」
 *     R2-10 照片 tab 无「上传照片」上传格
 *     R2-11 无「重置邀请码」
 *     R2-12 无「编辑行程 / 删除行程」
 *     R2-13/14 对照：行程列表正常进入详情页（无 readonly）→ 有「编辑行程 / 删除行程」
 *     R2-15 对照：正常入口无只读 banner
 *   需求③ 主界面/顶部标题改为「旅行管家AllInOne」（document.title + 页头）
 *   需求④ 首页左上角头像旁无加号（head-btn--accent 不存在），右下角 FAB 保留
 *   全程 console.error / pageerror 计数为 0
 *
 * 🔴 作用域说明：Taro H5 页面栈会把下层页面保留在 DOM 里（display:none），
 *    document 级查询会命中下层页面的同名元素（如首页 RecentMemory 与回忆墙
 *    共用 MemoryCard 的 .memory__trip-title），点到下层元素不触发导航。
 *    因此所有点击/文本/计数查询都作用域到「顶层可见 .taro_page」。
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

/**
 * 顶层可见页面容器（Taro H5 页面栈：覆盖页 display:none，仅顶层 display:block）。
 * 返回 JSHandle，后续 evaluate 以其为根查询。
 */
async function topScope(page) {
  return page.evaluateHandle(() => {
    const pages = [...document.querySelectorAll('.taro_page')];
    const visible = pages.filter((el) => getComputedStyle(el).display !== 'none');
    return visible[visible.length - 1] ?? document.body;
  });
}

/** 顶层页面文本 */
async function pageText(page) {
  const scope = await topScope(page);
  const text = await page.evaluate((el) => el.innerText, scope);
  await scope.dispose();
  return text;
}

/** 点击 tabBar 项（tabBar 在页面容器之外，document 级查询） */
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

/**
 * 在顶层页面内点击包含指定文本的最小元素。
 * Link/卡片渲染为 View，文本与图标常为混合子节点，不存在「文本恰好相等」的
 * 元素叶子（文本节点不是元素）；点最小包含元素，事件冒泡到 Link 的 onClick。
 */
async function clickByText(page, text) {
  const scope = await topScope(page);
  const ok = await page.evaluate(
    (el, t) => {
      const hits = [...el.querySelectorAll('*')].filter((e) =>
        (e.textContent || '').includes(t),
      );
      if (hits.length === 0) return false;
      // document 顺序外层在前；被当前 best 包含的更内层命中即替换 → 取最内层
      let best = hits[0];
      for (const h of hits) {
        if (best.contains(h)) best = h;
      }
      best.click();
      return true;
    },
    scope,
    text,
  );
  await scope.dispose();
  return ok;
}

/** 在顶层页面内点击 tabs__btn（按精确文本，避免误点「返回行程列表」等同名包含项） */
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

/** 在顶层页面内按选择器计数/查询 */
async function countInScope(page, selector) {
  const scope = await topScope(page);
  const n = await page.evaluate((el, sel) => el.querySelectorAll(sel).length, scope, selector);
  await scope.dispose();
  return n;
}

/** 等待顶层页面文本出现（轮询） */
async function waitForText(page, text, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if ((await pageText(page)).includes(text)) return true;
    await sleep(200);
  }
  return false;
}

/** 1x1 PNG（最小合法文件，供 H5 chooseImage 上传链路使用） */
function writeTestPng() {
  const p = path.join(OUT, 'tmp-avatar-1x1.png');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(
    p,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  return p;
}

async function main() {
  const png = writeTestPng();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });

  try {
    // ── 需求③+④：总览页 ──
    let page = await newPage(browser);
    await page.goto(BASE + '/', { waitUntil: 'networkidle0', timeout: 30000 });
    await sleep(2500);

    const docTitle = await page.evaluate(() => document.title);
    record('R3-1 document.title 为「旅行管家AllInOne」', docTitle === '旅行管家AllInOne', docTitle);

    const homeText = await pageText(page);
    record('R3-2 页头大标题为「旅行管家AllInOne」', homeText.includes('旅行管家AllInOne'), '');

    const scope0 = await topScope(page);
    const headHtml = await page.evaluate((el) => {
      const head = el.querySelector('[class*="page-head"]');
      return head ? head.innerHTML : '';
    }, scope0);
    await scope0.dispose();
    record('R4-1 页头无加号按钮（head-btn--accent 已移除）', !headHtml.includes('head-btn--accent'), '');
    record('R4-2 页头保留头像入口（head-btn--avatar，点击进「我的」）', headHtml.includes('head-btn--avatar'), '');
    const fabExists = await countInScope(page, '[class*="fab"]');
    record('R4-3 右下角新建行程 FAB 保留', fabExists > 0, `count=${fabExists}`);
    await page.screenshot({ path: path.join(OUT, 'f1-home.png') });

    // ── 需求①：头像可修改 ──
    await clickTabByText(page, '我的');
    await sleep(2000);
    const profileUrl = page.url();
    record('R1-0 进入 ProfilePage', profileUrl.includes('ProfilePage'), profileUrl.split('#')[1] ?? '');

    const pickerCount = await countInScope(page, '[class*="avatar-pick"]');
    record('R1-1 账号卡渲染头像选择器（.avatar-pick）', pickerCount >= 1, `count=${pickerCount}`);

    const hasImgBefore = await countInScope(page, '[class*="avatar-pick"] img');
    record('R1-2 初始无头像时图标兜底（avatar-pick 内无 img）', hasImgBefore === 0, '');

    // H5：点击头像 → chooseImage 弹文件选择 → 选 1x1 PNG
    // 注意：本版 puppeteer-core 的 accept(paths) 内部 uploadFile(...paths) 会展开参数，
    // 必须传数组；传字符串会被拆成单字符当多个文件路径，触发 multiple 断言失败
    const [chooser] = await Promise.all([
      page.waitForFileChooser({ timeout: 8000 }),
      (async () => {
        const scope = await topScope(page);
        await page.evaluate((el) => {
          const pick = el.querySelector('[class*="avatar-pick"]');
          if (pick) pick.click();
        }, scope);
        await scope.dispose();
      })(),
    ]);
    await chooser.accept([png]);

    // 上传链路（presign→confirm→updateMe）完成后 toast「头像已更新」。
    // Taro H5 的 showToast 渲染在页面容器之外（body 级），必须 document 级轮询；
    // toast 默认约 1.5s 后消失，200ms 轮询足以捕获。
    const toastOk = await (async () => {
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const body = await page.evaluate(() => document.body.innerText);
        if (body.includes('头像已更新')) return true;
        await sleep(200);
      }
      return false;
    })();
    record('R1-3 上传链路走通并提示「头像已更新」', toastOk, '');

    await sleep(800);
    const hasImgAfter = await countInScope(page, '[class*="avatar-pick"] img');
    record('R1-4 头像更新为图片（avatar-pick 内出现 img）', hasImgAfter >= 1, `imgs=${hasImgAfter}`);
    await page.screenshot({ path: path.join(OUT, 'f2-profile-avatar.png') });

    // 广播：回总览页，页眉头像同步
    await clickTabByText(page, '总览');
    await sleep(2000);
    const scope1 = await topScope(page);
    const headAvatarImg = await page.evaluate((el) => {
      const head = el.querySelector('[class*="page-head"]');
      return head ? head.querySelectorAll('img').length : -1;
    }, scope1);
    await scope1.dispose();
    record('R1-5 页眉头像同步为图片（patchSessionUser 广播生效）', headAvatarImg >= 1, `imgs=${headAvatarImg}`);

    // ── 需求②：回忆入口只读 ──
    await clickByText(page, '回忆墙');
    await sleep(2500);
    const memUrl = page.url();
    record('R2-0 进入回忆墙 MemoryPage', memUrl.includes('MemoryPage'), memUrl.split('#')[1] ?? '');
    const memText = await pageText(page);
    record('R2-1 回忆墙渲染 TRIP 回忆卡（暑假 · 云南亲子环线）', memText.includes('暑假 · 云南亲子环线'), '');
    await page.screenshot({ path: path.join(OUT, 'f3-memory.png') });

    // 点回忆卡 → readonly 行程详情（作用域在顶层页面内，不会点到下层首页的同名卡）
    await clickByText(page, '暑假 · 云南亲子环线');
    await sleep(2500);
    const detailUrl = page.url();
    record(
      'R2-2 链接携带 readonly=1 与 tab=memory（nav query 透传，无双重 ?）',
      /TripDetailPage\?id=103&tab=memory&readonly=1/.test(decodeURIComponent(detailUrl)),
      decodeURIComponent(detailUrl.split('#')[1] ?? ''),
    );

    const detailText = await pageText(page);
    record('R2-3 只读 banner 展示（来自回忆墙的行程仅可查看）', detailText.includes('来自回忆墙的行程仅可查看'), '');
    record('R2-4 行程标题渲染（暑假 · 云南亲子环线）', detailText.includes('暑假 · 云南亲子环线'), '');
    record('R2-5 回忆 tab 无「生成本次出行回忆」按钮', !detailText.includes('生成本次出行回忆'), '');
    await page.screenshot({ path: path.join(OUT, 'f4-readonly-detail.png') });

    // 切各 tab 断言写入口全部消失
    await clickTabBtn(page, '行程');
    await sleep(1200);
    const itinText = await pageText(page);
    const tlOps = await countInScope(page, '[class*="tl__ops"]');
    record('R2-6 行程 tab 无「添加安排」', !itinText.includes('添加安排'), '');
    record('R2-7 行程 tab 无单条编辑/删除（.tl__ops 不存在）', tlOps === 0, `count=${tlOps}`);

    await clickTabBtn(page, '清单');
    await sleep(1200);
    const checkText = await pageText(page);
    record('R2-8 清单 tab 无添加卡（无「仅我自己」scope 片）', !checkText.includes('仅我自己'), '');

    await clickTabBtn(page, '花销');
    await sleep(1200);
    const expText = await pageText(page);
    record('R2-9 花销 tab 无「记一笔花销」', !expText.includes('记一笔花销'), '');

    await clickTabBtn(page, '照片');
    await sleep(1200);
    const photoText = await pageText(page);
    const addCell = await countInScope(page, '[class*="photo-cell--add"]');
    record('R2-10 照片 tab 无「上传照片」上传格', !photoText.includes('上传照片') && addCell === 0, '');

    // 全局写操作断言（当前 readonly 页）
    const roFull = await pageText(page);
    record('R2-11 无「重置邀请码」', !roFull.includes('重置邀请码'), '');
    record('R2-12 无「编辑行程 / 删除行程」', !roFull.includes('编辑行程') && !roFull.includes('删除行程'), '');
    await page.screenshot({ path: path.join(OUT, 'f5-readonly-tabs.png') });

    // ── 对照：正常入口（行程列表 → 详情页）应有编辑/删除 ──
    await clickTabByText(page, '行程');
    await sleep(2500);
    await clickByText(page, '国庆 · 青岛看海'); // Mock 首条行程（ONGOING）
    await sleep(2500);
    const normalText = await pageText(page);
    record('R2-13 对照：正常入口有「编辑行程」', normalText.includes('编辑行程'), '');
    record('R2-14 对照：正常入口有「删除行程」', normalText.includes('删除行程'), '');
    record('R2-15 对照：正常入口无只读 banner', !normalText.includes('来自回忆墙的行程仅可查看'), '');
    await page.screenshot({ path: path.join(OUT, 'f6-normal-detail.png') });

    // ── 汇总 ──
    record(
      'X1 全程 console.error / pageerror 为 0',
      consoleErrors.length === 0,
      consoleErrors.length > 0 ? consoleErrors.slice(0, 3).join(' | ') : '',
    );

    const failed = results.filter((r) => !r.ok);
    console.log('\n===== SUMMARY =====');
    console.log(`total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
    for (const f of failed) console.log(`FAIL ${f.name} ${f.detail ?? ''}`);
    fs.writeFileSync(
      path.join(OUT, 'verify-features-v1-report.json'),
      JSON.stringify({ results, consoleErrors }, null, 2),
    );
    await browser.close();
    process.exit(failed.length === 0 ? 0 : 1);
  } catch (e) {
    console.error('SCRIPT_ERROR:', e);
    await browser.close();
    process.exit(2);
  }
}

main();
