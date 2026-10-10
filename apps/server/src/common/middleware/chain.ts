/**
 * 8 段统一中间件链（技术方案 §1.1，顺序不可调换）
 * ---------------------------------------------------------------------------
 * ```
 * resolveIdentity → loadUser → withFamily → withTrip → withOwner
 *   → validate → handler → responseEnvelope
 * ```
 *
 * 顺序理由：
 *   1resolveIdentity  解析 openid/token，得到一个「可能是谁的」标识
 *   2  loadUser        确认用户存在且未注销，拿到 userId
 *   3  withFamily      载入 U 所属家庭集合（权限维度一）
 *   4  withTrip        载入 U 参与的出行与访问级别（权限维度二）
 *   5  withOwner       解析私有资源归属，PRIVATE 短路在此具备判定条件
 *   6  validate        Zod schema 校验入参 —— 放在鉴权之后，避免用未认证请求打校验器
 *   7  handler         业务逻辑
 *   8  responseEnvelope 统一信封 + 写响应 meta.updatedAt/serverTime
 *
 * ⚠️ 早期返回（401/403/404/422）都必须**经responseEnvelope 出参**，
 * 否则客户端会收到两种形状的错误体。
 */

import { ZodError, type ZodSchema } from 'zod';
import {
  AppError,
  ErrorCode,
  notFoundIndistinguishable,
  unauthorized,
  validationFailed,
} from '../errors/error-code.js';
import { fail, ok, type Envelope, type ResponseMeta } from '../envelope/envelope.js';
import {
  Decision,
  checkAccess,
  type AccessLevel,
  type AccessMode,
  type PermissionContext,
  type ResourceRef,
} from '../auth/access-policy.js';

/** 链路上下文 —— 逐段填充 */
/**
 * withOwner 段从**资源行**读到的归属维度。
 *
 * 一个形状覆盖两类资源，避免调用方各写一套签名：
 *   · SHARED 域（家庭/出行）→ 用 `familyId` / `tripId`
 *   · PRIVATE 域（物品/穿搭）→ 用 `ownerId` / `managedBy`
 */
export interface ResolvedOwnership {
  familyId: bigint | null;
  tripId: bigint | null;
  ownerId: bigint | null;
  managedBy: bigint | null;
  /**
   * 双语义表（`trip_checklist_item` / `checklist_template`）的域标记。
   *
   * `'SHARED' | 'PERSONAL'`；非双语义表为 `undefined`。
   * 消费方必须原样透传给 `ResourceRef.scope` —— 链条第 5 段只负责**读出来**，
   * 不下判定；域分流在 `resolveChecklistDomain` 里单点收敛。
   */
  scope?: string;
}

export interface ChainContext {
  /** 1 · resolveIdentity */
  token?: string;
  openid?: string;
  /** 2 · loadUser */
  userId?: bigint;
  /** 3 · withFamily */
  familyIds?: ReadonlySet<bigint>;
  managedFamilyIds?: ReadonlySet<bigint>;
  /** 4 · withTrip */
  tripAccess?: ReadonlyMap<bigint, AccessLevel>;
  /** 5 · withOwner */
  ownerId?: bigint | null;
  managedBy?: bigint | null;
  scope?: string;
  /** 5 · 资源**行**上的归属维度（非请求体）—— 权限判定的唯一依据 */
  familyId?: bigint | null;
  tripId?: bigint | null;
  /** 5 · 已解析并通过权限判定的资源 ID（写/删场景 handler 直接用） */
  resourceId?: bigint;
  /** DB 当前时间；⛔ 禁应用服务器 new Date() */
  dbNow?: Date;
  requestId?: string;
}

export type Stage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 依赖注入 —— 各段的外部能力由app.module 绑定 */
export interface ChainDeps {
  resolveIdentity(token: string): Promise<{ openid?: string; userId?: bigint } | null>;
  loadUser(userId: bigint): Promise<{ id: bigint; active: boolean } | null>;
  loadFamilyIds(userId: bigint): Promise<ReadonlySet<bigint>>;
  loadManagedFamilyIds(userId: bigint): Promise<ReadonlySet<bigint>>;
  loadTripAccess(userId: bigint): Promise<ReadonlyMap<bigint, AccessLevel>>;
  /**
   * 定位某行属于谁 / 属于哪个家庭 / 属于哪次出行。
   *
   * 🔴 必须回带 `familyId` / `tripId`
   *   否则 SHARED_FAMILY / SHARED_TRIP 维度的判定拿不到比对依据，
   *   会把「自己是成员」的资源误判为不存在（误拒）。
   *   `ownerId` / `managedBy` 供 PRIVATE 与代管短路用。
   */
  loadOwnerRef(rowId: bigint): Promise<{
    ownerId: bigint | null;
    managedBy: bigint | null;
    scope?: string | undefined;
    familyId?: bigint | null;
    tripId?: bigint | null;
    type?: string | undefined;
  } | null>;
  /** DB 时间来源 */
  dbNow(): Promise<Date>;
}

export interface HandlerSpec<TIn, TOut> {
  /** 鉴权配置：public 跳过鉴权；带 resource 则走权限判定 */
  auth:
    | { public: true }
    | {
        public: false;
        /**
         * 由资源 id + **已解析的归属**构造 ResourceRef。
         *
         * `resolved` 来自 withOwner 段对资源行的读取，不是请求体 ——
         * 用它填 familyId / tripId 才能保证「资源属于谁」的判定可信。
         */
        resource: (id: bigint, resolved: ResolvedOwnership) => ResourceRef;
        mode: AccessMode;
      };
  /** 第 6 段 schema；不校验则省略 */
  schema?: ZodSchema<TIn>;
  /** 第 7 段 */
  handler(
    ctx: ChainContext,
    input: TIn,
    params: Readonly<Record<string, string>>,
  ): Promise<{ data: TOut; meta?: ResponseMeta }>;
}

