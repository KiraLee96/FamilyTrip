/**
 * 组合根（composition root）
 * ============================================================================
 * 唯一把「基础设施」和「业务域」装配到一起的地方。
 *
 * 装配顺序（顺序有依赖，不可乱）：
 *   ① MemoryTableDriver        —— 数据驱动（生产替换为 PrismaTableDriver）
 *   ② createChainDeps          —— 8 段链所需 7 个函数
 *   ③ createDomainContext      —— 域级读 / 写 / 软删句柄
 *   ④ 各 create<Domain>()      —— 14 个域的 routes + service
 *   ⑤ createDispatcher(routes) —— 汇总所有路由
 *
 * 🔴 为什么域只依赖接口：
 *   `TableDriver` / `TxClient` 都是接口。换成 Prisma 适配器时，
 *   本文件只改 ① 一行，14 个域零改动 —— 这是可替换性的验证点。
 *
 * 🔴 为什么在这里 fail-fast：
 *   权限矩阵格数、FX 授权源、JWT 密钥都在这里一次性校验。
 *   启动期炸掉 > 运行期出 500。
 */

import { createChainDeps, signToken, type IdentityDeps } from './common/middleware/chain-deps.js';
import { createDispatcher, type RawRequest, type RouteSpec } from './common/middleware/dispatcher.js';
import type { ChainResult } from './common/middleware/chain.js';
import { MemoryTableDriver } from './common/db/table-client.js';
import type { TableDriver } from './common/db/table-client.js';
import { assertMatrixSize } from './common/auth/require-access.js';
import { loadAuthorizedSources } from './common/fx/rate-tier.js';
import { assertFxSourceConfigured, type FxRateSource } from './common/fx/source-guard.js';
import { createDomainContext, type DomainContext } from './domains/domain-context.js';
import type { DriverTxRunner } from './common/db/table-client.js';

import { createAuthDomain } from './domains/auth/auth.controller.js';
import { createFamilyDomain } from './domains/family/family.controller.js';
import { createWishDomain } from './domains/wish/wish.controller.js';
import { createTripDomain } from './domains/trip/trip.controller.js';
import { createHolidayDomain } from './domains/holiday/holiday.controller.js';
import { createItemSyncDomain } from './domains/item-sync/item-sync.controller.js';
import { createExpenseDomain } from './domains/expense/expense.controller.js';
import { createChecklistDomain } from './domains/checklist/checklist.controller.js';
import { createItineraryDomain } from './domains/itinerary/itinerary.controller.js';
import { createBookingDomain } from './domains/booking/booking.controller.js';
import { createItemDomain } from './domains/item/item.controller.js';
import { createOutfitDomain } from './domains/outfit/outfit.controller.js';
import { createNotifyDomain } from './domains/notify/notify.controller.js';
import { createMediaDomain } from './domains/media/media.controller.js';
import { createFxDomain } from './domains/fx/fx.controller.js';
import { createMemoryDomain } from './domains/memory/memory.controller.js';
import { createHash } from 'node:crypto';
import { FieldCryptoService } from './common/crypto/field-crypto-service.js';
import { KeyState, type DekMaterial, type KmsClient } from './common/crypto/dek-store.js';

/** 微信 code 换 openid 的适配接口（生产接微信接口，测试注入桩） */
export interface WechatCodeExchanger {
  exchange(code: string): Promise<{ openid: string; unionId?: string }>;
}

export interface BuildAppOptions {
  /** 数据驱动；缺省用内存驱动（无 MySQL / Prisma 也能跑通全链路） */
  driver?: TableDriver & DriverTxRunner;
  /** access token 密钥（生产从 KMS / 环境变量注入） */
  tokenSecret?: string;
  ttlSeconds?: number;
  wechat?: WechatCodeExchanger;
  /** 合规授权汇率源 */
  fxSource?: FxRateSource;
  /** KMS 客户端（字段级加密；缺省用内存 KMS） */
  kms?: KmsClient;
  /** 对象存储预签名 */
  signUpload?: Parameters<typeof createMediaDomain>[0]['signUpload'];
  fetchObject?: Parameters<typeof createMediaDomain>[0]['fetchObject'];
  putObject?: Parameters<typeof createMediaDomain>[0]['putObject'];
  processor?: Parameters<typeof createMediaDomain>[0]['processor'];
  allowedMimePrefixes?: readonly string[];
  defaultTimezone?: string;
  auditRetentionDays?: number;
  now?: () => Date;
}

