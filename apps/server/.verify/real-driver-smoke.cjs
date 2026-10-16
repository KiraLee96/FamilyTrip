#!/usr/bin/env node
/**
 * 真 driver 冒烟 —— 派发单 D-2026-10-15-02 §3.3 落地
 * ============================================================================
 * 目的：把「只在真 MySQL 上暴露的缺陷」纳入门禁。
 *
 *   此前 285 个单测跑的是 MemoryTableDriver —— BigInt 列以 JS number 落内存，
 *   `typeof v === 'bigint'` 恒假，白名单漏列**永远不会**被序列化路径碰到。
 *   真 MySQL（Prisma）下 `JSON.stringify` 遇 BigInt 直接抛
 *   `TypeError: Do not know how to serialize a BigInt` → HTTP 500 **且丢信封**。
 *   本脚本连**真驱动**起着的服务，把 trip 域最小闭环（建→查→改→删）
 *   连同 §六.3 的 media_asset 不随行程软删一并打通。
 *
 * 断言口径（不断言具体业务数据，只断言链路形状）：
 *   ① HTTP 状态码符合预期；
 *   ② 响应体可被 JSON.parse（不含 "Do not know how to serialize a BigInt"）；
 *   ③ 信封同形 {code, message, data, meta}，成功 code === 0；
 *   ④ 类型口径：雪花 id → string；version → number（与客户端契约一致）；
 *   ⑤ 409 CAS 冲突回归（乐观锁仍工作）；
 *   ⑥ 删除后读路径同形（404 / 资产不随行程软删）。
 *
 * 前置：
 *   1. MySQL 8.4 起在 127.0.0.1:3306，库 family_trip
 *   2. `prisma migrate deploy` 已执行
 *   3. `apps/server` 已 tsc 构建，`node dist/main.js` 起在 SMOKE_PORT（默认 3000，真驱动）
 *
 * 运行：node .verify/real-driver-smoke.cjs
 * 环境变量：SMOKE_HOST / SMOKE_PORT / SMOKE_PREFIX（默认 127.0.0.1 / 3000 / api）
 * 注意：本地代理会劫持 127.0.0.1 端口，故用 node http 直连（不走代理环境变量）。
 */

const http = require('http');

const HOST = process.env.SMOKE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.SMOKE_PORT ?? 3000);
const PREFIX = process.env.SMOKE_PREFIX ?? 'api';

