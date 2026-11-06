/**
 * media 域 · 派发单 §3 / §4 回归
 * ============================================================================
 * §3 契约收敛：`confirm` 此前会静默 strip 掉 `purpose`，服务端从不校验；
 *    现在透传并以 `file_pending.purpose` 为准，显式冲突才拒（老客户端零影响）。
 * §4 AVATAR 解耦：头像是用户资产，没有家庭也必须能 presign / confirm / 回读；
 *    家庭照片仍必须过家庭成员门。
 */
import { describe, expect, it } from 'vitest';
import { MemoryTableDriver } from '../../common/db/table-client.js';
import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import { checkAccess, Decision } from '../../common/auth/access-policy.js';
import { createDomainContext, type DomainContext } from '../domain-context.js';
import { MediaService } from './media.service.js';

const BASE = 'https://api.example.com/media-files';

function harness(): { ctx: DomainContext; media: MediaService; driver: MemoryTableDriver } {
  const driver = new MemoryTableDriver();
  const ctx = createDomainContext({ reader: driver, runner: driver });
  return { ctx, media: new MediaService({ ctx, mediaPublicBaseUrl: BASE }), driver };
}

async function seedUser(driver: MemoryTableDriver, id: bigint, nickname = '小明'): Promise<void> {
  await driver.insert('user', { id, nickname, deletedAt: null });
}

async function seedMember(
  driver: MemoryTableDriver,
  familyId: bigint,
  userId: bigint,
  role: 'OWNER' | 'MEMBER' = 'MEMBER',
): Promise<void> {
  await driver.insert('familyMember', {
    id: (familyId * 1000n + userId) * 1n,
    familyId,
    userId,
    role,
    isVirtual: false,
    managedBy: null,
    displayName: '成员',
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  });
}