export interface BuiltApp {
  dispatch(req: RawRequest): Promise<ChainResult>;
  routes: RouteSpec<never, unknown>[];
  driver: TableDriver & DriverTxRunner;
  ctx: DomainContext;
  tokenSecret: string;
  /** 测试用：直接签一个 token */
  issueToken(userId: bigint): string;
  /** 服务实例（测试可直接调用，绕过 HTTP） */
  services: Record<string, unknown>;
}

export const DEFAULT_DEV_SECRET = 'dev-only-secret-change-me';

/**
 * 装配整个后端。
 *
 * ⛔ 不做任何 I/O（不连库、不拉汇率）—— 只构造对象图。
 *    这样单测可以毫秒级起一个全功能 app。
 */
export function buildApp(options: BuildAppOptions = {}): BuiltApp {
  // ① 启动期断言：权限矩阵必须完整（78 格）
  assertMatrixSize();

  // ② 授权源白名单（红线 R7）
  loadAuthorizedSources(process.env);

  // ③ M3 fail-fast：生产无合规源直接拒绝启动
  if (options.fxSource !== undefined) {
    assertFxSourceConfigured({
      nodeEnv: process.env.NODE_ENV ?? 'development',
      sources: [options.fxSource],
    });
  } else {
    assertFxSourceConfigured({
      nodeEnv: process.env.NODE_ENV ?? 'development',
      sources: [],
    });
  }

  const driver = options.driver ?? new MemoryTableDriver();
  const tokenSecret = options.tokenSecret ?? DEFAULT_DEV_SECRET;
  const retentionDays = options.auditRetentionDays ?? 365;

  // ④ 8 段链依赖
  const identityDeps: IdentityDeps = {
    driver,
    tokenSecret,
    ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
  };
  const deps = createChainDeps(identityDeps);

  // ⑤ 域上下文
  const ctx = createDomainContext({
    reader: driver,
    runner: driver,
    ...(options.now !== undefined ? { clock: options.now } : {}),
  });

  // ⑥ 字段级加密（C 组）：每个用户一个 DEK
  const kms = options.kms ?? createMemoryKms();
  const clockMs = options.now !== undefined ? () => options.now!().getTime() : Date.now;
  const cryptoFor = (userId: bigint): FieldCryptoService =>
    new FieldCryptoService(userId.toString(), kms, clockMs);

  const common = {
    ctx,
    auditRetentionDays: retentionDays,
    ...(options.now !== undefined ? { now: options.now } : {}),
  };

  // ⑦ 14 个域
  const authDomain = createAuthDomain({
    ...common,
    wechat: options.wechat ?? stubWechat(),
    signToken: (payload) => signToken(payload, tokenSecret),
    tokenTtlSeconds: options.ttlSeconds ?? 7 * 24 * 3600,
    ...(options.defaultTimezone !== undefined ? { defaultTimezone: options.defaultTimezone } : {}),
  });

  const familyDomain = createFamilyDomain(common);
  const wishDomain = createWishDomain(common);
  const tripDomain = createTripDomain(common);
  const holidayDomain = createHolidayDomain(common);
  const itemSyncDomain = createItemSyncDomain(common);
  const expenseDomain = createExpenseDomain({
    ...common,
    resolveRate: async ({ base, quote, tier, date }) => {
      // 由 fx 域统一取数（含缓存 / 落库 / 授权源校验），避免两套汇率口径
      try {
        const rate = await fxDomain.service.getRate({ base, quote, tier, date });
        return { rate: rate.rate, source: rate.source };
      } catch {
        return null; // 汇率缺失 → 待补（amount_base = null），绝不 1:1 兜底
      }
    },
  });
  const checklistDomain = createChecklistDomain(common);
  const itineraryDomain = createItineraryDomain(common);
  const bookingDomain = createBookingDomain({ ...common, cryptoFor });
  const itemDomain = createItemDomain(common);
  const outfitDomain = createOutfitDomain(common);
  const notifyDomain = createNotifyDomain(common);
  const mediaDomain = createMediaDomain({
    ...common,
    ...(options.signUpload !== undefined ? { signUpload: options.signUpload } : {}),
    ...(options.fetchObject !== undefined ? { fetchObject: options.fetchObject } : {}),
    ...(options.putObject !== undefined ? { putObject: options.putObject } : {}),
    ...(options.processor !== undefined ? { processor: options.processor } : {}),
    ...(options.allowedMimePrefixes !== undefined
      ? { allowedMimePrefixes: options.allowedMimePrefixes }
      : {}),
  });
  const fxDomain = createFxDomain({
    ...common,
    ...(options.fxSource !== undefined ? { source: options.fxSource } : {}),
  });
  const memoryDomain = createMemoryDomain(common);

  // ⑧ 汇总路由
  const routes: RouteSpec<never, unknown>[] = [
    ...authDomain.routes,
    ...familyDomain.routes,
    ...wishDomain.routes,
    ...tripDomain.routes,
    ...holidayDomain.routes,
    ...itemSyncDomain.routes,
    ...expenseDomain.routes,
    ...checklistDomain.routes,
    ...itineraryDomain.routes,
    ...bookingDomain.routes,
    ...itemDomain.routes,
    ...outfitDomain.routes,
    ...notifyDomain.routes,
    ...mediaDomain.routes,
    ...fxDomain.routes,
    ...memoryDomain.routes,
  ];

  assertNoDuplicateRoutes(routes);

  const dispatch = createDispatcher({ deps, routes });

  return {
    dispatch,
    routes,
    driver,
    ctx,
    tokenSecret,
    issueToken: (userId: bigint) =>
      signToken({ userId: userId.toString(), iat: Math.floor(Date.now() / 1000) }, tokenSecret),
    services: {
      auth: authDomain.service,
      family: familyDomain.service,
      wish: wishDomain.service,
      trip: tripDomain.service,
      holiday: holidayDomain.service,
      itemSync: itemSyncDomain.service,
      expense: expenseDomain.service,
      checklist: checklistDomain.service,
      itinerary: itineraryDomain.service,
      booking: bookingDomain.service,
      item: itemDomain.service,
      outfit: outfitDomain.service,
      notify: notifyDomain.service,
      media: mediaDomain.service,
      fx: fxDomain.service,
      memory: memoryDomain.service,
      cryptoFor,
    },
  };
}

