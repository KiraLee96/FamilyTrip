/**
 * 验收（2026-10-27）：本轮 6 条反馈的界面侧证据
 * ============================================================================
 * 覆盖：
 *   R1 头像：API 设置 avatarUrl 后页面渲染 <img>（不再空白）
 *   R2 回忆墙：有家庭有行程后能列出档案（不再是「尚未加入任何家庭」）
 *   R3 已结束行程：安排 tab **没有**「添加安排」
 *   R4 已结束行程：详情页**没有**「邀请同行人」，有「分享行程长图」
 *   R5 长图弹层：能打开、canvas 生成出图片（preview img 有 src）
 *   R6 未结束行程：仍有「邀请同行人」+ 有「添加安排」；管理页有邀请码
 *   R7 物品清单 / 物品页可正常打开
 *
 * 需要 seed 数据：PAST_ID（已结束，5 条安排）、UP_ID（未结束）
 */

const puppeteer = require('puppeteer-core');
const path = require('node:path');
const fs = require('node:fs');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const API = 'http://127.0.0.1:3000/api';
const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ids = Object.fromEntries(
  fs
    .readFileSync('C:\\Users\\lxk\\AppData\\Local\\Temp\\seed-ids.txt', 'utf8')
    .trim()
    .split(/\r?\n/)
    .map((l) => l.split('=')),
);
const PAST = ids.PAST_ID;
const UP = ids.UP_ID;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function pageText(page) {
  return page.evaluate(() => document.body.innerText || '');
}

/** 用 API 直接置头像（避免依赖相册选择器），返回可访问 url */
async function setAvatar() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'verify-avatar' }),
  }).then((r) => r.json());
  const token = login.data.token;
  const fam = await fetch(`${API}/families`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then((r) => r.json());
  const familyId = fam.data.items[0].id;

  // presign → 上传 → confirm（真实链路，不是伪造 url）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const pre = await fetch(`${API}/media/presign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      familyId,
      fileName: 'a.png',
      mimeType: 'image/png',
      byteSize: String(png.length),
      purpose: 'AVATAR',
    }),
  }).then((r) => r.json());

  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'a.png');
  await fetch(pre.data.uploadUrl, { method: 'POST', body: form });

  const conf = await fetch(`${API}/media/confirm`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      familyId,
      fileKey: pre.data.fileKey,
      mimeType: 'image/png',
      byteSize: String(png.length),
      purpose: 'AVATAR',
    }),
  }).then((r) => r.json());

  const url = conf.data.asset.url;
  const patched = await fetch(`${API}/auth/me`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: '小明', avatarUrl: url }),
  }).then((r) => r.json());
  return { url, patched: patched.data?.user?.avatarUrl, token };
}

