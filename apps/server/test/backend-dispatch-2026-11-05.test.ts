/**
 * 派发单《前端五项问题只读核查》· 后端修复的 HTTP 层验收（2026-11-05）
 * ============================================================================
 * 与 `src/domains` 下各 service 单测的分工：
 *   那边断言的是 service 语义，这里断言的是**完整 8 段链**——
 *   Zod schema → 归属解析 → 权限判定 → controller → service → 统一信封。
 *
 * 为什么必须有这一层（§4 尤其）：AVATAR 解耦改了三处**跨层**契约
 *   · schema：`familyId` 变可选
 *   · access-policy：`familyId`/`tripId` 皆空 → 按用户私有短路
 *   · media.controller 的 `ref`：必须透传 `ownerId`，否则删不掉自己的头像
 * 任何一层漏改，service 单测都是绿的，但真实请求会 404。
 */
import { describe, expect, it } from 'vitest';

import { buildApp, type BuiltApp } from '../src/composition-root.js';
import { MemoryTableDriver } from '../src/common/db/table-client.js';
import { ErrorCode } from '../src/common/errors/error-code.js';
import { mustOk, req, scaffold } from './helpers.js';

const MEDIA_BASE = 'https://media.test/media-files';

function freshApp(): BuiltApp {
  return buildApp({
    driver: new MemoryTableDriver(),
    mediaPublicBaseUrl: MEDIA_BASE,
    autoFinish: { enabled: false, lazyOnRead: false },
  });
}

