/**
 * 生产版本自检（D-2026-10-26-03 §6.1 的可执行版）
 * ============================================================================
 * 判据来自「只在本轮新增的路由」：旧版没有这些路由 → 4040；新版有路由但没 token
 * → 4010。所以**不需要 token 就能判断「新版到底上没上」**。
 *
 * 用法：
 *   node .verify/prod-selfcheck.mjs
 *   BASE=https://api.familytripallinone.cn/api node .verify/prod-selfcheck.mjs
 *
 * 可选（验功能，需要真实 token）：
 *   TOKEN=xxx TRIP_ID=388... FAMILY_ID=388... node .verify/prod-selfcheck.mjs
 *
 * ⚠️ 全部是无 token 的只读探测：请求在鉴权链第 1 段就被拒，不会写入任何数据。
 */

const BASE = (process.env.BASE ?? 'https://api.familytripallinone.cn/api').replace(/\/+$/, '');
const HEALTH = BASE.replace(/\/api$/, '') + '/health';

let failed = 0;
function line(ok, name, detail) {
  if (!ok) failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail === undefined ? '' : ` → ${detail}`}`);
}

async function call(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, code: json?.code, message: json?.message };
  } catch (e) {
    return { status: -1, code: undefined, message: e instanceof Error ? e.message : String(e) };
  }
}

// ── ① 链路 ────────────────────────────────────────────────────────────
try {
  const res = await fetch(HEALTH, { signal: AbortSignal.timeout(20_000) });
  line(res.status === 200, '外网 → nginx → 服务 链路可达', `health HTTP ${res.status}`);
} catch (e) {
  line(false, '外网 → nginx → 服务 链路可达', e instanceof Error ? e.message : String(e));
}

// ── ② 版本判定（本轮新增路由：存在 = 4010，不存在 = 4040）─────────────
const probes = [
  ['POST', '/expenses/batch', { tripId: '1', familyId: '1', rows: [] }, 'POST /expenses/batch（D-2026-10-26-01）'],
  ['PATCH', '/checklists/templates/1', { version: 0 }, 'PATCH /checklists/templates/:id（D-2026-10-26-01）'],
  ['DELETE', '/checklists/templates/1', undefined, 'DELETE /checklists/templates/:id（D-2026-10-26-01）'],
];

const results = [];
for (const [method, path, body, name] of probes) {
  const r = await call(method, path, body);
  results.push(r);
  line(r.code === 4010, `新版路由存在：${name}`, `code=${String(r.code)} ${r.message ?? ''}`);
}

const oldest = await call('POST', '/trips/1/finish', { version: 0 });
line(oldest.code === 4010, '旧版路由仍在：POST /trips/:id/finish', `code=${String(oldest.code)}`);

// ── ②b 媒体上传端点（D-2026-10-26-04：旧版没有 /media-files/upload）────────
// 判据：新版的收单端点在没有签名时回 JSON 403；旧版这个路径根本不存在（404 / nginx 404 页）。
try {
  const mediaRes = await fetch(`${BASE.replace(/\/api$/, '')}/media-files/upload`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
  });
  const body = await mediaRes.text();
  const isJson = body.trim().startsWith('{');
  const parsed = isJson ? JSON.parse(body) : {};
  line(
    mediaRes.status === 403 && parsed?.code === 4030,
    '媒体收单端点已上线：POST /media-files/upload（无签名应回 403 JSON）',
    `HTTP ${mediaRes.status} ${isJson ? `code=${String(parsed?.code)}` : '非 JSON（多半是 nginx 404 页）'}`,
  );
} catch (e) {
  line(false, '媒体收单端点已上线', e instanceof Error ? e.message : String(e));
}

// ── ③ 结论 ────────────────────────────────────────────────────────────
const newRoutesPresent = results.filter((r) => r.code === 4010).length;
console.log('\n──────────── 结论 ────────────');
if (newRoutesPresent === probes.length) {
  console.log('✅ 新版后端已上线（本轮全部新增路由都在）');
  console.log('   → 接着用真 token 验 finish、同币种记账与媒体上传（见 deploy 上线清单 §5）');
} else if (newRoutesPresent === 0) {
  console.log('❌ 生产仍是旧版（10-22 构建）：本轮改动一个都没上线');
  console.log('   → 依次执行：commit+push → 服务器 git pull → install → **build** → **migrate deploy** → pm2 restart');
  console.log('   → 只 git pull + restart 没用：pm2 跑的是 dist/main.js，不 build 就是旧代码');
} else {
  console.log(`⚠️ 部分上线（${newRoutesPresent}/${probes.length}），请确认是否分批发版或有路由缺失`);
}
console.log('\n提示：媒体上传另需检查 .env 的 MEDIA_PUBLIC_BASE_URL / MEDIA_UPLOAD_SECRET 与 nginx 的 /media-files/ 两段。');

process.exit(failed === 0 ? 0 : 1);
