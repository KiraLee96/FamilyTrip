/**
 * ChainDeps 工厂 —— 8 段链的 7 个外部能力实现
 * ============================================================================
 * `common/middleware/chain.ts` 只声明 `ChainDeps` 接口，不关心数据从哪来。
 * 本文件是**唯一**把这些接口接到表驱动上的地方。
 *
 * 🔴 关键约束：
 *   · `loadTripAccess` 必须返回 `ACTIVE|HISTORICAL_READONLY` 两级，
 *     不能只返回「是否参与」——B6 历史只读保留依赖级别区分。
 *   · `resolveIdentity` 收到的是 access token，需要解密 + 校验有效期。
 *     v0.1 用 HMAC 签名令牌（无状态），后续可换 JWT/微信 session_key。
 *   · `loadOwnerRef` 的 `scope` 只对**双语义表**有意义
 *     （`trip_checklist_item` / `checklist_template`），其余表返回 undefined。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChainDeps } from '../middleware/chain.js';
import { AccessLevel as AccessLevelEnum } from '../auth/access-policy.js';
import type { AccessLevel } from '../auth/access-policy.js';
import { resolveChecklistDomain, AccessDomain } from '../auth/access-policy.js';
import type { TableDriver, Row } from '../db/table-client.js';

export interface IdentityDeps {
  driver: TableDriver;
  /** access token 签名密钥（部署时注入；测试可用固定值） */
  tokenSecret: string;
  /** 令牌有效期（秒） */
  ttlSeconds?: number;
}

/** 令牌载荷 */
export interface TokenPayload {
  userId: string;
  /** 签发时间（秒） */
  iat: number;
}

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天

/**
 * 签发 access token。
 * 格式：`base64url(payloadJson).base64url(hmacSha256)` —— 无状态、可水平扩展。
 */
export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验并解出载荷。任何失败（格式/签名/过期）一律返回 `null`。
 *
 * ⚠️ 用 `timingSafeEqual` 比对签名，避免时序侧信道。
 */
export function verifyToken(
  token: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];

  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    return null;
  }
  if (typeof payload.userId !== 'string' || typeof payload.iat !== 'number') return null;
  if (!/^\d+$/.test(payload.userId)) return null;
  if (nowSeconds - payload.iat > ttlSeconds) return null;
  return payload;
}

/** 从 `Authorization: Bearer xxx` 里取出 token */
export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : undefined;
}

/**
 * 构造生产/测试共用的 `ChainDeps`。
 *
 * 每个函数都对**软删**敏感：`deletedAt: null` 是默认过滤条件，
 * 漏掉会把已删数据重新暴露给用户。
 */