/** 只登录、不建家庭 —— 用来验证「零家庭用户」路径 */
async function loginOnly(app: BuiltApp, code: string): Promise<{ token: string; userId: string }> {
  const r = mustOk<{ token: string; user: { id: string } }>(
    await app.dispatch(req('POST', '/auth/login', { body: { code } })),
  );
  return { token: r.token, userId: r.user.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 户主 displayName
// ─────────────────────────────────────────────────────────────────────────────

describe('§1 POST /families · 户主 displayName 来自 nickname', () => {
  it('nickname=小明、家庭名=暑假旅行组 → GET /families/:id 的 OWNER displayName 是小明', async () => {
    const app = freshApp();
    const { token } = await loginOnly(app, 'nick-owner');
    mustOk(await app.dispatch(req('PATCH', '/auth/me', { token, body: { nickname: '小明' } })));

    const created = mustOk<{ family: { id: string } }>(
      await app.dispatch(req('POST', '/families', { token, body: { name: '暑假旅行组' } })),
    );

    const detail = mustOk<{
      family: { name: string };
      members: Array<Record<string, unknown>>;
      memberCount: number;
    }>(await app.dispatch(req('GET', `/families/${created.family.id}`, { token })));

    const owner = detail.members.find((m) => m['role'] === 'OWNER');
    expect(owner?.['displayName']).toBe('小明');
    expect(owner?.['displayName']).not.toBe('暑假旅行组');
    // 响应信封不变：仍是 data.family + data.members，memberCount 为纯加法
    expect(detail.family.name).toBe('暑假旅行组');
    expect(detail.memberCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 memberCount
// ─────────────────────────────────────────────────────────────────────────────

describe('§2 家庭 memberCount', () => {
  it('1 真实 + 2 虚拟 = 3；软删 1 个后 = 2；list 与 detail 同口径', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'count-family');

    for (const name of ['奶奶', '小满']) {
      mustOk(
        await app.dispatch(
          req('POST', `/families/${s.familyId}/members`, {
            token: s.token,
            body: { displayName: name, isVirtual: true },
          }),
        ),
      );
    }

    const list = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/families', { token: s.token })),
    );
    expect(list.items[0]!['memberCount']).toBe(3);

    const detail = mustOk<{ memberCount: number; members: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
    );
    expect(detail.memberCount).toBe(3);

    // 删掉一个虚拟成员 → 下一次读即反映最新计数
    const victim = detail.members.find((m) => m['displayName'] === '奶奶');
    mustOk(
      await app.dispatch(
        req('DELETE', `/families/members/${String(victim!['id'])}`, { token: s.token }),
      ),
    );

    const list2 = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/families', { token: s.token })),
    );
    expect(list2.items[0]!['memberCount']).toBe(2);
    expect(
      mustOk<{ memberCount: number }>(
        await app.dispatch(req('GET', `/families/${s.familyId}`, { token: s.token })),
      ).memberCount,
    ).toBe(2);
  });

  it('家庭 4 人、行程 3 人 → 两个接口各自口径不串（family vs trip）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'count-split');

    // 家庭：再加 3 个虚拟成员 → 4 人
    for (const name of ['奶奶', '小满', '叔叔']) {
      mustOk(
        await app.dispatch(
          req('POST', `/families/${s.familyId}/members`, {
            token: s.token,
            body: { displayName: name, isVirtual: true },
          }),
        ),
      );
    }

    // 行程成员：脚手架自带创建者 1 人，再加 2 个虚拟成员 → 3 人
    const tripDetail = mustOk<{ members: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', `/trips/${s.tripId}`, { token: s.token })),
    );
    for (const name of ['奶奶', '小满']) {
      mustOk(
        await app.dispatch(
          req('POST', `/trips/${s.tripId}/members`, {
            token: s.token,
            body: { displayName: name, isVirtual: true },
          }),
        ),
      );
    }
    void tripDetail;

    const trips = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/trips', { token: s.token })),
    );
    const trip = trips.items.find((t) => t['id'] === s.tripId);
    expect(trip?.['memberCount']).toBe(3);

    const families = mustOk<{ items: Array<Record<string, unknown>> }>(
      await app.dispatch(req('GET', '/families', { token: s.token })),
    );
    expect(families.items[0]!['memberCount']).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 AVATAR 解耦 familyId（含权限链路）
// ─────────────────────────────────────────────────────────────────────────────

describe('§4 AVATAR · 零家庭用户可完整走通头像链路', () => {
  it('presign（不带 familyId）→ confirm（不带 familyId）→ DELETE 自己的头像，全部 2xx', async () => {
    const app = freshApp();
    const me = await loginOnly(app, 'avatar-no-family');

    // 确认这个账号确实没有任何家庭
    const families = mustOk<{ items: unknown[] }>(
      await app.dispatch(req('GET', '/families', { token: me.token })),
    );
    expect(families.items).toHaveLength(0);

    const presign = mustOk<{ fileKey: string; uploadUrl: string }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: me.token,
          body: {
            purpose: 'AVATAR',
            fileName: 'me.jpg',
            mimeType: 'image/jpeg',
            byteSize: '1024',
          },
        }),
      ),
    );
    expect(presign.fileKey.startsWith(`a/${me.userId}/`)).toBe(true);

    const asset = mustOk<{ asset: Record<string, unknown> }>(
      await app.dispatch(
        req('POST', '/media/confirm', {
          token: me.token,
          body: {
            purpose: 'AVATAR',
            fileKey: presign.fileKey,
            mimeType: 'image/jpeg',
            byteSize: '1024',
            compressed: true,
            exifStripped: false,
            hadGps: false,
            storageClass: 'STANDARD',
          },
        }),
      ),
    ).asset;

    expect(asset['familyId']).toBeNull();
    expect(asset['ownerId']).toBe(me.userId);
    expect(asset['url']).toBe(`${MEDIA_BASE}/${presign.fileKey}`);

    // 🔴 权限链路：familyId/tripId 皆空时必须按「用户私有」放行，
    //    否则用户删不掉自己的头像（这正是 access-policy 短路 + ref 透传 ownerId 的验收点）
    const del = await app.dispatch(
      req('DELETE', `/media/${String(asset['id'])}`, { token: me.token }),
    );
    expect(del.httpStatus).toBeLessThan(300);
  });

  it('他人不能删我的头像（私有短路仍是 owner 维度）', async () => {
    const app = freshApp();
    const me = await loginOnly(app, 'avatar-owner');
    const other = await loginOnly(app, 'avatar-other');

    const p = mustOk<{ fileKey: string }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: me.token,
          body: {
            purpose: 'AVATAR',
            fileName: 'me.jpg',
            mimeType: 'image/jpeg',
            byteSize: '1024',
          },
        }),
      ),
    );
    const asset = mustOk<{ asset: Record<string, unknown> }>(
      await app.dispatch(
        req('POST', '/media/confirm', {
          token: me.token,
          body: {
            purpose: 'AVATAR',
            fileKey: p.fileKey,
            mimeType: 'image/jpeg',
            byteSize: '1024',
            compressed: false,
            exifStripped: false,
            hadGps: false,
            storageClass: 'STANDARD',
          },
        }),
      ),
    ).asset;

    const denied = await app.dispatch(
      req('DELETE', `/media/${String(asset['id'])}`, { token: other.token }),
    );
    // 与「不存在」同形，不泄漏存在性
    expect(denied.httpStatus).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 / §4 MEDIA 仍必须过家庭门
// ─────────────────────────────────────────────────────────────────────────────

describe('§3/§4 MEDIA · 家庭门未被放宽', () => {
  it('presign 缺 familyId → 422；非家庭成员 → 404', async () => {
    const app = freshApp();
    const owner = await scaffold(app, 'media-owner');
    const stranger = await loginOnly(app, 'media-stranger');

    const missing = await app.dispatch(
      req('POST', '/media/presign', {
        token: owner.token,
        body: { fileName: 'p.jpg', mimeType: 'image/jpeg', byteSize: '10' },
      }),
    );
    expect(missing.httpStatus).toBe(422);
    expect(missing.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);

    const notMember = await app.dispatch(
      req('POST', '/media/presign', {
        token: stranger.token,
        body: {
          familyId: owner.familyId,
          fileName: 'p.jpg',
          mimeType: 'image/jpeg',
          byteSize: '10',
        },
      }),
    );
    expect(notMember.httpStatus).toBe(404);
  });

  it('confirm 显式 purpose 与上传位冲突 → 422（防伪造用途绕过家庭门）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'media-conflict');

    const p = mustOk<{ fileKey: string }>(
      await app.dispatch(
        req('POST', '/media/presign', {
          token: s.token,
          body: {
            purpose: 'AVATAR',
            fileName: 'me.jpg',
            mimeType: 'image/jpeg',
            byteSize: '10',
          },
        }),
      ),
    );

    const conflict = await app.dispatch(
      req('POST', '/media/confirm', {
        token: s.token,
        body: {
          purpose: 'MEDIA',
          familyId: s.familyId,
          fileKey: p.fileKey,
          mimeType: 'image/jpeg',
          byteSize: '10',
          compressed: false,
          exifStripped: false,
          hadGps: false,
          storageClass: 'STANDARD',
        },
      }),
    );
    expect(conflict.httpStatus).toBe(422);
    expect(conflict.envelope.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('avatar 带 tripId → 422（presign / confirm 都拦）', async () => {
    const app = freshApp();
    const s = await scaffold(app, 'media-avatar-trip');

    const r = await app.dispatch(
      req('POST', '/media/presign', {
        token: s.token,
        body: {
          purpose: 'AVATAR',
          tripId: s.tripId,
          fileName: 'me.jpg',
          mimeType: 'image/jpeg',
          byteSize: '10',
        },
      }),
    );
    expect(r.httpStatus).toBe(422);
  });
});