/**
 * 路由唯一性断言 —— 同一 `(method, path)` 注册两次会让后注册的静默失效。
 * 这是最容易在「多人并行写域」时踩的坑，故启动期直接炸。
 */
function assertNoDuplicateRoutes(routes: readonly RouteSpec<never, unknown>[]): void {
  const seen = new Map<string, string>();
  for (const r of routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) {
      throw new Error(
        `路由重复注册：${key}（权限矩阵/派发单不允许同路径同方法两次）。已有：${seen.get(key)}`,
      );
    }
    seen.set(key, key);
  }
}

/** 开发态微信桩：openid = code（便于自测）；生产必须注入真实适配器 */
export function stubWechat(): WechatCodeExchanger {
  return {
    // 纯同步桩：接口要求 Promise，此处显式落地，避免 `async` 无 await 的空壳
    exchange(code: string): Promise<{ openid: string }> {
      if (!code) return Promise.reject(new Error('code 不得为空'));
      return Promise.resolve({ openid: `openid_${code}` });
    },
  };
}

/**
 * 内存 KMS —— 仅测试 / 开发。
 *
 * 生产接真实 KMS；DEK 明文**绝不落库**（C 组红线）。
 * 密钥由 `sha256(userId:keyVer)` 派生 —— 稳定、可复现，便于自测；
 * ⛔ 这**不是**密码学安全的密钥派生，仅限本地。
 */
export function createMemoryKms(): KmsClient {
  const store = new Map<string, DekMaterial>();

  const load = (userId: string, keyVer: number): DekMaterial => {
    const k = `${userId}:${keyVer}`;
    let hit = store.get(k);
    if (!hit) {
      hit = {
        keyVer,
        key: createHash('sha256').update(k).digest(), // 32B
        state: KeyState.Active,
      };
      store.set(k, hit);
    }
    return hit;
  };

  return {
    // ⚠️ 以下四个是**纯同步**实现（内存 Map），但接口声明为 Promise。
    //    用 `Promise.resolve(...)` 显式包装而不是 `async` —— 它们体内没有任何
    //    await，写 `async` 会让调用方误以为存在真实异步 I/O 边界。
    generateDek(userId: string): Promise<DekMaterial> {
      const versions = [...store.keys()].filter((k) => k.startsWith(`${userId}:`)).length;
      return Promise.resolve(load(userId, versions + 1));
    },
    getDek(userId: string, keyVer: number): Promise<DekMaterial> {
      return Promise.resolve(load(userId, keyVer));
    },
    listDekVersions(userId: string): Promise<Omit<DekMaterial, 'key'>[]> {
      return Promise.resolve(
        [...store.entries()]
          .filter(([k]) => k.startsWith(`${userId}:`))
          .map(([, m]) => ({ keyVer: m.keyVer, state: m.state }))
          .sort((a, b) => a.keyVer - b.keyVer),
      );
    },
    destroyDek(userId: string, keyVer: number): Promise<void> {
      const k = `${userId}:${keyVer}`;
      const hit = store.get(k);
      if (hit) store.set(k, { ...hit, state: KeyState.Destroyed });
      return Promise.resolve();
    },
  };
}
