/**
 * 真后端端点探针 —— 逐端点确认真 MySQL 下哪些 500（BigInt 序列化）
 * ============================================================================
 * 为什么需要它：POST /trips 在真后端 500（`Do not know how to serialize a BigInt`），
 * 而 POST 挂了就无法用 API 造出行程去测 GET/PATCH/DELETE。
 * 故本脚本：API 建家庭（该接口正常）→ **直连 Prisma 插 trip / trip_member /
 * itinerary_item** → 逐个 HTTP 探针 → 断言 → 清理。
 *
 * 结论用途：
 *   · 确认「行程列表是否也 500」—— 这是「删完跳回列表仍看到行程」的关键
 *   · 确认 DELETE 是否 200（其响应是 data:null，不含 version，故不受该 bug 影响）
 *
 * 运行：CI=true node .verify/real-endpoint-probe.cjs
 */

const http = require('http');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 3000;
const API = '/api';

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const { PrismaClient } = require(path.join(SERVER_DIR, 'node_modules', '@prisma', 'client'));

const prisma = new PrismaClient();

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (method !== 'GET') headers['X-Request-Id'] = `probe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (payload) headers['Content-Length'] = payload.length;
    const r = http.request({ host: HOST, port: PORT, path: API + p, method, headers }, (res) => {
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

const rows = [];
function line(label, r, note) {
  const envelopeOk = r.env && typeof r.env.code === 'number';
  const verdict = r.status === 500 ? '🔴 500 无信封' : `${r.status} ${envelopeOk ? '信封 code=' + r.env.code : '无信封'}`;
  const s = `  ${label.padEnd(34)} → ${verdict}${note ? '   ' + note : ''}`;
  rows.push(s);
  console.log(s);
}

async function main() {
  console.log('===== 真后端端点探针（真 MySQL / prisma driver）=====\n');

  const login = await req('POST', '/auth/login', { code: `probe-${Date.now().toString(36)}` });
  const token = login.env?.data?.token;
  const userId = BigInt(login.env?.data?.user?.id);
  if (!token) throw new Error('登录失败：' + login.raw);

  const fam = await req('POST', '/families', { name: `探针家庭-${Date.now().toString(36)}` }, token);
  const familyId = BigInt(fam.env?.data?.family?.id);
  console.log(`userId=${userId} familyId=${familyId}\n`);

  // ── 直连 Prisma 造数据（绕过挂掉的 POST /trips）──────────────
  const base = BigInt(Date.now()) * 1000n;
  const tripId = base + 1n;
  const itinId = base + 2n;
  const now = new Date();

  await prisma.trip.create({
    data: {
      id: tripId,
      familyId,
      createdBy: userId,
      leaderId: userId,
      title: '探针行程',
      status: 'PLANNED',
      startDate: new Date('2026-11-01T00:00:00Z'),
      endDate: new Date('2026-11-03T00:00:00Z'),
      timezone: 'Asia/Shanghai',
      destinationsJson: [{ name: '青岛' }],
      version: 1n,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.tripMember.create({
    data: {
      id: base + 3n,
      tripId,
      userId,
      role: 'LEADER',
      isExternal: false,
      accessLevel: 'ACTIVE',
      displayName: '探针用户',
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await prisma.itineraryItem.create({
    data: {
      id: itinId,
      tripId,
      createdBy: userId,
      title: '探针安排',
      startAt: new Date('2026-11-01T09:30:00Z'),
      endAt: new Date('2026-11-01T11:00:00Z'),
      sort: 0,
      version: 1n,
      createdAt: now,
      updatedAt: now,
    },
  });
  console.log('已直连插入 trip / trip_member / itinerary_item\n');

  // ── 探针 ────────────────────────────────────────────────────
  console.log('--- 行程域 ---');
  const l = await req('GET', '/trips?familyId=' + familyId, undefined, token);
  line('GET /trips（行程列表）', l, l.status === 500 ? '← 列表页会整页失败' : '');

  const g = await req('GET', `/trips/${tripId}`, undefined, token);
  line('GET /trips/:id（行程详情）', g);

  const pa = await req('PATCH', `/trips/${tripId}`, { version: 1, title: '探针行程(改)' }, token);
  line('PATCH /trips/:id（改期/改目的地）', pa);

  const d = await req('DELETE', `/trips/${tripId}`, undefined, token);
  line('DELETE /trips/:id（删除行程）', d, '响应不含 version，故不受 BigInt bug 影响');

  console.log('\n--- 安排域 ---');
  const il = await req('GET', '/itineraries?tripId=' + tripId, undefined, token);
  line('GET /itineraries（安排列表）', il);

  const ip = await req('PATCH', `/itineraries/${itinId}`, { title: '探针安排(改)' }, token);
  line('PATCH /itineraries/:id', ip);

  const idl = await req('DELETE', `/itineraries/${itinId}`, undefined, token);
  line('DELETE /itineraries/:id', idl);

  // ── 结论 ───────────────────────────────────────────────────
  console.log('\n--- 原始响应（前 220 字节）---');
  for (const [name, r] of [
    ['GET /trips', l],
    ['GET /trips/:id', g],
    ['PATCH /trips/:id', pa],
    ['DELETE /trips/:id', d],
  ]) {
    console.log(`  ${name}: ${r.raw.slice(0, 220)}`);
  }

  // ── 清理 ───────────────────────────────────────────────────
  console.log('\n--- 清理 ---');
  await prisma.itineraryItem.deleteMany({ where: { tripId } }).catch(() => undefined);
  await prisma.tripMember.deleteMany({ where: { tripId } }).catch(() => undefined);
  await prisma.trip.deleteMany({ where: { id: tripId } }).catch(() => undefined);
  await req('DELETE', `/families/${familyId}`, undefined, token);
  console.log('已清理探针数据');
}

main()
  .catch((e) => {
    console.error('脚本异常：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
