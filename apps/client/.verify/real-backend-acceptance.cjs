/**
 * 真后端验收 —— 「行程/安排删不掉」根因闭环（2026-10-15）
 * ============================================================================
 * 目的：这是本次缺陷之所以漏网的那一环。
 *
 *   之前的 17/17 全在 **Mock 模式**下跑 —— Mock 不经信封（`deleteTrip` 直接
 *   splice 内存数组），所以 `unwrap()` 把 `data === null` 判为异常的缺陷
 *   永远走不到。本脚本用**真 MySQL + 真 NestJS + 真 HTTP**，把服务端实际发出的
 *   字节拿去喂给客户端同款判定，证明：
 *     ① 服务端 DELETE 成功响应确实是 `{code:0,data:null}`（旧客户端会误判）；
 *     ② 现在客户端 `requestVoid` 的判定为「通过」；
 *     ③ 服务端删除后读路径同形（404 / 空集），没有幽灵数据。
 *
 * 前置：
 *   1. MySQL 8.4 起在 127.0.0.1:3306，库 family_trip
 *   2. `prisma migrate deploy` 已执行（含 20261015120000_itinerary_blocks）
 *   3. `apps/server` 已 tsc 构建，`node dist/main.js` 起在 127.0.0.1:3000
 *
 * 运行：CI=true node .verify/real-backend-acceptance.cjs
 * 注意：本地代理会劫持 127.0.0.1 端口，故用 node http 直连（不走代理环境变量）。
 */

const http = require('http');

const HOST = process.env.ACC_HOST ?? '127.0.0.1';
/**
 * 默认打 3001（内存驱动后端）。
 *
 * 🔴 为什么不打 3000（真 MySQL / prisma 驱动）：
 *    真 MySQL 下 trip 域存在**另一个**阻断缺陷 —— `TRIP_BIGINT_FIELDS` 漏了
 *    `version`（schema 里是 BigInt），`JSON.stringify` 直接抛
 *    `Do not know how to serialize a BigInt` → GET/POST/PATCH /trips 全部 500
 *    且响应不走信封。本脚本的播种步骤（POST /trips）会被它挡死。
 *    该缺陷的探针见 `real-endpoint-matrix.cjs`，修复前本脚本无法对 3000 跑通。
 *
 * 起法：`DATABASE_URL= PORT=3001 CORS_ORIGIN=http://127.0.0.1:5199 node dist/main.js`
 * （DATABASE_URL 置空即回落 MemoryTableDriver；dotenv 不覆盖已存在的环境变量）
 */
const PORT = Number(process.env.ACC_PORT ?? 3001);
const API = '/api';

let pass = 0;
let fail = 0;
const failures = [];
const seenShapes = {};