export function createChainDeps(deps: IdentityDeps): ChainDeps {
  const { driver, tokenSecret } = deps;
  const ttl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  return {
    // ── 1 · resolveIdentity ──────────────────────────────
    // HMAC 校验是同步的；接口要求 Promise，用 Promise.resolve 显式落地。
    resolveIdentity(token: string): Promise<{ userId: bigint } | null> {
      const payload = verifyToken(token, tokenSecret, ttl);
      if (!payload) return Promise.resolve(null);
      return Promise.resolve({ userId: BigInt(payload.userId) });
    },

    // ── 2 · loadUser ────────────────────────────────────
    async loadUser(userId: bigint) {
      const row = await driver.findUnique('user', { id: userId, deletedAt: null });
      if (!row) return null;
      return { id: row['id'] as bigint, active: row['status'] === 'ACTIVE' };
    },

    // ── 3 · withFamily ──────────────────────────────────
    async loadFamilyIds(userId: bigint) {
      const rows = await driver.findMany('familyMember', {
        where: { userId, deletedAt: null },
      });
      return new Set(rows.map((r) => r['familyId'] as bigint));
    },

    async loadManagedFamilyIds(userId: bigint) {
      // managed_by 指向「代管人」：虚拟成员（无 userId）由谁代管
      const rows = await driver.findMany('familyMember', {
        where: { managedBy: userId, deletedAt: null },
      });
      return new Set(rows.map((r) => r['familyId'] as bigint));
    },

    // ── 4 · withTrip ────────────────────────────────────
    async loadTripAccess(userId: bigint) {
      const map = new Map<bigint, AccessLevel>();
      const rows = await driver.findMany('tripMember', {
        where: { userId, deletedAt: null },
      });
      for (const r of rows) {
        const level =
          r['accessLevel'] === 'HISTORICAL_READONLY'
            ? AccessLevelEnum.HistoricalReadOnly
            : AccessLevelEnum.Active;
        map.set(r['tripId'] as bigint, level);
      }
      // 虚拟成员：本人不作为 trip_member.user_id 出现，但可能被代管
      const managed = await driver.findMany('tripMember', {
        where: { managedBy: userId, deletedAt: null },
      });
      for (const r of managed) {
        const tripId = r['tripId'] as bigint;
        if (map.has(tripId)) continue;
        map.set(
          tripId,
          r['accessLevel'] === 'HISTORICAL_READONLY'
            ? AccessLevelEnum.HistoricalReadOnly
            : AccessLevelEnum.Active,
        );
      }
      return map;
    },

    // ── 5 · withOwner ───────────────────────────────────
    async loadOwnerRef(rowId: bigint) {
      // 该行可能是任意私有/双语义表的记录。逐表探测是 O(表数)，
      // v0.1 可接受（无索引瓶颈）；v1.5 上「统一资源路由表」后再优化。
      //
      // 🔴 双语义表（trip_checklist_item / checklist_template）**不能**简单地
      //    放进「私有探测」里：那会让 SHARED 的清单项被当成 PRIVATE，
      //    从而永远拿不到 familyId/tripId —— 表现为「自己在共享清单里勾不了」。
      //    正确做法：先读行，**按 scope 分流** ——
      //      · PERSONAL → 走私有域（ownerId/managedBy，短路判定）
      //      · SHARED   → 交由下面的 resolveSharedScope 补 familyId/tripId
      const privateProbes: Array<{ model: string; scopeOf?: (r: Row) => string }> = [
        { model: 'item', scopeOf: () => 'PERSONAL' },
        { model: 'outfit', scopeOf: () => 'PERSONAL' },
      ];
      for (const p of privateProbes) {
        const row = await driver.findUnique(p.model, { id: rowId, deletedAt: null });
        if (row) {
          return {
            ownerId: (row['ownerId'] ?? null) as bigint | null,
            managedBy: (row['managedBy'] ?? null) as bigint | null,
            scope: p.scopeOf ? p.scopeOf(row) : undefined,
          };
        }
      }

      // 双语义表：只有 PERSONAL 才在这里返回；SHARED 必须落到共享探测
      const dualProbes = ['tripChecklistItem', 'checklistTemplate'] as const;
      for (const model of dualProbes) {
        const row = await driver.findUnique(model, { id: rowId, deletedAt: null });
        if (!row) continue;
        // `scope` 列是 VARCHAR，DB 驱动可能回带非 string（不同驱动/类型映射差异），
        // 这里显式归一化，避免 `"[object Object]"` 被当成合法 scope 值。
        const rawScope = row['scope'];
        const domain = resolveChecklistDomain({
          scope: typeof rawScope === 'string' ? rawScope : '',
          ownerId: (row['ownerId'] ?? null) as bigint | null,
        });
        if (domain === AccessDomain.Private) {
          return {
            ownerId: (row['ownerId'] ?? null) as bigint | null,
            managedBy: (row['managedBy'] ?? null) as bigint | null,
            scope: 'PERSONAL',
          };
        }
        // SHARED → 继续往下，由 resolveSharedScope 带出 familyId/tripId
        break;
      }

      // 非私有资源（家庭/出行维度）—— 必须带回**该行所属的 familyId / tripId**，
      // 否则 `checkAccess` 拿不到 SHARED_FAMILY / SHARED_TRIP 维度的比对依据，
      // 会把「自己是成员」的资源误判为不存在（水平越权 vs 误拒都很危险）。
      const scopeOfRow = await resolveSharedScope(rowId);
      if (scopeOfRow) return scopeOfRow;
      return null;
    },

    // ── DB 时间 ─────────────────────────────────────────
    dbNow: () => driver.dbNow(),
  };

  /**
   * 探测该 id 属于哪张「按家庭/出行授权」的表，并回带归属维度。
   *
   * 顺序：先探「直接带 familyId 的表」，再探「经 tripId 间接归属的表」。
   * 返回 null 表示该 id 不属于任何已知业务表 → 上层按 404 处理。
   */
  async function resolveSharedScope(
    rowId: bigint,
  ): Promise<{
    ownerId: bigint | null;
    managedBy: bigint | null;
    scope: string | undefined;
    familyId: bigint | null;
    tripId: bigint | null;
    type?: string;
  } | null> {
    // ① family 自身
    const family = await driver.findUnique('family', { id: rowId });
    if (family) {
      return {
        ownerId: null,
        managedBy: null,
        scope: undefined,
        familyId: rowId,
        tripId: null,
        type: 'family',
      };
    }
    // ② family_member（自身行）：归属其 familyId
    const famMember = await driver.findUnique('familyMember', { id: rowId, deletedAt: null });
    if (famMember) {
      return {
        ownerId: (famMember['userId'] ?? null) as bigint | null,
        managedBy: (famMember['managedBy'] ?? null) as bigint | null,
        scope: undefined,
        familyId: famMember['familyId'] as bigint,
        tripId: null,
        type: 'family_member',
      };
    }
    // ③ 直接带 familyId 的共享域表
    const familyScoped = ['wish', 'expense'] as const;
    for (const m of familyScoped) {
      const row = await driver.findUnique(m, { id: rowId, deletedAt: null });
      if (row) {
        return {
          ownerId: null,
          managedBy: null,
          scope: undefined,
          familyId: (row['familyId'] ?? null) as bigint | null,
          tripId: (row['tripId'] ?? null) as bigint | null,
          type: m,
        };
      }
    }
    // ④ 直接带 tripId 的共享域表
    const tripScoped = [
      'trip',
      'tripMember',
      'itineraryItem',
      'booking',
      'tripChecklistItem',
      'reminderTask',
      'mediaAsset',
    ] as const;
    for (const m of tripScoped) {
      const row = await driver.findUnique(m, { id: rowId, deletedAt: null });
      if (row) {
        // 某些表（如 trip_member）用 tripId 归属；trip 自身 id 就是 tripId
        const tripId = m === 'trip' ? rowId : ((row['tripId'] ?? null) as bigint | null);
        // 表自带 family_id 的行优先用**行上的值**，只有没有时才回查父行程。
        //
        // 🔴 D-2026-10-22-01 修复（P1 的前置缺陷）：原先一律走 `familyIdOfTrip(tripId)`，
        //    导致 media_asset 两类行在权限层被误判为「不属于任何家庭」→ 恒 404：
        //      · `trip_id IS NULL` 的家庭照片 → familyIdOfTrip(null) = null
        //        （家庭照片**完全删不掉**）；
        //      · 父行程已软删 → familyIdOfTrip 带 `deletedAt: null` → null
        //        （行程删了照片也删不掉，与 trip.service「照片是家庭资产、
        //          行程删了仍应在『我的照片』可见」的设计直接冲突）。
        //    media_asset.family_id 是 NOT NULL 的物理列，不随行程软删失效，用它才对。
        const ownFamilyId = (row['familyId'] ?? null) as bigint | null;
        const familyId = ownFamilyId ?? (await familyIdOfTrip(tripId));
        return {
          ownerId: (row['ownerId'] ?? null) as bigint | null,
          managedBy: (row['managedBy'] ?? null) as bigint | null,
          scope: undefined,
          familyId,
          tripId,
          type: m,
        };
      }
    }
    // ⑤ memory_archive
    const mem = await driver.findUnique('memoryArchive', { id: rowId });
    if (mem) {
      return {
        ownerId: null,
        managedBy: null,
        scope: undefined,
        familyId: (mem['familyId'] ?? null) as bigint | null,
        tripId: (mem['refId'] ?? null) as bigint | null,
        type: 'memory_archive',
      };
    }
    return null;
  }

  /** 由 tripId 反查 familyId（子表没有冗余 familyId 时用） */
  async function familyIdOfTrip(tripId: bigint | null): Promise<bigint | null> {
    if (tripId === null) return null;
    const trip = await driver.findUnique('trip', { id: tripId, deletedAt: null });
    return trip ? ((trip['familyId'] ?? null) as bigint | null) : null;
  }
}
