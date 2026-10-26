/**
 * D-2026-10-26-02 · 真实 HTTP 探针（内存驱动，走完整 8 段链 + Nest 装配）
 *
 * 验证三件事在**真进程**里成立（不是只在单测里）：
 *   1. main.ts 装上自动完结定时器后，服务能正常起来（配置解析/日志/不崩）；
 *   2. 读路径惰性流转：过期行程 GET /trips/:id 即变 FINISHED + 历史只读；
 *   3. 归档行程 media 可写（P0-2）、finish 幂等（P2-1）、列表带 memberCount（P1-1）。
 *
 * 用法：BASE=http://127.0.0.1:3211/api node .verify/http-probe-2026-10-26-02.mjs
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3211/api';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name} → ${detail}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

const code = `probe${Date.now()}`;

// ① 登录 → 家庭 → 行程（日期设成已过期）
const login = await call('POST', '/auth/login', { body: { code } });
const token = login.body?.data?.token;
record('① POST /auth/login', login.status === 200 && Boolean(token), `HTTP ${login.status}`);

const fam = await call('POST', '/families', { token, body: { name: `${code}家` } });
const familyId = fam.body?.data?.family?.id;
record('② POST /families', fam.status === 200 && Boolean(familyId), `familyId=${familyId}`);

const tripRes = await call('POST', '/trips', {
  token,
  body: {
    familyId,
    title: '过期行程',
    startDate: '2020-01-02',
    endDate: '2020-01-03',
  },
});
const trip = tripRes.body?.data?.trip;
const tripId = trip?.id;
record(
  '③ POST /trips（创建即 DRAFT，version=0）',
  tripRes.status === 200 && trip?.status === 'DRAFT',
  `tripId=${tripId} status=${trip?.status} version=${trip?.version}`,
);

const patched = await call('PATCH', `/trips/${tripId}`, {
  token,
  body: { version: 0, status: 'PLANNED' },
});
record(
  '④ PATCH /trips/:id → PLANNED（制造可自动完结的候选）',
  patched.status === 200 && patched.body?.data?.trip?.status === 'PLANNED',
  `status=${patched.body?.data?.trip?.status} version=${patched.body?.data?.trip?.version}`,
);

// ② P0-1 读路径惰性流转
const detail = await call('GET', `/trips/${tripId}`, { token });
const d = detail.body?.data;
record(
  '⑤ GET /trips/:id → 惰性归档为 FINISHED + HISTORICAL_READONLY',
  detail.status === 200 && d?.trip?.status === 'FINISHED' && d?.myAccessLevel === 'HISTORICAL_READONLY',
  `status=${d?.trip?.status} myAccessLevel=${d?.myAccessLevel} memberCount=${d?.memberCount}`,
);

// ③ P2-1 finish 幂等
const finishAgain = await call('POST', `/trips/${tripId}/finish`, {
  token,
  body: { version: 1 },
});
record(
  '⑥ POST /trips/:id/finish（已归档，版本已过期）→ 200 alreadyFinished=true',
  finishAgain.status === 200 && finishAgain.body?.data?.alreadyFinished === true,
  `HTTP ${finishAgain.status} alreadyFinished=${finishAgain.body?.data?.alreadyFinished}`,
);

// ④ P0-2 归档行程可传照片
const presign = await call('POST', '/media/presign', {
  token,
  body: { familyId, tripId, fileName: 'after-trip.jpg', mimeType: 'image/jpeg', byteSize: '2048' },
});
const fileKey = presign.body?.data?.fileKey;
record(
  '⑦ POST /media/presign（归档行程带 tripId）→ 200',
  presign.status === 200 && Boolean(fileKey),
  `HTTP ${presign.status} fileKey=${fileKey}`,
);

const confirm = await call('POST', '/media/confirm', {
  token,
  body: {
    familyId,
    tripId,
    fileKey,
    mimeType: 'image/jpeg',
    byteSize: '2048',
    compressed: true,
    exifStripped: true,
    hadGps: false,
    storageClass: 'STANDARD',
  },
});
const asset = confirm.body?.data?.asset;
record(
  '⑧ POST /media/confirm（归档行程）→ 200，tripId 正确、EXIF 已剥离',
  confirm.status === 200 && asset?.tripId === tripId && asset?.exifStripped === true,
  `HTTP ${confirm.status} assetId=${asset?.id} tripId=${asset?.tripId} exifStripped=${asset?.exifStripped}`,
);

// ⑤ 归档行程删照片——同时验证「只有 media 域放宽」：记账仍 403
const removed = await call('DELETE', `/media/${asset?.id}`, { token });
record('⑨ DELETE /media/:id（归档行程）→ 200', removed.status === 200, `HTTP ${removed.status}`);

// ⑤ 归档行程记账（产品拍板放开）—— 同时验证「只有 media + expense 放开，日程仍锁」
const expense = await call('POST', '/expenses', {
  token,
  body: { tripId, familyId, title: '回来补一笔', amount: '128.00', currency: 'CNY' },
});
const expenseId = expense.body?.data?.expense?.id;
record(
  '⑩ POST /expenses（归档行程）→ 200（回来补记最后一笔）',
  expense.status === 200 && Boolean(expenseId) && expense.body?.data?.expense?.tripId === tripId,
  `HTTP ${expense.status} expenseId=${expenseId}`,
);

const patchedExpense = await call('PATCH', `/expenses/${expenseId}`, {
  token,
  body: { version: 0, amount: '158.00', note: '实际 158' },
});
record(
  '⑪ PATCH /expenses/:id（归档行程）→ 200（写错金额能改）',
  patchedExpense.status === 200 && patchedExpense.body?.data?.expense?.note === '实际 158',
  `HTTP ${patchedExpense.status} version=${patchedExpense.body?.data?.expense?.version}`,
);

const itinerary = await call('POST', '/itineraries', {
  token,
  body: {
    tripId,
    familyId,
    title: '补一条日程',
    startAt: '2020-01-02T10:00',
    sort: 1,
  },
});
record(
  '⑫ POST /itineraries（归档行程）→ 403（日程仍锁定）',
  itinerary.status === 403,
  `HTTP ${itinerary.status} message=${itinerary.body?.message}`,
);

// ⑥ P1-1 列表 memberCount
const list = await call('GET', '/trips', { token });
const item = (list.body?.data?.items ?? []).find((i) => String(i.id) === String(tripId));
record(
  '⑬ GET /trips → 每项带 memberCount（且状态已是 FINISHED）',
  list.status === 200 && item?.memberCount === 1 && item?.status === 'FINISHED',
  `memberCount=${item?.memberCount} status=${item?.status} myAccessLevel=${item?.myAccessLevel}`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);
