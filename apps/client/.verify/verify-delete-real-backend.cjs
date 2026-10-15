/**
 * 真后端 · 浏览器级端到端验收 —— 「行程删除」闭环（2026-10-15）
 * ============================================================================
 * 这是本次缺陷修复的**最强证据**，补上了此前验收的方法论缺口：
 *
 *   旧验收 17/17 全在 Mock 模式跑 —— mock 的 `deleteTrip` 直接 splice 内存数组，
 *   不经过 `unwrap()`，所以「信封把 data:null 判为异常」这个缺陷永远不会暴露。
 *   本脚本让**真实浏览器**里的**真实 createHttpClient** 打到**真实 NestJS**，
 *   服务端删成功 → 客户端必须也认为是成功。
 *
 * 前置：
 *   1. 内存驱动后端起在 127.0.0.1:3001
 *      （`DATABASE_URL= PORT=3001 CORS_ORIGIN=http://127.0.0.1:5199 node dist/main.js`
 *       —— 用内存驱动是为了绕开另一个真 MySQL 独有的 BigInt 序列化 500，
 *         否则连行程详情页都打不开，无法聚焦"删除"这一个动作）
 *   2. dist-h5 以 `API_BASE_URL=http://127.0.0.1:3001/api` 构建
 *   3. 静态服务：`.verify/server.cjs 5199`（与 CORS_ORIGIN 一致）
 *
 * 运行：
 *   CI=true node .verify/server.cjs 5199 &
 *   NODE_PATH="C:\Users\lxk\.workbuddy\binaries\node\workspace\node_modules" \
 *     CI=true node .verify/verify-delete-real-backend.cjs
 */

const http = require('http');
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const API_HOST = '127.0.0.1';
const API_PORT = 3001;
const TOKEN_KEY = 'auth_token';