/** 断言抛出的是带指定错误码的 AppError */
async function expectCode(fn: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 code=${code}，实际没有抛错`);
}

interface ConfirmBody {
  fileKey: string;
  mimeType: string;
  byteSize: string;
  compressed: boolean;
  exifStripped: boolean;
  hadGps: boolean;
  storageClass: string;
}

const confirmBody = (fileKey: string): ConfirmBody => ({
  fileKey,
  mimeType: 'image/jpeg',
  byteSize: '204800',
  compressed: true,
  exifStripped: false,
  hadGps: false,
  storageClass: 'STANDARD',
});

describe('派发单 §4 · AVATAR 不依赖 familyId / 家庭成员资格', () => {
  it('零家庭的用户可以取头像上传位，fileKey 前缀是 a/<userId>/', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);

    const r = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });

    expect(r.fileKey.startsWith('a/1/')).toBe(true);
    expect(r.fileKey.startsWith('f/')).toBe(false);
    expect(typeof r.uploadUrl).toBe('string');
  });

  it('老客户端仍带 familyId 时头像分支直接忽略（纯加法、不回归）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    // 这个用户不是 999 号家庭的成员
    const r = await media.presign(1n, {
      familyId: 999n,
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });
    expect(r.fileKey.startsWith('a/1/')).toBe(true);
  });

  it('头像 confirm 成功：familyId 落 null，url 可直接用于 PATCH /auth/me', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);

    const p = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });
    const asset = await media.confirm(1n, {
      purpose: 'AVATAR',
      ...confirmBody(p.fileKey),
    });

    expect(asset['familyId']).toBeNull();
    expect(asset['ownerId']).toBe('1');
    expect(asset['url']).toBe(`${BASE}/${p.fileKey}`);
    expect(String(asset['url']).startsWith(`${BASE}/a/1/`)).toBe(true);
  });

  it('头像不带 purpose 也能 confirm（以 pending 为准，老客户端兼容）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    const p = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'a.webp',
      mimeType: 'image/webp',
      byteSize: '9000',
    });
    const asset = await media.confirm(1n, {
      ...confirmBody(p.fileKey),
      mimeType: 'image/webp',
    });
    expect(asset['familyId']).toBeNull();
    expect(asset['mimeType']).toBe('image/webp');
  });

  it('账号不存在/已注销 → presign 401（不能往鬼账号名下堆头像）', async () => {
    const { media } = harness();
    await expectCode(
      () =>
        media.presign(42n, {
          purpose: 'AVATAR',
          fileName: 'avatar.jpg',
          mimeType: 'image/jpeg',
          byteSize: '120000',
        }),
      ErrorCode.UNAUTHORIZED,
    );
  });

  it('头像带 tripId → 422（静默忽略会留下脏归属）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await expectCode(
      () =>
        media.presign(1n, {
          purpose: 'AVATAR',
          tripId: 202n,
          fileName: 'avatar.jpg',
          mimeType: 'image/jpeg',
          byteSize: '120000',
        }),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('MEDIA 缺 familyId → 422；非家庭成员 → 404', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 2n);

    await expectCode(
      () =>
        media.presign(1n, {
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          byteSize: '204800',
        }),
      ErrorCode.VALIDATION_FAILED,
    );

    await expectCode(
      () =>
        media.presign(1n, {
          familyId: 101n,
          fileName: 'photo.jpg',
          mimeType: 'image/jpeg',
          byteSize: '204800',
        }),
      ErrorCode.NOT_FOUND,
    );
  });

  it('MEDIA 家庭成员正常：fileKey 前缀 f/<familyId>/，confirm 落 familyId', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 1n, 'OWNER');

    const p = await media.presign(1n, {
      familyId: 101n,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: '204800',
    });
    expect(p.fileKey.startsWith('f/101/')).toBe(true);

    const asset = await media.confirm(1n, { familyId: 101n, ...confirmBody(p.fileKey) });
    expect(asset['familyId']).toBe('101');
  });

  it('替他人 confirm → 404（pending owner 校验未被放宽）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedUser(driver, 2n, '小红');

    const p = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });

    await expectCode(() => media.confirm(2n, confirmBody(p.fileKey)), ErrorCode.NOT_FOUND);
  });

  it('家庭相册列表不露出头像资产（含改造前的旧头像行）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 1n, 'OWNER');

    // ① 新口径：familyId = null 的头像
    const av = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });
    await media.confirm(1n, { purpose: 'AVATAR', ...confirmBody(av.fileKey) });

    // ② 旧口径残留：familyId 有值但 fileKey 是 a/ 前缀
    await driver.insert('mediaAsset', {
      id: 9001n,
      familyId: 101n,
      tripId: null,
      ownerId: 1n,
      fileKey: 'a/1/legacy-avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: 1000n,
      compressed: false,
      exifStripped: false,
      hadGps: false,
      storageClass: 'STANDARD',
      width: null,
      height: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    });

    // ③ 家庭照片
    const ph = await media.presign(1n, {
      familyId: 101n,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: '204800',
    });
    await media.confirm(1n, { familyId: 101n, ...confirmBody(ph.fileKey) });

    const list = await media.list(1n, {});
    expect(list.items).toHaveLength(1);
    expect(String(list.items[0]!['fileKey']).startsWith('f/101/')).toBe(true);
  });
});

describe('派发单 §3 · confirm 的 purpose 一致性', () => {
  it('显式 purpose 与上传位冲突 → 422（不能靠改字段把头像登记成家庭照片）', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 1n, 'OWNER');

    const p = await media.presign(1n, {
      purpose: 'AVATAR',
      fileName: 'avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: '120000',
    });

    await expectCode(
      () => media.confirm(1n, { purpose: 'MEDIA', familyId: 101n, ...confirmBody(p.fileKey) }),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('反向冲突同样拒绝：MEDIA 上传位 + purpose=AVATAR', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 1n, 'OWNER');

    const p = await media.presign(1n, {
      familyId: 101n,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: '204800',
    });

    await expectCode(
      () => media.confirm(1n, { purpose: 'AVATAR', ...confirmBody(p.fileKey) }),
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('purpose 与上传位一致时正常落库', async () => {
    const { media, driver } = harness();
    await seedUser(driver, 1n);
    await seedMember(driver, 101n, 1n, 'OWNER');
    const p = await media.presign(1n, {
      familyId: 101n,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      byteSize: '204800',
    });
    const asset = await media.confirm(1n, {
      purpose: 'MEDIA',
      familyId: 101n,
      ...confirmBody(p.fileKey),
    });
    expect(asset['familyId']).toBe('101');
  });
});

describe('权限层 · 头像资产按「用户私有」短路', () => {
  const ctx = {
    identity: { userId: 1n },
    familyIds: new Set<bigint>(),
    tripAccess: new Map<bigint, never>(),
    managedFamilyIds: new Set<bigint>(),
  };

  it('familyId/tripId 皆空 + owner 本人 → ALLOW（否则删不掉自己的头像）', () => {
    const r = checkAccess(
      ctx,
      { type: 'media_asset', id: 1n, familyId: null, tripId: null, ownerId: 1n },
      'DELETE',
    );
    expect(r.decision).toBe(Decision.Allow);
    expect(r.detail.dimension).toBe('PRIVATE_OWNER');
  });

  it('他人的头像 → DENY', () => {
    const r = checkAccess(
      ctx,
      { type: 'media_asset', id: 1n, familyId: null, tripId: null, ownerId: 2n },
      'READ',
    );
    expect(r.decision).toBe(Decision.Deny);
  });

  it('家庭照片不会因为「我是上传者」绕过家庭成员门', () => {
    const r = checkAccess(
      ctx,
      { type: 'media_asset', id: 1n, familyId: 101n, tripId: null, ownerId: 1n },
      'DELETE',
    );
    expect(r.decision).toBe(Decision.Deny);
  });
});
