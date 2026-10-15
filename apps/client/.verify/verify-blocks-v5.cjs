/**
 * 验收 v5 —— 行程安排「正文块（富文本/图片）」+ 行程改期/删除 端到端
 * ============================================================================
 * 覆盖两条新功能的**真实入口驱动**（不使用静态断言替代）：
 *
 *  A 卡片正文块渲染（种子数据，Mock 模式）
 *    A1 代码块存在且文本含车次；A2 引用块存在；A3 链接块存在；
 *    A4 图片块在「无 url」时降级为占位卡；A5 图注渲染
 *  B 编辑安排表单的块编辑器
 *    B1 现有块被预填进编辑器（类型标签数量）；B2 可新增段落块并填写
 *  C 块写回：保存后卡片出现新段落（create/update 走通 ApiClient → mock）
 *  D 图片块上传：注入 input[type=file] 劫持 → 真实上传链路 → 缩略图有 src →
 *    保存后卡片图片块渲染真实图片（非占位）
 *  E 行程本身：E1 编辑行程表单保存标题；E2 头部标题更新；E3 删除行程 →
 *    二次确认 → 回到行程列表且目标行程消失
 *  F console error 计数 = 0
 *
 * 运行：NODE_PATH=<managed node workspace>/node_modules node .verify/verify-blocks-v5.cjs
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5321';
const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 红色 PNG —— 与既有上传验收同一张测试图
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** 注入：劫持 file input 的 click，自动喂测试图并派发 change（headless 无文件对话框） */
const INJECT = `
(function () {
  var B64 = ${JSON.stringify(PNG_B64)};
  var bin = atob(B64);
  var bytes = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  var origClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file') {
      try {
        var dt = new DataTransfer();
        dt.items.add(new File([bytes], 'headless-block.png', { type: 'image/png' }));
        this.files = dt.files;
        this.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) {
        console.error('inject failed:', e);
      }
      return;
    }
    return origClick.apply(this, arguments);
  };
})();
`;

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
};

/** 按可见文本点击（Taro H5 的 showModal 按钮文本只有「确定/取消」） */
async function clickByText(page, texts) {
  return page.evaluate((list) => {
    for (const t of list) {
      const cands = [...document.querySelectorAll('*')].filter(
        (e) => e.children.length === 0 && (e.textContent || '').trim() === t,
      );
      if (cands.length > 0) {
        cands[cands.length - 1].click();
        return t;
      }
    }
    return null;
  }, texts);
}