const OUT = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 直连 API（不经代理）─────────────────────────────────────────────
function api(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (method !== 'GET') headers['X-Request-Id'] = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: API_HOST, port: API_PORT, path: '/api' + p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(c).toString('utf8');
        let env = null;
        try {
          env = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        resolve({ status: res.statusCode, raw, env });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const results = [];
function rec(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 点击叶子文本（Taro H5 的 confirm 按钮就是普通 DOM） */
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

async function main() {
  console.log('===== 真后端 · 浏览器级「行程删除」验收 =====\n');

  // ── 1. 播种：真接口建用户 / 家庭 / 行程 ─────────────────────────
  const login = await api('POST', '/auth/login', { code: `e2e-real-${Date.now().toString(36)}` });
  const token = login.env?.data?.token;
  rec('1.1 真后端登录', Boolean(token), `HTTP ${login.status}`);
  if (!token) throw new Error('登录失败：' + login.raw.slice(0, 300));

  const fam = await api('POST', '/families', { name: `E2E家庭-${Date.now().toString(36)}` }, token);
  const familyId = fam.env?.data?.family?.id;
  rec('1.2 建家庭', Boolean(familyId), `familyId=${familyId}`);

  const created = await api(
    'POST',
    '/trips',
    {
      familyId,
      title: 'E2E 待删行程',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      destinations: [{ name: '西安' }],
    },
    token,
  );
  const tripId = created.env?.data?.trip?.id;
  rec('1.3 建行程（真接口）', Boolean(tripId), `HTTP ${created.status} tripId=${tripId}`);
  if (!tripId) throw new Error('建行程失败：' + created.raw.slice(0, 300));

  const before = await api('GET', `/trips?familyId=${familyId}`, undefined, token);
  rec(
    '1.4 行程在服务端列表中',
    (before.env?.data?.items ?? []).some((x) => String(x.id) === String(tripId)),
    `items=${(before.env?.data?.items ?? []).length}`,
  );

  // ── 2. 浏览器：注入 token，进入行程详情 ─────────────────────────
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });

  const consoleErrors = [];
  const wire = []; // { method, url, status, body }

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    page.on('console', (m) => {
      // 带上资源 URL：控制台文本只有「Failed to load resource...」，
      // 不带 URL 就无法判断是 favicon 还是真业务资源
      const loc = typeof m.location === 'function' ? m.location() : null;
      if (m.type() === 'error') consoleErrors.push(`${m.text()}${loc?.url ? ' <' + loc.url + '>' : ''}`);
    });
    page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));

    // Taro H5 setStorageSync → localStorage[key] = JSON.stringify({ data })
    await page.evaluateOnNewDocument(
      (k, t) => {
        window.localStorage.setItem(k, JSON.stringify({ data: t }));
      },
      TOKEN_KEY,
      token,
    );

    // 抓真实 HTTP 线上流量（证明客户端真的把 DELETE 发了出去）
    page.on('response', async (res) => {
      const req = res.request();
      if (req.method() !== 'DELETE') return;
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
      wire.push({ method: req.method(), url: req.url(), status: res.status(), body });
    });

    await page.goto(`${BASE}/#/pages/TripDetailPage?id=${tripId}`, { waitUntil: 'networkidle0' });
    await sleep(3000);

    const detailText = await page.evaluate(() => document.body.innerText);
    rec(
      '2.1 详情页经真接口渲染（标题来自服务端）',
      detailText.includes('E2E 待删行程'),
      `含标题=${detailText.includes('E2E 待删行程')}`,
    );
    rec(
      '2.2 删除入口存在',
      await page.evaluate(() =>
        [...document.querySelectorAll('.trip__op')].some((e) => e.innerText.includes('删除行程')),
      ),
      '',
    );

    // ── 3. 点删除 → 二次确认 ──────────────────────────────────────
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.trip__op')].find((e) =>
        e.innerText.includes('删除行程'),
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    rec('3.1 点击「删除行程」', clicked, '');
    await sleep(900);
    await page.screenshot({ path: path.join(OUT, 'real-01-delete-modal.png') });

    const modalText = await page.evaluate(() => document.body.innerText);
    rec('3.2 二次确认弹层出现', /确定删除/.test(modalText), '');

    const confirmed = await clickByText(page, ['删除', '确定']);
    rec('3.3 点击确认', Boolean(confirmed), `命中文本=${confirmed}`);
    await sleep(3500);

    // ── 4. 🔴 断言：真实 DELETE 出去且服务端认成功 ────────────────
    const del = wire.find((w) => w.url.includes(`/trips/${tripId}`));
    rec('4.1 浏览器真实发出了 DELETE /trips/:id', Boolean(del), del ? del.url.replace(/^https?:\/\/[^/]+/, '') : '未捕获');
    rec('4.2 服务端返回 HTTP 200', del?.status === 200, del ? `HTTP ${del.status}` : 'n/a');

    let delEnv = null;
    try {
      delEnv = del ? JSON.parse(del.body) : null;
    } catch {
      /* ignore */
    }
    rec('4.3 响应信封 code = 0', delEnv?.code === 0, delEnv ? `code=${delEnv.code}` : 'n/a');
    rec(
      '4.4 【关键】响应 data 为 null —— 修复前客户端在此抛异常',
      delEnv?.data === null,
      `data=${JSON.stringify(delEnv?.data)}`,
    );

    // ── 5. 断言：界面不再停留在详情页 ─────────────────────────────
    const after = await page.evaluate(() => ({
      hash: location.hash,
      text: document.body.innerText,
      toasts: [...document.querySelectorAll('*')]
        .filter((e) => e.children.length === 0 && /删除失败|响应 data 为空/.test(e.textContent || ''))
        .map((e) => e.textContent.trim()),
    }));
    rec('5.1 已离开详情页（回到行程列表）', after.hash.includes('TripsPage'), `hash=${after.hash}`);
    rec('5.2 未出现「删除失败 / 响应 data 为空」提示', after.toasts.length === 0, after.toasts.join(' | ') || '无');
    await page.screenshot({ path: path.join(OUT, 'real-02-after-delete.png') });

    // ── 6. 断言：服务端确实删掉了（不是假象）──────────────────────
    const afterSrv = await api('GET', `/trips?familyId=${familyId}`, undefined, token);
    const stillThere = (afterSrv.env?.data?.items ?? []).some((x) => String(x.id) === String(tripId));
    rec('6.1 服务端列表中已无该行程', !stillThere, `items=${(afterSrv.env?.data?.items ?? []).length}`);

    const getDeleted = await api('GET', `/trips/${tripId}`, undefined, token);
    rec('6.2 GET 已删行程 → 404', getDeleted.status === 404, `HTTP ${getDeleted.status}`);

    // 已知无害项（不是本次缺陷，也不影响删除链路）：
    //   · favicon
    //   · media.local 占位图床（本地联调故意配的假域名，图必然不可达）
    //   · /trips/:id/invite —— 邀请码端点后端尚未落地（派发单 D-2026-10-14-02，
    //     见 D-2026-10-15-01 §七 C3 记 N/A）。TripInviteCard 会请求它并优雅降级。
    const benign = /favicon|media\.local|\/api\/trips\/\d+\/invite/i;
    const realErrs = consoleErrors.filter((t) => !benign.test(t));
    const filtered = consoleErrors.filter((t) => benign.test(t));
    rec('7.1 console error = 0（真实错误）', realErrs.length === 0, realErrs.slice(0, 3).join(' | ') || '无');
    if (filtered.length > 0) {
      console.log(`  （已排除 ${filtered.length} 条已知无害项）`);
      filtered.slice(0, 3).forEach((t) => console.log('    · ' + t.slice(0, 140)));
    }

    // ── 清理 ────────────────────────────────────────────────────
    if (familyId) await api('DELETE', `/families/${familyId}`, undefined, token);
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n===== 真后端浏览器级验收：${pass}/${results.length} 通过 =====`);
  if (pass !== results.length) {
    console.log('失败用例：');
    results.filter((r) => !r.ok).forEach((r) => console.log('  ✗ ' + r.name));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exitCode = 2;
});