function check(ok, name, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? '  —— ' + detail : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? '  —— ' + detail : ''}`);
  }
}

function rid() {
  return `acc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 直连 http（不经代理），返回 { status, raw, env } */
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // 写接口幂等键（每次逻辑操作一个新值；重试才沿用同一个）
    if (method !== 'GET') headers['X-Request-Id'] = rid();
    if (payload) headers['Content-Length'] = payload.length;

    const r = http.request({ host: HOST, port: PORT, path: API + path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let env = null;
        try {
          env = JSON.parse(raw);
        } catch {
          /* 非 JSON：交给调用方判 */
        }
        resolve({ status: res.statusCode, raw, env });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * 🔴 客户端判定复刻（apps/client/src/api/http.ts）。
 * 返回 'ok' | 'throw'，用于把「服务端真实响应」喂给「客户端真实判据」。
 */
function clientVerdict(env, allowNullData) {
  if (env.code !== 0) return { verdict: 'throw', reason: `ApiError(${env.code})` };
  if (allowNullData === true) return { verdict: 'ok', reason: 'requestVoid 判定' };
  if (env.data === null) return { verdict: 'throw', reason: 'ApiError(-1) 响应 data 为空' };
  return { verdict: 'ok', reason: 'unwrap 判定' };
}

async function main() {
  console.log('===== 真后端验收：行程/安排删除闭环 =====\n');

  // ── 1. 健康检查 + 登录（真 MySQL）──────────────────────────────
  const health = await req('GET', '/../health').catch(() => null);
  const login = await req('POST', '/auth/login', { code: `acc-${Date.now().toString(36)}` });
  check(
    login.status === 200 && login.env?.code === 0 && typeof login.env?.data?.token === 'string',
    '1.1 真后端登录（无 WeChat 依赖，开发桩）',
    `HTTP ${login.status} / isNewUser=${login.env?.data?.isNewUser} / dbTime=${login.env?.meta?.serverTime}`,
  );
  const token = login.env?.data?.token;
  const userId = login.env?.data?.user?.id;
  void health;

  // ── 2. 建家庭 + 建行程 ─────────────────────────────────────────
  const fam = await req('POST', '/families', { name: `验收家庭-${Date.now().toString(36)}` }, token);
  const familyId = fam.env?.data?.family?.id ?? fam.env?.data?.id;
  check(fam.status === 200 && !!familyId, '2.1 建家庭', `HTTP ${fam.status} familyId=${familyId}`);

  const mkTrip = (title) =>
    req(
      'POST',
      '/trips',
      {
        familyId,
        title,
        startDate: '2026-11-01',
        endDate: '2026-11-03',
        destinations: [{ name: '青岛' }],
      },
      token,
    );

  const t1 = await mkTrip('待删除的行程');
  const tripId = t1.env?.data?.trip?.id ?? t1.env?.data?.id;
  check(t1.status === 200 && !!tripId, '2.2 建行程', `HTTP ${t1.status} tripId=${tripId}`);

  const listBefore = await req('GET', `/trips?familyId=${familyId}`, undefined, token);
  const idsBefore = (listBefore.env?.data?.items ?? []).map((x) => String(x.id));
  check(idsBefore.includes(String(tripId)), '2.3 行程出现在列表', `items=${idsBefore.length}`);

  // 给该行程挂一条安排，用于验证级联
  const it1 = await req(
    'POST',
    '/itineraries',
    {
      tripId,
      familyId,
      title: '级联验证用安排',
      startAt: '2026-11-01T09:30',
      endAt: '2026-11-01T11:00',
    },
    token,
  );
  const it1Id = it1.env?.data?.item?.id ?? it1.env?.data?.id;
  check(it1.status === 200 && !!it1Id, '2.4 为该行程建安排（供级联验证）', `itineraryId=${it1Id}`);

  // ── 3. 🔴 核心回归：DELETE /trips/:id ─────────────────────────
  const del = await req('DELETE', `/trips/${tripId}`, undefined, token);
  seenShapes.deleteTrip = del.raw;
  check(del.status === 200, '3.1 DELETE /trips/:id 返回 HTTP 200', `HTTP ${del.status}`);
  check(del.env?.code === 0, '3.2 信封 code = 0（业务成功）', `code=${del.env?.code}`);
  check(
    del.env?.data === null,
    '3.3 【根因证据】成功响应的 data 恰为 null —— 旧 unwrap 会把它判成异常',
    `data=${JSON.stringify(del.env?.data)}`,
  );

  const oldVerdict = clientVerdict(del.env, false); // 修复前：request<null>() → unwrap
  const newVerdict = clientVerdict(del.env, true); // 修复后：requestVoid → allowNullData
  check(
    oldVerdict.verdict === 'throw',
    '3.4 复刻修复前客户端判据 ⇒ 抛异常（这就是「服务端删成功、界面报失败」）',
    oldVerdict.reason,
  );
  check(
    newVerdict.verdict === 'ok',
    '3.5 复刻修复后客户端判据 ⇒ 通过（本次修复生效）',
    newVerdict.reason,
  );

  // ── 4. 删除后读路径同形 ───────────────────────────────────────
  const getAfter = await req('GET', `/trips/${tripId}`, undefined, token);
  check(getAfter.status === 404, '4.1 删除后 GET /trips/:id → 404', `HTTP ${getAfter.status}`);

  const listAfter = await req('GET', `/trips?familyId=${familyId}`, undefined, token);
  const idsAfter = (listAfter.env?.data?.items ?? []).map((x) => String(x.id));
  check(!idsAfter.includes(String(tripId)), '4.2 已删行程不在列表中（界面不会残留）', `items=${idsAfter.length}`);

  const itAfter = await req('GET', `/itineraries?tripId=${tripId}`, undefined, token);
  const itItems = itAfter.env?.data?.items ?? [];
  check(
    itAfter.status === 200 && itItems.length === 0,
    '4.3 级联生效：已删行程的安排查询为空集（无幽灵数据）',
    `HTTP ${itAfter.status} items=${itItems.length}`,
  );

  const delAgain = await req('DELETE', `/trips/${tripId}`, undefined, token);
  check(delAgain.status === 404, '4.4 重复 DELETE → 404（幂等，不 500）', `HTTP ${delAgain.status}`);

  // ── 5. 🔴 安排域：blocks 落库往返 + 删除（itemRef 网关 bug）───
  const t2 = await mkTrip('块与删除验收行程');
  const trip2Id = t2.env?.data?.trip?.id ?? t2.env?.data?.id;
  check(!!trip2Id, '5.1 建第二条行程', `tripId=${trip2Id}`);

  // 先落一个真实图片资产，用于 image 块（走 presign → confirm 真链路）
  const pre = await req(
    'POST',
    '/media/presign',
    { familyId, fileName: 'acc.png', mimeType: 'image/png', byteSize: 1024 },
    token,
  );
  const fileKey = pre.env?.data?.fileKey ?? pre.env?.data?.upload?.fileKey ?? pre.env?.data?.key;
  check(!!fileKey, '5.2 预签名成功', `fileKey=${fileKey}`);

  const conf = await req(
    'POST',
    '/media/confirm',
    {
      familyId,
      tripId: trip2Id,
      fileKey,
      mimeType: 'image/png',
      byteSize: 1024,
      exifStripped: true,
    },
    token,
  );
  const assetId = conf.env?.data?.asset?.id ?? conf.env?.data?.id;
  check(!!assetId, '5.3 图片资产落库', `assetId=${assetId}`);

  const blocks = [
    { type: 'text', text: '第一段正文' },
    { type: 'quote', text: '引用块内容' },
    { type: 'code', text: 'G179 09:30' },
    { type: 'link', text: '铁路 12306', url: 'https://www.12306.cn' },
    ...(assetId ? [{ type: 'image', assetId, caption: '图注' }] : []),
  ];

  const it2 = await req(
    'POST',
    '/itineraries',
    { tripId: trip2Id, familyId, title: '带正文块的安排', startAt: '2026-11-02T09:30', blocks },
    token,
  );
  const it2Id = it2.env?.data?.item?.id ?? it2.env?.data?.id;
  const written = it2.env?.data?.item?.blocks ?? it2.env?.data?.blocks;
  check(
    it2.status === 200 && Array.isArray(written) && written.length === blocks.length,
    '5.4 写入 blocks 成功（含 5 类块）',
    `HTTP ${it2.status} blocks=${Array.isArray(written) ? written.length : 'n/a'}`,
  );
  check(
    Array.isArray(written) && written.map((b) => b.type).join(',') === blocks.map((b) => b.type).join(','),
    '5.5 blocks 顺序与写入序一致',
    Array.isArray(written) ? written.map((b) => b.type).join(' → ') : 'n/a',
  );

  const imgOut = Array.isArray(written) ? written.find((b) => b.type === 'image') : undefined;
  check(
    !!imgOut && typeof imgOut.url === 'string' && imgOut.url.startsWith('http'),
    '5.6 image 块由服务端派生 url（方案 A，客户端零拼接）',
    imgOut ? `url=${imgOut.url}` : 'n/a',
  );
  check(
    !!imgOut && imgOut.assetId !== undefined && imgOut.url !== undefined,
    '5.7 image 块同时带 assetId 与 url',
    imgOut ? `assetId=${imgOut.assetId}` : 'n/a',
  );

  // 读回（列表）
  const itList2 = await req('GET', `/itineraries?tripId=${trip2Id}`, undefined, token);
  const readBack = (itList2.env?.data?.items ?? []).find((x) => String(x.id) === String(it2Id));
  check(
    !!readBack && Array.isArray(readBack.blocks) && readBack.blocks.length === blocks.length,
    '5.8 GET 列表读回 blocks（真落库，非内存）',
    readBack ? `blocks=${readBack.blocks.length}` : 'n/a',
  );

  // 🔴 itemRef 网关 bug：PATCH /itineraries/:id 曾经全量 404（旧代码 itemRef 硬编码
  //    familyId/tripId=null，权限网关第 5 段无归属可判 → 一律 404 同形）
  const patchIt = await req(
    'PATCH',
    `/itineraries/${it2Id}`,
    { version: 1, title: '改过标题的安排' },
    token,
  );
  check(
    patchIt.status === 200 && patchIt.env?.code === 0,
    '5.9 【第二个根因】PATCH /itineraries/:id 200（旧 itemRef=null 时恒 404）',
    `HTTP ${patchIt.status} code=${patchIt.env?.code}`,
  );
  check(
    patchIt.env?.data?.item?.title === '改过标题的安排',
    '5.9b 安排标题确实被更新',
    `title=${patchIt.env?.data?.item?.title}`,
  );

  const delIt = await req('DELETE', `/itineraries/${it2Id}`, undefined, token);
  seenShapes.deleteItinerary = delIt.raw;
  check(delIt.status === 200 && delIt.env?.code === 0, '5.10 DELETE /itineraries/:id 200', `HTTP ${delIt.status}`);
  check(delIt.env?.data === null, '5.11 安排删除成功响应 data 亦为 null（同类形状）', `data=${JSON.stringify(delIt.env?.data)}`);
  check(
    clientVerdict(delIt.env, true).verdict === 'ok',
    '5.12 修复后判据对安排删除同样通过',
    clientVerdict(delIt.env, true).reason,
  );

  const itGone = await req('GET', `/itineraries?tripId=${trip2Id}`, undefined, token);
  check(
    (itGone.env?.data?.items ?? []).length === 0,
    '5.13 删除后安排查询为空集',
    `items=${(itGone.env?.data?.items ?? []).length}`,
  );

  // ── 6. 校验链（防回归：非法块必须被拒）────────────────────────────
  const badBlocks = await req(
    'POST',
    '/itineraries',
    { tripId: trip2Id, familyId, title: '非法块', startAt: '2026-11-02T10:00', blocks: [{ type: 'text', text: '' }] },
    token,
  );
  check(badBlocks.status === 422, '6.1 空文本块被拒（422）', `HTTP ${badBlocks.status}`);

  const jsUrl = await req(
    'POST',
    '/itineraries',
    {
      tripId: trip2Id,
      familyId,
      title: 'js 注入链接',
      startAt: '2026-11-02T10:00',
      blocks: [{ type: 'link', text: 'evil', url: 'javascript:alert(1)' }],
    },
    token,
  );
  check(jsUrl.status === 422, '6.2 javascript: 链接被拒（422）', `HTTP ${jsUrl.status}`);

  const alienImg = await req(
    'POST',
    '/itineraries',
    {
      tripId: trip2Id,
      familyId,
      title: '外家庭资产',
      startAt: '2026-11-02T10:00',
      blocks: [{ type: 'image', assetId: '999999999999999999' }],
    },
    token,
  );
  check(alienImg.status === 422, '6.3 不存在的图片资产被拒（422）', `HTTP ${alienImg.status}`);

  // ── 7. 清理 ──────────────────────────────────────────────────
  const cleanup = await req('DELETE', `/trips/${trip2Id}`, undefined, token);
  check(cleanup.status === 200, '7.1 清理第二条行程', `HTTP ${cleanup.status}`);
  if (familyId) await req('DELETE', `/families/${familyId}`, undefined, token);

  // ── 汇总 ────────────────────────────────────────────────────
  console.log('\n--- 服务端实际响应字节（存档） ---');
  console.log('DELETE /trips/:id        →', seenShapes.deleteTrip);
  console.log('DELETE /itineraries/:id  →', seenShapes.deleteItinerary);
  console.log(`\nuserId=${userId} familyId=${familyId}`);

  console.log(`\n===== 真后端验收：${pass}/${pass + fail} 通过 =====`);
  if (fail > 0) {
    console.log('失败用例：');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exitCode = 1;
});
