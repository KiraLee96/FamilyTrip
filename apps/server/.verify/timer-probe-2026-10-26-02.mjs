/**
 * D-2026-10-26-02 · 定时器路径真机取证（AUTO_FINISH_INTERVAL_MS=1000 + 惰性流转关闭）
 *
 * 目的：证明「归档」不是靠读路径顺手做的，而是**定时器自己跑出来的**。
 *   前置：AUTO_FINISH_INTERVAL_MS=1000 AUTO_FINISH_LAZY_ON_READ=false npx tsx src/main.ts
 *
 * 步骤：建过期 PLANNED 行程 → 完全不读它 → 睡 ~4s → 再读一次看状态。
 */

const BASE = process.env.BASE ?? 'http://127.0.0.1:3212/api';

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const code = `timer${Date.now()}`;
const login = await call('POST', '/auth/login', { body: { code } });
const token = login.body?.data?.token;
const fam = await call('POST', '/families', { token, body: { name: `${code}家` } });
const familyId = fam.body?.data?.family?.id;
const t = await call('POST', '/trips', {
  token,
  body: { familyId, title: '定时器用例', startDate: '2021-05-01', endDate: '2021-05-03' },
});
const tripId = t.body?.data?.trip?.id;
await call('PATCH', `/trips/${tripId}`, { token, body: { version: 0, status: 'PLANNED' } });

console.log(`行程 ${tripId} 已置为 PLANNED 且日期已过期；接下来 4s 内**不读取**它…`);
await new Promise((r) => setTimeout(r, 4000));

const d = await call('GET', `/trips/${tripId}`, { token });
const status = d.body?.data?.trip?.status;
const level = d.body?.data?.myAccessLevel;
const ok = status === 'FINISHED' && level === 'HISTORICAL_READONLY';
console.log(
  `${ok ? '✅' : '❌'} 定时器主动归档：status=${status} myAccessLevel=${level}（惰性流转已关闭，只能是定时器干的）`,
);
process.exit(ok ? 0 : 1);