export interface ChainResult {
  httpStatus: number;
  envelope: Envelope<unknown>;
  /** 实际执行到的段 */
  reachedStage: Stage;
}

/**
 * 统一入口。
 *
 * 不抛异常 —— 任何失败都在这里收敛成信封返回，
 * 避免异常穿透导致客户端拿到非统一形状。
 */
export async function runChain<TIn, TOut>(
  deps: ChainDeps,
  spec: HandlerSpec<TIn, TOut>,
  ctx: ChainContext,
  rawInput: unknown,
  rawId?: string,
  params: Readonly<Record<string, string>> = {},
): Promise<ChainResult> {
  try {
    // ── 1 · resolveIdentity ─────────────────────────────────
    let reached: Stage = 1;
    if (!spec.auth.public) {
      if (!ctx.token) {
        return err(unauthorized('缺少 Authorization'), 1);
      }
      const identity = await deps.resolveIdentity(ctx.token);
      if (!identity) {
        return err(unauthorized('凭证无效或已过期'), 1);
      }
      ctx.openid = identity.openid ?? ctx.openid;
      ctx.userId = identity.userId ?? ctx.userId;
      reached = 2;

      // ── 2 · loadUser ─────────────────────────────────────
      if (ctx.userId === undefined) {
        return err(unauthorized('无法定位用户'), 2);
      }
      const user = await deps.loadUser(ctx.userId);
      if (!user || !user.active) {
        // 用户不存在/已注销 —— 与「不存在」同形，避免枚举
        return err(notFoundIndistinguishable(), 2);
      }
      ctx.userId = user.id;
      reached = 3;

      // ── 3 · withFamily ───────────────────────────────────
      const [familyIds, managedFamilyIds] = await Promise.all([
        deps.loadFamilyIds(ctx.userId),
        deps.loadManagedFamilyIds(ctx.userId),
      ]);
      ctx.familyIds = familyIds;
      ctx.managedFamilyIds = managedFamilyIds;
      reached = 4;

      // ── 4 · withTrip ─────────────────────────────────────
      ctx.tripAccess = await deps.loadTripAccess(ctx.userId);
      reached = 5;

      // ── 5 · withOwner（PRIVATE 短路的前置）───────────────
      if (rawId !== undefined) {
        const id = toBigint(rawId);
        if (id === null) return err(notFoundIndistinguishable(), 5);
        const owner = await deps.loadOwnerRef(id);
        if (!owner) return err(notFoundIndistinguishable(), 5);
        ctx.ownerId = owner.ownerId;
        ctx.managedBy = owner.managedBy;
        ctx.scope = owner.scope;
        ctx.resourceId = id;
        // 归属维度来自**资源行**，不是请求体 —— 否则就是水平越权
        ctx.familyId = owner.familyId ?? null;
        ctx.tripId = owner.tripId ?? null;

        const resource = spec.auth.resource(id, {
          familyId: ctx.familyId ?? null,
          tripId: ctx.tripId ?? null,
          ownerId: owner.ownerId ?? null,
          managedBy: owner.managedBy ?? null,
          // 双语义表的域标记必须透传；非双语义表为 undefined（消费方自行兜底）
          ...(owner.scope !== undefined ? { scope: owner.scope } : {}),
        });
        const pctx: PermissionContext = {
          identity: { userId: ctx.userId },
          familyIds: ctx.familyIds,
          managedFamilyIds: ctx.managedFamilyIds,
          tripAccess: ctx.tripAccess,
        };
        const { decision } = checkAccess(pctx, resource, spec.auth.mode);
        if (decision !== Decision.Allow) {
          // 🔴 越权与不存在**逐字节一致**
          return err(notFoundIndistinguishable(), 5);
        }
      }
      reached = 6;
    }

    // ── 6 · validate ───────────────────────────────────────
    let input: TIn;
    if (spec.schema) {
      const parsed = spec.schema.safeParse(rawInput);
      if (!parsed.success) return err(validationFailed(zodToDetails(parsed.error)), 6);
      input = parsed.data;
    } else {
      input = rawInput as TIn;
    }

    // ── 7 · handler ────────────────────────────────────────
    const out = await spec.handler(ctx, input, params);

    // ── 8 · responseEnvelope ───────────────────────────────
    reached = 8;
    const dbNow = await deps.dbNow();
    const meta: ResponseMeta = {
      ...out.meta,
      serverTime: dbNow.toISOString(),
    };
    return { httpStatus: 200, envelope: ok(out.data, meta), reachedStage: reached };
  } catch (e) {
    return err(toAppError(e), 0);
  }
}

function err(error: AppError, stage: Stage | 0): ChainResult {
  return {
    httpStatus: error.httpStatus,
    envelope: fail(error.code, error.message, { reachedStage: stage || undefined }),
    reachedStage: stage || 8,
  };
}

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) return validationFailed(zodToDetails(e));
  return new AppError(ErrorCode.INTERNAL_ERROR, '服务内部错误');
}

function zodToDetails(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function toBigint(raw: string): bigint | null {
  try {
    if (!/^\d+$/.test(raw)) return null;
    return BigInt(raw);
  } catch {
    return null;
  }
}