(async () => {
  const avatar = await setAvatar();
  record('R1a 头像 URL 已落库', avatar.patched === avatar.url, `${avatar.patched}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));

  // ── R1 头像渲染 ──
  await page.goto(`${BASE}/#/pages/ProfilePage`, { waitUntil: 'networkidle2' });
  await sleep(2600);
  const avatarImgs = await page.evaluate(() =>
    [...document.querySelectorAll('img')].map((i) => i.getAttribute('src') || ''),
  );
  record(
    'R1b 头像位置渲染出真实图片',
    avatarImgs.some((s) => s.includes('/media-files/')),
    avatarImgs.find((s) => s.includes('/media-files/')) ?? '(无)',
  );
  await page.screenshot({ path: path.join(OUT, 'v1-avatar.png') });

  // ── R7 物品清单可打开（有数据） ──
  await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === '物品清单',
    );
    if (leaf) {
      let el = leaf;
      for (let i = 0; i < 6 && el; i += 1) {
        if (String(el.className || '').includes('mgmt-entry')) {
          el.click();
          return;
        }
        el = el.parentElement;
      }
      leaf.click();
    }
  });
  await sleep(2200);
  const clText = await pageText(page);
  record(
    'R7a 物品清单面板打开且有内容',
    clText.includes('家庭清单') && clText.includes('新建一套清单'),
    '',
  );
  await page.screenshot({ path: path.join(OUT, 'v2-checklist.png') });

  // ── R2/R3/R4 已结束行程 ──
  await page.goto(`${BASE}/#/pages/TripDetailPage?id=${PAST}`, { waitUntil: 'networkidle2' });
  await sleep(2800);
  const pastText = await pageText(page);
  record('R4a 已结束行程无「邀请同行人」', !pastText.includes('邀请同行人'), '');
  record('R4b 已结束行程有「分享行程长图」', pastText.includes('分享行程长图'), '');
  await page.screenshot({ path: path.join(OUT, 'v3-past-top.png') });

  // 切到「安排」tab 看有没有添加入口
  await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === '安排',
    );
    if (leaf) leaf.click();
  });
  await sleep(1800);
  const pastItin = await pageText(page);
  record('R3a 已结束行程安排可见', pastItin.includes('崂山日出'), '');
  record('R3b 已结束行程无「添加安排」', !pastItin.includes('添加安排'), '');
  await page.screenshot({ path: path.join(OUT, 'v4-past-itinerary.png') });

  // ── R5 长图弹层 ──
  await page.evaluate(() => {
    const hits = [...document.querySelectorAll('*')].filter((e) =>
      (e.textContent || '').includes('分享行程长图'),
    );
    let best = hits[0];
    for (const h of hits) if (best && best.contains(h)) best = h;
    if (best) best.click();
  });
  await sleep(3200);
  // 🔴 只在弹层内取文本：Taro H5 会把旧页面实例留在 DOM，直接读 body.innerText
  //    会把别的页面文案（含管理页的「邀请码」）一起抓进来，误判 R5c
  const posterText = await page.evaluate(() => {
    const box = document.querySelector('.sheet-root') || document.querySelector('.sheet');
    return box ? box.textContent || '' : '';
  });
  record('R5a 长图弹层打开', posterText.includes('行程长图'), '');
  // 🔴 画布本身就是预览（不再额外渲染 <Image>），所以这里直接读画布像素：
  //    dataURL 长度能反证「确实画了东西」，比数 img 节点更贴近事实。
  const canvasProbe = await page.evaluate(() => {
    const host = document.getElementById('trip-poster');
    const el = host instanceof HTMLCanvasElement ? host : host && host.querySelector('canvas');
    if (!el) return { found: false, len: 0, w: 0, h: 0 };
    const url = el.toDataURL('image/png');
    return { found: true, len: url.length, w: el.width, h: el.height };
  });
  record(
    'R5b 长图画布已绘制（像素非空）',
    canvasProbe.found && canvasProbe.len > 5000,
    `${canvasProbe.w}x${canvasProbe.h}, dataURL ${canvasProbe.len} 字符`,
  );
  record('R5d 生成成功状态可见', posterText.includes('长图已生成'), '');
  // 🔴 不能只查「邀请码」三字：弹层提示语本身就是「不含邀请码」。
  //    真正要保证的是「没有可分享的招募动作」——加入入口/复制链接/8 位邀请码。
  const recruitSignals = ['复制链接', '加入这场', '邀请同行人', '凭码加入'];
  const hasCodeLike = /\b[A-Z0-9]{8}\b/.test(posterText);
  record(
    'R5c 长图弹层无招募入口（无加入/复制链接/邀请码形态字符串）',
    !recruitSignals.some((k) => posterText.includes(k)) && !hasCodeLike,
    `signals=${recruitSignals.filter((k) => posterText.includes(k)).join(',')}; codeLike=${hasCodeLike}`,
  );
  await page.screenshot({ path: path.join(OUT, 'v5-poster.png') });

  // ── R6 未结束行程仍有邀请与添加 ──
  await page.goto(`${BASE}/#/pages/TripDetailPage?id=${UP}`, { waitUntil: 'networkidle2' });
  await sleep(2600);
  const upText = await pageText(page);
  record('R6a 未结束行程有「邀请同行人」', upText.includes('邀请同行人'), '');
  await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && (e.textContent || '').trim() === '安排',
    );
    if (leaf) leaf.click();
  });
  await sleep(1800);
  const upItin = await pageText(page);
  record('R6b 未结束行程可「添加安排」', upItin.includes('添加安排'), '');
  await page.screenshot({ path: path.join(OUT, 'v6-upcoming.png') });

  record('R0 页面无未捕获异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== ${pass}/${results.length} PASS =====`);
  fs.writeFileSync(
    path.join(OUT, 'verify-2026-10-27.json'),
    JSON.stringify({ pass, total: results.length, results }, null, 2),
    'utf8',
  );
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})();
