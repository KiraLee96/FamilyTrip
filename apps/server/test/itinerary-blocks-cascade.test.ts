/**
 * D-2026-10-15-01 · 验收：安排正文块（blocks）+ 行程删除级联
 * ============================================================================
 * 覆盖派发单 §1.7（B1-B10）与 §2.4（C1-C7）。
 *
 * 驱动：内存驱动（MemoryTableDriver）—— 与既有集成测试同口径，
 * 落库物理行可经 dumpTable 断言。
 *
 * 关于 C3（旧邀请码 join）：本版 Trip 模型无邀请码列、无 POST /trips/join
 * 路由（D-2026-10-14-02「行程邀请码三端点」尚未落地），故无加入路径可越权。
 * 下方以「路由不存在」断言守住这个事实：该域上线时本用例失败，即提醒
 * 其 join 必须校验 trip.deletedAt。
 *
 * 关于 C6 的 403 口径：行程成员（非主导者）的 DELETE 会通过权限网关
 * （TRIP 维度放行）后由 service.assertLeaderOrCreator 抛 403；
 * 而「仅家庭成员、非行程成员」在网关层即被 404 同形拒（D8 设计，不泄漏存在性）。
 * 本用例按前者（行程成员）构造，与派发单「非主导者/非创建者 → 403」对齐。
 */

import { describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { dumpTable, mustOk, req, scaffold, type Scaffold } from './helpers.js';

/** 与组合根同一口径注入的媒体公网基址（测试固定值，便于断言拼接结果） */
const MEDIA_BASE = 'https://media.test';

function freshApp(): BuiltApp {
  return buildApp({ driver: new MemoryTableDriver(), mediaPublicBaseUrl: MEDIA_BASE });
}
/** 建一条安排（默认字段齐备，可覆写）；返回原始 dispatch 结果（错误用例直取状态码） */
function postItem(
  app: BuiltApp,
  s: Scaffold,
  body: Record<string, unknown> = {},
): ReturnType<BuiltApp['dispatch']> {
  return app.dispatch(
    req('POST', '/itineraries', {
      token: s.token,
      body: {
        tripId: s.tripId,
        familyId: s.familyId,
        title: '测试安排',
        startAt: '2026-08-01T09:00',
        endAt: '2026-08-01T10:00',
        sort: 1,
        ...body,
      },
    }),
  );
}

/**
 * 登记一个媒体资产（真实两段式：presign → confirm）。
 * confirm 要求 filePending 行存在且属于本人（防登记别人上传的文件），
 * 故测试也必须走完整链路，与前端 chooseImage→presign→confirm 同构。
 */
async function createAsset(app: BuiltApp, s: Scaffold): Promise<Record<string, unknown>> {
  const pre = await app.dispatch(
    req('POST', '/media/presign', {
      token: s.token,
      body: {
        familyId: s.familyId,
        fileName: 'photo.jpg',
        mimeType: 'image/jpeg',
        byteSize: '1024',
      },
    }),
  );
  const signed = mustOk<{ fileKey: string }>(pre);

  const r = await app.dispatch(
    req('POST', '/media/confirm', {
      token: s.token,
      body: {
        familyId: s.familyId,
        tripId: s.tripId,
        fileKey: signed.fileKey,
        mimeType: 'image/jpeg',
        byteSize: '1024',
        compressed: true,
        exifStripped: true,
        hadGps: false,
        storageClass: 'STANDARD',
      },
    }),
  );
  return mustOk<{ asset: Record<string, unknown> }>(r).asset;
}

/** 五种块各一（image 块 assetId 由调用方填） */
function fiveBlocks(assetId: string): Array<Record<string, unknown>> {
  return [
    { type: 'text', text: '普通段落\n第二行' },
    { type: 'quote', text: '引用：灰底圆角' },
    { type: 'code', text: 'G179 次 · 北京南 09:30' },
    { type: 'link', text: '12306', url: 'https://www.12306.cn/index/' },
    { type: 'image', assetId, caption: '民宿周边步行路线' },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// §1.7 B1-B10：itinerary 域 blocks
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-15-01 · P0 blocks（B1-B10）', () => {
  it('B1：POST /itineraries 带 5 种块 → 200；data.item.blocks 长度 5，image 块带服务端拼接 url', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b1');
    const asset = await createAsset(app, s);

    const r = await postItem(app, s, { blocks: fiveBlocks(String(asset['id'])) });
    expect(r.httpStatus).toBe(200);
    const item = mustOk<{ item: Record<string, unknown> }>(r).item;

    const blocks = item['blocks'] as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(5);
    expect(blocks.map((b) => b['type'])).toEqual(['text', 'quote', 'code', 'link', 'image']);
    const image = blocks[4]!;
    // 与 media 域 confirm 响应同一拼接结果（同一环境变量、同一拼接方式）
    expect(image['url']).toBe(asset['url']);
    expect(String(image['url'])).toMatch(new RegExp(`^${MEDIA_BASE}/f/`));
    expect(image['assetId']).toBe(String(asset['id']));
    expect(image['caption']).toBe('民宿周边步行路线');
  });

  it('B2：GET /itineraries?tripId=<id> → 块按原顺序返回（顺序 = 写入顺序）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b2');
    const asset = await createAsset(app, s);
    const blocks = fiveBlocks(String(asset['id']));
    await postItem(app, s, { blocks });

    const r = await app.dispatch(
      req('GET', '/itineraries', { token: s.token, query: { tripId: s.tripId } }),
    );
    const data = mustOk<{ items: Array<Record<string, unknown>> }>(r);
    expect(data.items).toHaveLength(1);
    const got = data.items[0]!['blocks'] as Array<Record<string, unknown>>;
    expect(got.map((b) => b['type'])).toEqual(blocks.map((b) => b['type']));
    expect(got.map((b) => b['text'])).toEqual(blocks.map((b) => b['text']));
  });

  it('B3：PATCH 传 blocks:[] → 200；再次 GET 该行不带 blocks 字段', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b3');
    const asset = await createAsset(app, s);
    const created = await postItem(app, s, { blocks: fiveBlocks(String(asset['id'])) });
    const item = mustOk<{ item: Record<string, unknown> }>(created).item;

    const patched = await app.dispatch(
      req('PATCH', `/itineraries/${item['id'] as string}`, {
        token: s.token,
        body: { version: item['version'], blocks: [] },
      }),
    );
    expect(patched.httpStatus).toBe(200);
    expect('blocks' in mustOk<{ item: Record<string, unknown> }>(patched).item).toBe(false);

    const got = await app.dispatch(
      req('GET', `/itineraries/${item['id'] as string}`, { token: s.token }),
    );
    const after = mustOk<{ item: Record<string, unknown> }>(got).item;
    expect('blocks' in after).toBe(false);
    // 物理行是 '[]'（清空语义落库），读投影按口径不带字段
    const rows = dumpTable(app, 'itineraryItem');
    expect(rows[0]!['blocksJson']).toBe('[]');
  });

  it('B4：传 21 个块 → 422 VALIDATION_FAILED', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b4');
    const blocks = Array.from({ length: 21 }, (_, i) => ({ type: 'text', text: `块${i}` }));
    const r = await postItem(app, s, { blocks });
    expect(r.httpStatus).toBe(422);
  });

  it('B5：blocks 序列化 > 16KB → 422 VALIDATION_FAILED', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b5');
    // 9 × 2000 字符 = 18000 > 16384（单块上限 2000，数组上限 20，故用 9 块撑体积）
    const blocks = Array.from({ length: 9 }, () => ({ type: 'text', text: 'x'.repeat(2000) }));
    const r = await postItem(app, s, { blocks });
    expect(r.httpStatus).toBe(422);
  });

  it('B6：link.url = "javascript:alert(1)" → 422（只允许 http/https）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b6');
    const r = await postItem(app, s, {
      blocks: [{ type: 'link', text: '点我', url: 'javascript:alert(1)' }],
    });
    expect(r.httpStatus).toBe(422);
  });

  it('B7：image 块 assetId 指向别的家庭的资产 → 422（越权拒）', async () => {
    const app = freshApp();
    const sA = await scaffold(app, 'b7-a');
    const sB = await scaffold(app, 'b7-b');
    const foreign = await createAsset(app, sB);

    const r = await postItem(app, sA, {
      blocks: [{ type: 'image', assetId: String(foreign['id']) }],
    });
    expect(r.httpStatus).toBe(422);
  });

  it('B8：image 块 assetId 指向不存在的资产 → 422', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b8');
    const r = await postItem(app, s, {
      blocks: [{ type: 'image', assetId: '999999999999' }],
    });
    expect(r.httpStatus).toBe(422);
  });

  it('B9：老行（无 blocks）GET → 200；无 blocks 字段；note 正常返回', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b9');
    const created = await postItem(app, s, { note: '老数据只有 note' });
    const item = mustOk<{ item: Record<string, unknown> }>(created).item;
    expect('blocks' in item).toBe(false);

    const got = await app.dispatch(
      req('GET', '/itineraries', { token: s.token, query: { tripId: s.tripId } }),
    );
    const data = mustOk<{ items: Array<Record<string, unknown>> }>(got);
    expect(data.items[0]!['note']).toBe('老数据只有 note');
    expect('blocks' in data.items[0]!).toBe(false);
  });

  it('B10：客户端传 image 块的 url → 被忽略；出参 url 一律为服务端拼接结果', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'b10');
    const asset = await createAsset(app, s);

    const r = await postItem(app, s, {
      blocks: [
        {
          type: 'image',
          assetId: String(asset['id']),
          url: 'https://evil.example.com/inject.jpg',
          caption: '图注',
        },
      ],
    });
    const item = mustOk<{ item: Record<string, unknown> }>(r).item;
    const blocks = item['blocks'] as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!['url']).toBe(asset['url']);
    // 入库形态也不含客户端传入的 url（Zod 剥离）
    const rows = dumpTable(app, 'itineraryItem');
    expect(rows[0]!['blocksJson']).not.toContain('evil.example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.4 C1-C7：DELETE /trips/:id 级联口径
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-15-01 · P1 行程删除级联（C1-C7）', () => {
  it('C1：删除行程后 GET /itineraries?tripId=<id> → 空集（而非幽灵安排）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c1');
    await postItem(app, s, { blocks: [{ type: 'text', text: '删除后不应可见' }] });

    const del = await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));
    expect(del.httpStatus).toBe(200);

    const got = await app.dispatch(
      req('GET', '/itineraries', { token: s.token, query: { tripId: s.tripId } }),
    );
    const data = mustOk<{ items: unknown[]; days: unknown[] }>(got);
    expect(data.items).toEqual([]);
    expect(data.days).toEqual([]);
  });

  it('C2：删除行程后 GET /trips/:id → 404', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c2');
    await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));

    const got = await app.dispatch(req('GET', `/trips/${s.tripId}`, { token: s.token }));
    expect(got.httpStatus).toBe(404);
  });

  it('C3：行程邀请码 join 路由尚不存在（D-2026-10-14-02 未落地）——无越权加入路径', async () => {
    const app = freshApp();
    const joinRoute = app.routes.find((r) => r.method === 'POST' && r.path === '/trips/join');
    expect(joinRoute).toBeUndefined();
  });

  it('C4：删除行程后 GET /expenses?tripId=<id> 空集；GET /expenses/summary 不报 500', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c4');
    await app.dispatch(
      req('POST', '/expenses', {
        token: s.token,
        body: {
          tripId: s.tripId,
          familyId: s.familyId,
          title: '高铁票',
          amount: '55300',
          currency: 'CNY',
        },
      }),
    );
    await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));

    const list = await app.dispatch(
      req('GET', '/expenses', { token: s.token, query: { tripId: s.tripId } }),
    );
    const listData = mustOk<{ items: unknown[] }>(list);
    expect(listData.items).toEqual([]);

    const summary = await app.dispatch(
      req('GET', '/expenses/summary', {
        token: s.token,
        query: { tripId: s.tripId, displayCurrency: 'CNY' },
      }),
    );
    expect(summary.httpStatus).toBe(200);
  });

  it('C5：删除行程后 GET /media?tripId=<id> 空集；家庭照片墙（familyId）仍可见', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c5');
    await createAsset(app, s);
    await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));

    const byTrip = await app.dispatch(
      req('GET', '/media', { token: s.token, query: { tripId: s.tripId } }),
    );
    const byTripData = mustOk<{ items: unknown[] }>(byTrip);
    expect(byTripData.items).toEqual([]);

    // 资产行未级联软删：按家庭维度仍列出（「我的照片」不丢）
    const byFamily = await app.dispatch(
      req('GET', '/media', { token: s.token, query: { familyId: s.familyId } }),
    );
    const byFamilyData = mustOk<{ items: Array<Record<string, unknown>> }>(byFamily);
    expect(byFamilyData.items).toHaveLength(1);
    const rows = dumpTable(app, 'mediaAsset');
    expect(rows[0]!['deletedAt']).toBeNull();
  });

  it('C6：行程成员（非主导者/非创建者）调用 DELETE → 403', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c6');
    // 第二个用户：先入家庭、再由主导者加为行程成员（网关放行 → service 拒 403）
    const loginB = mustOk<{ token: string; user: { id: string } }>(
      await app.dispatch(req('POST', '/auth/login', { body: { code: 'c6-b' } })),
    );
    const familyDetail = mustOk<{ family: { inviteCode: string } }>(
      await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
    );
    const joined = await app.dispatch(
      req('POST', '/families/join', {
        token: loginB.token,
        body: { inviteCode: familyDetail.family.inviteCode },
      }),
    );
    expect(joined.httpStatus).toBe(200);
    const added = await app.dispatch(
      req('POST', `/trips/${s.tripId}/members`, {
        token: s.token,
        body: {
          userId: loginB.user.id,
          isVirtual: false,
          isExternal: false,
          role: 'MEMBER',
          accessLevel: 'ACTIVE',
        },
      }),
    );
    expect(added.httpStatus).toBe(200);

    const del = await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: loginB.token }));
    expect(del.httpStatus).toBe(403);
  });

  it('C7：重复 DELETE 同一行程 → 404（幂等语义明确，不 500）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'c7');
    const first = await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));
    expect(first.httpStatus).toBe(200);
    const second = await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));
    expect(second.httpStatus).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 附：级联落库物理行 + change_log 口径（§1.6 / §2.3）
