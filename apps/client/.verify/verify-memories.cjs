const puppeteer = require('puppeteer-core');
const path = require('node:path');
const CHROME = 'C://Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const errs = [];
  p.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`.slice(0, 200)));

  // ── 首页「最近回忆」 ──
  await p.goto(`${BASE}/#/pages/HomePage`, { waitUntil: 'networkidle2' });
  await sleep(3000);
  const home = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.memo-card')];
    return {
      count: cards.length,
      titles: cards.map((c) => (c.querySelector('.memo-card__title') || {}).textContent || ''),
      subs: cards.map((c) => (c.querySelector('.memo-card__sub') || {}).textContent || ''),
      imgs: cards.map((c) => {
        const im = c.querySelector('img');
        return im ? im.getAttribute('src') || '' : '';
      }),
      hasStrip: !!document.querySelector('.memo-strip'),
      text: (document.body.innerText || '').slice(0, 300),
    };
  });
  rec('首页出现回忆卡片', home.count > 0, `${home.count} 张卡片`);
  rec('卡片标题是行程名', home.titles.some((t) => t.includes('乌镇')), home.titles.join(' / '));
  rec('封面是真实图片 URL', home.imgs.some((s) => s.includes('/media-files/')), home.imgs[0] || '(空)');
  rec('横向滑动容器存在', home.hasStrip, '');
  await p.screenshot({ path: path.join(__dirname, 'm1-home-memories.png') });

  // ── 回忆墙 ──
  await p.goto(`${BASE}/#/pages/MemoryPage`, { waitUntil: 'networkidle2' });
  await sleep(3000);
  const mem = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.memo-card--wide')];
    return {
      count: cards.length,
      titles: cards.map((c) => (c.querySelector('.memo-card__title') || {}).textContent || ''),
      text: (document.body.innerText || '').slice(0, 400),
    };
  });
  rec('回忆墙出现旅行回忆组', mem.count > 0, `${mem.count} 组`);
  rec('回忆墙标题含乌镇', mem.titles.some((t) => t.includes('乌镇')), mem.titles.join(' / '));
  rec('回忆墙不再显示「还空着」', !mem.text.includes('回忆墙还空着'), '');
  await p.screenshot({ path: path.join(__dirname, 'm2-memory-wall.png') });

  rec('无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} PASS =====`);
  await b.close();
  process.exit(pass === results.length ? 0 : 1);
})();