let pass = 0;
let fail = 0;
const failures = [];

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
  return `smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 发请求，返回 { status, raw, json }；json 为 null 表示响应体不是合法 JSON */
function call(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path: `/${PREFIX}${path}`,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (d) => (raw += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            /* 保留 null */
          }
          resolve({ status: res.statusCode, raw, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 信封形状断言：{code,message,data,meta} 同形 + 可序列化（无 BigInt 泄漏痕迹） */
function envelopeOk(r) {
  return (
    r.json !== null &&
    typeof r.json === 'object' &&
    typeof r.json.code === 'number' &&
    'message' in r.json &&
    'data' in r.json &&
    !r.raw.includes('Do not know how to serialize a BigInt') &&
    !r.raw.includes('"statusCode":500')
  );
}

async function main() {
  console.log(`===== 真 driver 冒烟（${HOST}:${PORT} · driver=prisma 期望）=====\n`);

  // ── S0 登录 ──────────────────────────────────────────────────────
  const login = await call('POST', '/auth/login', { body: { code: 'acc-1' } });
  check(login.status === 200 && envelopeOk(login) && login.json?.code === 0, 'S0 登录', `HTTP ${login.status}`);
  const token = login.json?.data?.token;
  check(typeof token === 'string' && token.length > 0, 'S0 取得 token');
  if (typeof token !== 'string') {
    console.log('\n后续步骤依赖 token，中止。');
    process.exit(1);
  }

  // ── S1 建家庭 ────────────────────────────────────────────────────
  const fam = await call('POST', '/families', {
    token,
    body: { name: `冒烟家庭-${rid()}` },
  });
  check(fam.status === 200 && envelopeOk(fam) && fam.json?.code === 0, 'S1 创建家庭', `HTTP ${fam.status}`);
  const familyId = fam.json?.data?.family?.id;
  check(typeof familyId === 'string', 'S1 familyId 为 string（雪花 id 口径）', `typeof=${typeof familyId}`);

  // ── S2 创建行程（本单核心：此前此处 500 且丢信封）────────────────
  const created = await call('POST', '/trips', {
    token,
    body: {
      familyId,
      title: `冒烟行程-${rid()}`,
      startDate: '2026-11-01',
      endDate: '2026-11-03',
      destinations: [{ name: '青岛' }],
    },
  });
  check(created.status === 200 && envelopeOk(created) && created.json?.code === 0, 'S2 创建行程 200+信封', `HTTP ${created.status}`);
  const trip = created.json?.data?.trip;
  check(trip != null && typeof trip === 'object', 'S2 返回 trip 对象');
  check(typeof trip?.id === 'string', 'S2 trip.id 为 string', `typeof=${typeof trip?.id}`);
  check(typeof trip?.version === 'number', 'S2 trip.version 为 number（边界兜底口径）', `typeof=${typeof trip?.version} value=${trip?.version}`);
  const tripId = trip?.id;
  if (typeof tripId !== 'string') {
    console.log('\n未取得 tripId，中止。');
    process.exit(1);
  }

  // ── S3 行程列表 ──────────────────────────────────────────────────
  const list = await call('GET', `/trips?familyId=${encodeURIComponent(familyId)}`, { token });
  check(list.status === 200 && envelopeOk(list) && list.json?.code === 0, 'S3 行程列表 200+信封', `HTTP ${list.status}`);
  const items = list.json?.data?.items;
  check(Array.isArray(items) && items.some((t) => t?.id === tripId), 'S3 列表含新建行程');

  // ── S4 行程详情 ──────────────────────────────────────────────────
  const detail = await call('GET', `/trips/${tripId}`, { token });
  check(detail.status === 200 && envelopeOk(detail) && detail.json?.code === 0, 'S4 行程详情 200+信封', `HTTP ${detail.status}`);
  check(detail.json?.data?.trip?.id === tripId, 'S4 详情 id 一致');

  // ── S5 改期（CAS 乐观锁）────────────────────────────────────────
  const curVersion = typeof trip?.version === 'number' ? trip.version : 1;
  const patched = await call('PATCH', `/trips/${tripId}`, {
    token,
    body: { version: curVersion, title: `冒烟行程-改期-${rid()}` },
  });
  check(patched.status === 200 && envelopeOk(patched) && patched.json?.code === 0, 'S5 修改行程 200+信封', `HTTP ${patched.status}`);
  check(typeof patched.json?.data?.trip?.version === 'number' && patched.json?.data?.trip.version > curVersion, 'S5 version 递增', `${curVersion} -> ${patched.json?.data?.trip?.version}`);

  // ── S6 旧 version 再改 → 409（CAS 回归）──────────────────────────
  const conflict = await call('PATCH', `/trips/${tripId}`, {
    token,
    body: { version: curVersion, title: '旧版本号改击' },
  });
  check(conflict.status === 409 && envelopeOk(conflict), 'S6 旧 version 冲突 409（CAS 回归）', `HTTP ${conflict.status} code=${conflict.json?.code}`);

  // ── S7 media 闭环：presign → confirm → 删行程 → 资产不随行程软删 ──
  const presign = await call('POST', '/media/presign', {
    token,
    body: { familyId, fileName: 'smoke.png', mimeType: 'image/png', byteSize: '2048' },
  });
  check(presign.status === 200 && envelopeOk(presign) && presign.json?.code === 0, 'S7a 预签名 200+信封', `HTTP ${presign.status}`);
  const fileKey = presign.json?.data?.fileKey;
  check(typeof fileKey === 'string' && fileKey.length > 0, 'S7a 取得 fileKey');

  let assetId = null;
  if (typeof fileKey === 'string') {
    const confirmed = await call('POST', '/media/confirm', {
      token,
      body: {
        familyId,
        tripId,
        fileKey,
        mimeType: 'image/png',
        byteSize: '2048',
        compressed: false,
        exifStripped: true,
        hadGps: false,
        storageClass: 'STANDARD',
      },
    });
    check(confirmed.status === 200 && envelopeOk(confirmed) && confirmed.json?.code === 0, 'S7b 登记资产 200+信封', `HTTP ${confirmed.status}`);
    assetId = confirmed.json?.data?.asset?.id;
    check(typeof assetId === 'string', 'S7b assetId 为 string', `typeof=${typeof assetId}`);
  }

  const del = await call('DELETE', `/trips/${tripId}`, { token });
  check(del.status === 200 && envelopeOk(del) && del.json?.code === 0, 'S7c 删除行程 200+信封', `HTTP ${del.status}`);
  check(del.json?.data === null, 'S7c 删除响应 data:null（信封契约）');

  if (assetId !== null) {
    const media = await call('GET', `/media?familyId=${encodeURIComponent(familyId)}`, { token });
    check(media.status === 200 && envelopeOk(media) && media.json?.code === 0, 'S7d 删行程后媒体列表仍 200+信封', `HTTP ${media.status}`);
    const stillThere = Array.isArray(media.json?.data?.items) && media.json.data.items.some((a) => a?.id === assetId);
    check(stillThere, 'S7d media_asset 不随行程软删（D-2026-10-15-01 §7.2 决定真库走通）');
  }

  // ── S8 删除后读路径同形 ──────────────────────────────────────────
  const gone = await call('GET', `/trips/${tripId}`, { token });
  check(gone.status === 404 && envelopeOk(gone), 'S8 删除后详情 404（信封同形）', `HTTP ${gone.status}`);

  // ── 汇总 ────────────────────────────────────────────────────────
  console.log(`\n===== 冒烟结果：${pass} passed / ${fail} failed =====`);
  if (fail > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exit(1);
});
