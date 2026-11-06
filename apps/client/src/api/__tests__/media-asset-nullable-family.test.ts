/**
 * 媒体资产 familyId 可空契约回归（2026-11-05 后端放宽 media_asset.family_id）
 * ============================================================================
 * 后端把头像从家庭媒体池拆出：fileKey 走 `a/<userId>/`，落库 `family_id = NULL`；
 * 家庭照片仍是 `f/<familyId>/`，family_id 为字符串。
 *
 * 前端 `MediaAsset.familyId` 因此从 `string` 放宽为 `string | null`。
 * 本文件锁住三件事：
 *   1. 真后端 confirm 回 `familyId: null` 时，客户端原样透传、头像 URL 不丢；
 *   2. 列表里 string / null 混合出现时不炸（回忆墙会同时拿到两类资产）；
 *   3. Mock 的 AVATAR 分支与真后端同口径，避免开发态和联调态契约漂移。
 *
 * 注：`http.ts` 的 media 响应没有 toXxx 投影，是 `request<MediaAsset>` 直接断言，
 * 所以这里的重点是「新响应形状吃得下」，不是投影逻辑。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestSpy = vi.fn();

vi.mock('@tarojs/taro', () => ({
  default: {
    request: (...args: unknown[]) => requestSpy(...args) as unknown,
    removeStorageSync: (): void => undefined,
    setStorageSync: (): void => undefined,
  },
}));

import { createHttpClient } from '../http';
import { createMockClient } from '../mock';
import type { MediaAsset } from '../types';

function ok(data: unknown): Record<string, unknown> {
  return { code: 0, message: 'ok', data };
}

/** 编译期即校验：familyId 为 null 的资产行必须能赋给 MediaAsset */
const AVATAR_ASSET: MediaAsset = {
  id: '9001',
  url: 'https://api.example.com/media-files/a/1/avatar.jpg',
  familyId: null,
  tripId: null,
  ownerId: '1',
  fileKey: 'a/1/avatar.jpg',
  mimeType: 'image/jpeg',
  byteSize: '2048',
  compressed: true,
  exifStripped: true,
  hadGps: false,
  storageClass: 'STANDARD',
  width: null,
  height: null,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
};

/** 编译期即校验：家庭照片仍是字符串 familyId */
const FAMILY_ASSET: MediaAsset = {
  ...AVATAR_ASSET,
  id: '9002',
  familyId: '10',
  fileKey: 'f/10/photo.jpg',
  url: 'https://api.example.com/media-files/f/10/photo.jpg',
};

/**
 * 按 method + url 分派，而不是用一次性响应队列：
 * resolveFamilyId() 有模块级缓存，跨用例是否真的打 /families 不稳定，
 * 用队列会让断言随缓存状态漂移。
 */
function stubBackend(confirmAsset: MediaAsset, listAssets: MediaAsset[]): void {
  requestSpy.mockImplementation((req: { url?: unknown; method?: unknown }) => {
    const url = typeof req.url === 'string' ? req.url : '';
    const method = typeof req.method === 'string' ? req.method : '';
    if (method === 'GET' && url.includes('/families')) {
      return Promise.resolve({
        statusCode: 200,
        data: ok({ items: [{ id: '10', name: '周末出游', ownerId: '1' }], meta: { total: 1 } }),
      });
    }
    if (method === 'POST' && url.includes('/media/confirm')) {
      return Promise.resolve({ statusCode: 200, data: ok({ asset: confirmAsset }) });
    }
    if (method === 'GET' && url.includes('/media')) {
      return Promise.resolve({
        statusCode: 200,
        data: ok({ items: listAssets, meta: { total: listAssets.length } }),
      });
    }
    return Promise.resolve({ statusCode: 200, data: ok(null) });
  });
}

describe('真后端 · 头像资产 familyId = null', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('confirmMediaAsset 原样透传 null，且头像 URL 不被吞掉', async () => {
    stubBackend(AVATAR_ASSET, []);
    const api = createHttpClient();

    const asset = await api.confirmMediaAsset({
      fileKey: 'a/1/avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: 2048,
      purpose: 'AVATAR',
    });

    expect(asset.familyId).toBeNull();
    expect(asset.url).toBe(AVATAR_ASSET.url);
    expect(asset.ownerId).toBe('1');
    const confirmCall = requestSpy.mock.calls.find((c) => {
      const req = c?.[0] as { url?: unknown } | undefined;
      return typeof req?.url === 'string' && req.url.includes('/media/confirm');
    });
    expect(confirmCall).toBeDefined();
    const req = confirmCall?.[0] as { data: { purpose?: string } };
    expect(req.data.purpose).toBe('AVATAR');
  });

  it('listMedia 混合 string / null 时都原样返回，不因可空字段丢资产', async () => {
    stubBackend(AVATAR_ASSET, [FAMILY_ASSET, AVATAR_ASSET]);
    const api = createHttpClient();

    const list = await api.listMedia({});

    expect(list).toHaveLength(2);
    expect(list[0]?.familyId).toBe('10');
    expect(list[1]?.familyId).toBeNull();
  });
});

describe('Mock · 与真后端同口径', () => {
  beforeEach(() => {
    requestSpy.mockReset();
  });

  it('AVATAR 登记返回的资产 familyId 为 null（不再挂到家庭下）', async () => {
    const api = createMockClient();

    const asset = await api.confirmMediaAsset({
      fileKey: 'a/1/avatar.jpg',
      mimeType: 'image/jpeg',
      byteSize: 2048,
      purpose: 'AVATAR',
    });

    expect(asset.familyId).toBeNull();
    expect(asset.fileKey.startsWith('a/')).toBe(true);
  });
});
