#!/usr/bin/env node
/**
 * D-2026-10-26-01 · HTTP 层真机取证（P0-1 / P0-2 / P1-1 / P1-2 / P2-1 / P2-2）
 * ============================================================================
 * 与单测的区别：单测直接调 `app.dispatch()`（跳过 HTTP 边界）；
 * 本脚本打**真实 HTTP**（Nest 适配器 → 派发器 → 8 段链），验证：
 *   · 状态码与信封形状在真实网络边界上一致
 *   · 前端 `api/http.ts` 的调用形态（路径 / body / query）能被正确接住
 *
 * 运行前置：
 *   DATABASE_URL="" PORT=3123 NODE_ENV=development npx tsx src/main.ts
 * 运行：
 *   node apps/server/.verify/http-probe-2026-10-26.cjs
 */

const BASE = process.env.PROBE_BASE ?? 'http://127.0.0.1:3123/api';

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail === undefined ? '' : ` —— ${JSON.stringify(detail)}`}`);
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('\n=== 0. 登录 / 建家庭 / 建行程 ===');
  const login = await call('POST', '/auth/login', { body: { code: 'probe-1026' } });
  check('POST /auth/login → 200', login.status === 200, login);
  const token = login.body?.data?.token;
  const userId = login.body?.data?.user?.id;

  const family = await call('POST', '/families', { token, body: { name: '取证之家' } });
  check('POST /families → 200', family.status === 200, family);
  const familyId = family.body?.data?.family?.id;
  const familyInvite = family.body?.data?.family?.inviteCode;

  const trip = await call('POST', '/trips', {
    token,
    body: { familyId, title: '取证出行', startDate: '2026-10-01', endDate: '2026-10-05' },
  });
  check('POST /trips → 200', trip.status === 200, trip);
  const tripId = trip.body?.data?.trip?.id;

  console.log('\n=== P0-1 · POST + PATCH /checklists/templates ===');
  const created = await call('POST', '/checklists/templates', {
    token,
    body: {
      familyId,
      name: '家庭出行常用',
      scope: 'SHARED',
      items: [
        { name: '身份证', quantity: 4 },
        { name: '充电宝', quantity: 2 },
      ],
    },
  });
  check('POST /checklists/templates → 200', created.status === 200, created);
  const templateId = created.body?.data?.template?.id;
  const v0 = created.body?.data?.template?.version;
  check('建模板 version = 0', v0 === 0, v0);
  check(
    '建模板回包带解析后的 items',
    Array.isArray(created.body?.data?.template?.items) && created.body.data.template.items.length === 2,
    created.body?.data?.template?.items,
  );

  const patched = await call('PATCH', `/checklists/templates/${templateId}`, {
    token,
    body: { version: v0, name: '国庆出行', items: [{ name: '身份证', quantity: 4 }] },
  });
  check('PATCH 改名 + 整体替换 items → 200', patched.status === 200, patched);
  check('改名生效', patched.body?.data?.template?.name === '国庆出行', patched.body?.data);
  check('version 自增 1 → 1', patched.body?.data?.template?.version === 1, patched.body?.data?.template?.version);
  check('items 整体替换为 1 条', patched.body?.data?.template?.items?.length === 1, patched.body?.data?.template?.items);
  check('meta.updatedAt 存在', typeof patched.body?.meta?.updatedAt === 'string', patched.body?.meta);

  const stale = await call('PATCH', `/checklists/templates/${templateId}`, {
    token,
    body: { version: 0, name: '用旧版本覆盖' },
  });
  check('旧 version 再改 → 409 / 4090', stale.status === 409 && stale.body?.code === 4090, stale);

  const readBack = await call('GET', `/checklists/templates?familyId=${familyId}`, { token });
  check('GET /checklists/templates → 200', readBack.status === 200, readBack);
  const listed = (readBack.body?.data?.items ?? []).find((t) => t.id === templateId);
  check('列表读回新名称与 version=1', listed?.name === '国庆出行' && listed?.version === 1, listed);
  check('列表回包同时带 items 与 itemsJson', Array.isArray(listed?.items) && 'itemsJson' in (listed ?? {}), {
    items: listed?.items,
    hasItemsJson: 'itemsJson' in (listed ?? {}),
  });

  console.log('\n=== P0-2 · DELETE /checklists/templates ===');
  const applied = await call('POST', '/checklists/templates/apply', {
    token,
    body: { templateId, tripId, familyId },
  });
  check('引用模板到行程 → created=1', applied.status === 200 && applied.body?.data?.created === 1, applied);

  const del = await call('DELETE', `/checklists/templates/${templateId}`, { token });
  check('DELETE → 200 且 data=null', del.status === 200 && del.body?.data === null, del);
  const delAgain = await call('DELETE', `/checklists/templates/${templateId}`, { token });
  check('再删 → 404 / 4040', delAgain.status === 404 && delAgain.body?.code === 4040, delAgain);

  const items = await call('GET', `/checklists/items?tripId=${tripId}`, { token });
  check('删模板后行程清单项仍在（不级联）', (items.body?.data ?? []).length === 1, items.body?.data);
  const firstItem = (items.body?.data ?? [])[0];
  const toggled = await call('POST', `/checklists/items/${firstItem?.id}/toggle`, {
    token,
    body: { version: firstItem?.version ?? 0, checked: true },
  });
  check('被引用的清单项仍可勾选 → 200', toggled.status === 200, toggled);

  console.log('\n=== P1-1 · POST /expenses/batch ===');
  // requestId 带时间戳：同进程内重复跑该脚本时不会误命中上一次的幂等记录
  const requestId = `probe-batch-${Date.now()}`;
  const batch = await call('POST', '/expenses/batch', {
    token,
    body: {
      tripId,
      familyId,
      requestId,
      rows: [
        { title: '栈桥咖啡', amount: '42.50', currency: 'CNY', spentAt: '2026-10-03' },
        { title: '便利店', amount: '18.00', currency: 'CNY', spentAt: '2026-10-03' },
        // 未知币种：业务层抛错（schema 只看长度 3），用于验证「部分成功」
        { title: '某国药妆', amount: '3200', currency: 'XYZ', spentAt: '2026-10-04' },
        { title: '停车费', amount: '5.00', currency: 'CNY', spentAt: '2026-10-04' },
      ],
    },
  });
  check('批量记账 → 200', batch.status === 200, batch);
  check('created=3 / failed=1（部分成功）', batch.body?.data?.created === 3 && batch.body?.data?.failed === 1, batch.body?.data);
  const failedRow = (batch.body?.data?.results ?? []).find((r) => r.ok === false);
  check(
    '失败行带 index 与 error.code（单行失败不影响其它行）',
    failedRow?.index === 2 && typeof failedRow?.error?.code === 'number',
    failedRow,
  );

  const replay = await call('POST', '/expenses/batch', {
    token,
    body: {
      tripId,
      familyId,
      requestId,
      rows: [{ title: '重放不应写入', amount: '1.00', currency: 'CNY' }],
    },
  });
  check(
    '同 requestId 重放返回首次结果（不重复记账）',
    replay.body?.data?.created === batch.body?.data?.created &&
      (replay.body?.data?.results ?? []).length === (batch.body?.data?.results ?? []).length,
    { replay: replay.body?.data, first: batch.body?.data },
  );

  await sleep(1_150);
  const second = await call('POST', '/expenses/batch', {
    token,
    body: { tripId, familyId, rows: [{ title: '第二秒的一笔', amount: '9.90', currency: 'CNY' }] },
  });
  check('过窗口后放行 → 200', second.status === 200, second);

  const third = await call('POST', '/expenses/batch', {
    token,
    body: { tripId, familyId, rows: [{ title: '同秒第二笔', amount: '9.90', currency: 'CNY' }] },
  });
  check('同秒第二次 → 429 / 4290', third.status === 429 && third.body?.code === 4290, third);

  console.log('\n=== P2-1 / P2-2 ===');
  const detail = await call('GET', `/trips/${tripId}`, { token });
  check('GET /trips/:id 带 memberCount', detail.body?.data?.memberCount === (detail.body?.data?.members ?? []).length, {
    memberCount: detail.body?.data?.memberCount,
    members: (detail.body?.data?.members ?? []).length,
  });

  const badJoin = await call('POST', '/families/join', { token, body: { inviteCode: 'ZZZZZZZZ' } });
  check('家庭邀请码写错 → 404 / 4041', badJoin.status === 404 && badJoin.body?.code === 4041, badJoin);
  check('提示文案可行动', badJoin.body?.message === '邀请码无效或已失效', badJoin.body?.message);

  const badTripJoin = await call('POST', '/trips/join', { token, body: { inviteCode: 'ZZZZZZZZ' } });
  check('行程邀请码写错 → 404 / 4041', badTripJoin.status === 404 && badTripJoin.body?.code === 4041, badTripJoin);

  const goodJoin = await call('POST', '/families/join', { token, body: { inviteCode: familyInvite } });
  check('自己的家庭码 join → 幂等 alreadyMember', goodJoin.body?.data?.alreadyMember === true, goodJoin.body?.data);

  console.log(`\n===== 结果：PASS ${pass} / FAIL ${fail} =====`);
  if (fail > 0) process.exitCode = 1;
  void userId;
}

main().catch((e) => {
  console.error('取证脚本异常：', e);
  process.exitCode = 1;
});