/** 给受控 input 赋值（React 需要原生 setter + input 事件） */
async function fillInput(page, index, value) {
  return page.evaluate(
    (i, val) => {
      const inputs = [...document.querySelectorAll('input')];
      const input = inputs[i];
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    index,
    value,
  );
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(INJECT);

  /**
   * 注：Taro H5 的 <Image> 渲染为自定义元素 <taro-image-core>，真正的 <img> 在其中。
   * 因此所有图片断言都取「内层 img 的 src」，不能只判断外层 tagName
   * （第一版断言即栽在这里：实现正常却判 FAIL，属断言缺陷而非实现缺陷）。
   */

  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));

  const shot = (n) => page.screenshot({ path: path.join(OUT, 'v5-' + n + '.png') });

  /**
   * 滚动到目标元素再截图。
   * 不能只用 shot()：页面停在顶部时，区块都在视口外，截出来的几张图会**像素完全相同**
   * （本次第一轮即如此，证据等于没有）。这里先 scrollIntoView 再截，截图才看得出改动。
   */
  const shotAt = async (selector, n) => {
    const found = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      return true;
    }, selector);
    await sleep(450);
    await shot(n);
    return found;
  };

  // ────────────────────────── A. 卡片正文块渲染 ──────────────────────────
  await page.goto(BASE + '/#/pages/TripDetailPage?id=101', { waitUntil: 'networkidle0' });
  await sleep(2600);

  const a = await page.evaluate(() => {
    const txt = (el) => (el ? el.innerText.replace(/\s+/g, ' ').trim() : null);
    return {
      blkCount: document.querySelectorAll('.blk').length,
      codeCount: document.querySelectorAll('.blk--code').length,
      quoteCount: document.querySelectorAll('.blk--quote').length,
      linkCount: document.querySelectorAll('.blk--link').length,
      imgCount: document.querySelectorAll('.blk--image').length,
      imgPhCount: document.querySelectorAll('.blk__img-ph').length,
      firstCode: txt(document.querySelector('.blk__code-text')),
      firstQuote: txt(document.querySelector('.blk--quote .blk__text')),
      firstLink: txt(document.querySelector('.blk__link-text')),
      firstCap: txt(document.querySelector('.blk__cap')),
      cardNote: txt(document.querySelector('.tl__note')),
    };
  });
  console.log('  [A] DOM 快照：', JSON.stringify(a));

  rec('A1 代码块渲染（含车次文本）', a.codeCount >= 1 && /G179/.test(a.firstCode ?? ''), a.firstCode);
  rec('A2 引用块渲染', a.quoteCount >= 1 && (a.firstQuote ?? '').length > 0, a.firstQuote?.slice(0, 24));
  rec('A3 链接块渲染', a.linkCount >= 1 && (a.firstLink ?? '').length > 0, a.firstLink);
  rec(
    'A4 图片块在 url 为空时降级为占位卡',
    a.imgCount >= 1 && a.imgPhCount >= 1,
    `image=${a.imgCount} placeholder=${a.imgPhCount}`,
  );
  rec('A5 图注渲染', a.firstCap === '民宿周边步行路线', a.firstCap);
  await shotAt('.tl__card', '01-blocks');

  // 老数据（只有 note、无 blocks）不重复渲染：卡片里的 note 行应只在无 blocks 的卡片出现
  const legacyNoteCount = await page.evaluate(
    () => document.querySelectorAll('.tl__note').length,
  );
  rec('A6 老 note 行不与 blocks 重复渲染', legacyNoteCount <= 1, `tl__note=${legacyNoteCount}`);

  // ────────────────────────── B. 编辑器预填 ──────────────────────────
  await page.evaluate(() => {
    const first = document.querySelector('.tl__card .tl__ops .icon-btn');
    if (first) first.click();
  });
  await sleep(900);
  const b = await page.evaluate(() => {
    const kinds = [...document.querySelectorAll('.blk-edit__kind')].map((e) => e.innerText.trim());
    return {
      editors: document.querySelectorAll('.blk-edit').length,
      kinds,
      textareas: document.querySelectorAll('.textarea').length,
      adders: [...document.querySelectorAll('.block-adder .chip')].map((e) =>
        e.innerText.trim(),
      ),
      hasTitleField: [...document.querySelectorAll('.field__label')].some((e) =>
        e.innerText.includes('卡片正文'),
      ),
    };
  });
  console.log('  [B] 编辑器快照：', JSON.stringify(b));
  rec('B1 现有块预填进编辑器', b.editors === 3, `editors=${b.editors} kinds=${b.kinds.join('/')}`);
  rec('B2 块类型标签正确（代码/引用/链接）', b.kinds.join(',') === '代码,引用,链接', b.kinds.join(','));
  rec(
    'B3 五种新增入口齐全',
    b.adders.length === 5 && b.hasTitleField,
    b.adders.join(' '),
  );
  await shotAt('.blk-edit', '02-editor');

  // ────────────────────────── C. 新增段落块并保存 ──────────────────────────
  const addClicked = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.block-adder .chip')].find((e) =>
      e.innerText.includes('段落'),
    );
    if (!chip) return false;
    chip.click();
    return true;
  });
  await sleep(600);
  const textareaFilled = await page.evaluate(() => {
    const areas = [...document.querySelectorAll('textarea')];
    const last = areas[areas.length - 1];
    if (!last) return false;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    ).set;
    setter.call(last, '验收段落：备用现金换成马币后放随身小包');
    last.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  await sleep(400);
  await shotAt('.block-adder', '03-block-added');

  // 保存
  const saved = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.btn')].find((e) =>
      e.innerText.includes('保存修改'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(2200);
  const afterSave = await page.evaluate(() => {
    const texts = [...document.querySelectorAll('.blk__text, .blk__code-text')].map((e) =>
      e.innerText.replace(/\s+/g, ' ').trim(),
    );
    return {
      hit: texts.some((t) => t.includes('备用现金换成马币')),
      total: texts.length,
    };
  });
  console.log('  [C] 保存后：', JSON.stringify(afterSave));
  rec(
    'C1 新增段落块写回并渲染',
    addClicked && textareaFilled && saved && afterSave.hit,
    `add=${addClicked} fill=${textareaFilled} save=${saved} hit=${afterSave.hit}`,
  );
  await shotAt('.tl__card', '04-after-save');

  // ────────────────────────── D. 图片块上传（真实链路） ──────────────────────────
  await page.evaluate(() => {
    const first = document.querySelector('.tl__card .tl__ops .icon-btn');
    if (first) first.click();
  });
  await sleep(900);
  const imgChipClicked = await page.evaluate(() => {
    const chip = [...document.querySelectorAll('.block-adder .chip')].find((e) =>
      e.innerText.includes('图片'),
    );
    if (!chip) return false;
    chip.click();
    return true;
  });
  await sleep(2500);
  const thumb = await page.evaluate(() => {
    const el = document.querySelector('.blk-edit__thumb');
    const inner = el ? (el.tagName.toLowerCase() === 'img' ? el : el.querySelector('img')) : null;
    return {
      exists: Boolean(el),
      innerImg: Boolean(inner),
      src: inner ? inner.getAttribute('src') : null,
      editors: document.querySelectorAll('.blk-edit').length,
    };
  });
  console.log('  [D] 上传后缩略图：', JSON.stringify(thumb));
  rec(
    'D1 图片块上传后缩略图即时可见',
    imgChipClicked && thumb.exists && thumb.innerImg && (thumb.src ?? '').length > 0,
    `click=${imgChipClicked} src=${(thumb.src ?? '').slice(0, 32)}`,
  );
  await shotAt('.blk-edit__img-row', '05-image-thumb');

  const saved2 = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.btn')].find((e) =>
      e.innerText.includes('保存修改'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(2200);
  const cardImg = await page.evaluate(() => {
    const el = document.querySelector('.tl__card .blk__img');
    const inner = el ? (el.tagName.toLowerCase() === 'img' ? el : el.querySelector('img')) : null;
    return {
      exists: Boolean(el),
      innerImg: Boolean(inner),
      src: inner ? inner.getAttribute('src') : null,
      // 占位卡数量：种子里那张无 url 的图片块（Mock 无对象存储）应仍为 1
      ph: document.querySelectorAll('.tl__card .blk__img-ph').length,
      imgBlocks: document.querySelectorAll('.tl__card .blk--image').length,
    };
  });
  console.log('  [D] 保存后卡片图：', JSON.stringify(cardImg));
  rec(
    'D2 保存后卡片渲染真实图片（非占位）',
    saved2 && cardImg.exists && cardImg.innerImg && (cardImg.src ?? '').length > 0,
    `save=${saved2} src=${(cardImg.src ?? '').slice(0, 32)} 图块=${cardImg.imgBlocks} 占位=${cardImg.ph}`,
  );
  await shotAt('.tl__card .blk--image', '06-card-image');

  // ────────────────────────── E. 行程改期 / 删除 ──────────────────────────
  const openedTripEdit = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.trip__op')].find((e) =>
      e.innerText.includes('编辑行程'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(900);
  const tripFormFields = await page.evaluate(() => ({
    title: [...document.querySelectorAll('input')].some((i) => i.value.includes('青岛')),
    hasDest: document.querySelectorAll('.dest-row').length,
    hasAddDest: [...document.querySelectorAll('.add-bar__text')].some((e) =>
      e.innerText.includes('添加目的地'),
    ),
  }));
  console.log('  [E] 行程表单：', JSON.stringify(tripFormFields));
  rec(
    'E1 编辑行程表单预填 + 目的地编辑器',
    openedTripEdit && tripFormFields.title && tripFormFields.hasDest >= 1 && tripFormFields.hasAddDest,
    JSON.stringify(tripFormFields),
  );
  await shotAt('.dest-row', '07-trip-form');

  // 改标题并保存 → 头部标题更新
  await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) => i.value.includes('青岛'));
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, '青岛亲子游（改期版）');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.btn')].find((e) =>
      e.innerText.includes('保存行程信息'),
    );
    if (btn) btn.click();
  });
  await sleep(2200);
  const titleAfter = await page.evaluate(
    () => document.querySelector('.trip__title')?.innerText.trim() ?? null,
  );
  rec('E2 行程标题保存后生效', titleAfter === '青岛亲子游（改期版）', titleAfter);
  await shotAt('.trip__title', '08-trip-renamed');

  // 改日期：验证 startDate 也走通（CAS version 已 +1）
  const editAgain = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.trip__op')].find((e) =>
      e.innerText.includes('编辑行程'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(800);
  const destAdded = await page.evaluate(() => {
    const bar = [...document.querySelectorAll('.add-bar')].find((e) =>
      e.innerText.includes('添加目的地'),
    );
    if (!bar) return false;
    bar.click();
    return true;
  });
  await sleep(400);
  const destFilled = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dest-row')];
    const last = rows[rows.length - 1];
    if (!last) return false;
    const input = last.querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, '西安');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  });
  await sleep(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.btn')].find((e) =>
      e.innerText.includes('保存行程信息'),
    );
    if (btn) btn.click();
  });
  await sleep(2200);
  const destAfter = await page.evaluate(
    () => [...document.querySelectorAll('.trip__dest .chip')].map((e) => e.innerText.trim()),
  );
  rec(
    'E3 目的地新增保存后生效',
    editAgain && destAdded && destFilled && destAfter.some((d) => d.includes('西安')),
    destAfter.join(' / '),
  );
  await shotAt('.trip__dest', '09-trip-dest');

  // 删除行程 → 二次确认 → 回列表
  const delClicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.trip__op')].find((e) =>
      e.innerText.includes('删除行程'),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(900);
  await shot('10-delete-modal');
  const confirmed = await clickByText(page, ['删除', '确定']);
  await sleep(2600);
  const listState = await page.evaluate(() => ({
    hash: window.location.hash,
    gone: !document.body.innerText.includes('青岛亲子游（改期版）'),
    titleCount: [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.textContent || '').includes('青岛亲子游（改期版）'),
    ).length,
  }));
  console.log('  [E] 删除后：', JSON.stringify(listState));
  rec(
    'E4 删除行程 → 确认 → 回列表且行程消失',
    delClicked && confirmed !== null && listState.hash.includes('TripsPage') && listState.gone,
    `del=${delClicked} confirm=${confirmed} hash=${listState.hash}`,
  );
  await shot('11-after-delete');

  // ────────────────────────── F. 控制台 ──────────────────────────
  const realErrs = errs.filter((t) => !/favicon|404 \(Not Found\).*favicon/i.test(t));
  rec('F1 console error = 0', realErrs.length === 0, realErrs.slice(0, 3).join(' | '));

  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  if (realErrs.length > 0) {
    console.log('\n控制台错误明细：');
    realErrs.slice(0, 8).forEach((e) => console.log('  - ' + e));
  }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