// ─────────────────────────────────────────────────────────────────────────────

describe('D-2026-10-15-01 · 级联落库与审计口径', () => {
  it('删除行程：五张子表同行软删，change_log 仅父实体一条 DELETE（不含正文）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'audit');
    const asset = await createAsset(app, s);
    const created = await postItem(app, s, {
      note: '敏感：酒店地址 XX 路 12 号',
      blocks: [
        { type: 'text', text: '敏感：酒店地址 XX 路 12 号' },
        { type: 'image', assetId: String(asset['id']) },
      ],
    });
    const item = mustOk<{ item: Record<string, unknown> }>(created).item;
    await app.dispatch(
      req('PATCH', `/itineraries/${item['id'] as string}`, {
        token: s.token,
        body: { version: item['version'], title: '改过的标题' },
      }),
    );

    await app.dispatch(req('DELETE', `/trips/${s.tripId}`, { token: s.token }));

    // 子表全部软删
    for (const model of [
      'tripMember',
      'itineraryItem',
      'tripChecklistItem',
      'expense',
      'booking',
    ]) {
      const rows = dumpTable(app, model);
      for (const row of rows) expect(row['deletedAt']).not.toBeNull();
    }
    // media_asset 不随行程软删
    const mediaRows = dumpTable(app, 'mediaAsset');
    expect(mediaRows).toHaveLength(1);
    expect(mediaRows[0]!['deletedAt']).toBeNull();

    // change_log：行程 DELETE 一条；正文内容不进日志
    const logs = dumpTable(app, 'changeLog').filter((l) => l['entityType'] === 'trip');
    const deletes = logs.filter((l) => l['op'] === 'DELETE');
    expect(deletes).toHaveLength(1);
    for (const l of logs) {
      // change_log 行含 bigint 字段，序列化前转字符串
      expect(
        JSON.stringify(l, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toContain('酒店地址');
    }
  });
});
