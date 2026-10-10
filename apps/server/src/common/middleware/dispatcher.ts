/**
 * 请求派发器 —— HTTP ⇄ 8 段链 的唯一桥接
 * ============================================================================
 * 设计取舍：
 *   NestJS 的 controller 只做「取原始入参 → 调 dispatch → 出信封」，
 *   不做任何业务判断。所有鉴权/校验/业务逻辑都在链里，
 *   这样「controller 薄」是可机械校验的（见 `common/ci/access-gate.ts`）。
 *
 * 🔴 出参形状唯一：无论成功、401、403、404、422、500，
 *    `dispatch` 一律返回 `ChainResult`，HTTP 层只负责 `status + json(envelope)`。
 *    这消除了「两种错误体形状」这个客户端最常见的解析坑。
 */

import type { z } from 'zod';
import {
  runChain,
  type ChainContext,
  type ChainDeps,
  type ChainResult,
  type HandlerSpec,
} from './chain.js';
import type { AccessMode, ResourceRef, ResourceType } from '../auth/access-policy.js';
import type { ResolvedOwnership } from './chain.js';
import { extractBearer } from './chain-deps.js';

/** 原始 HTTP 请求（框架无关，便于单测直接构造） */
export interface RawRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  /** 路径参数（:id 等） */
  params?: Record<string, string | undefined>;
  /** 查询串（已解析） */
  query?: Record<string, string | undefined>;
  /** 已解析 JSON body */
  body?: unknown;
}

/**
 * 路由声明 —— 一个路由 = 一个 handler + 其鉴权与校验要求。
 *
 * `auth.resource` 收 `id` 返回 `ResourceRef`；此处的 `resourceType`
 * 必须是 `ResourceType` 联合之一，且 `(resourceType, mode)` 组合
 * 必须在 78 格权限矩阵内（`isMatrixCombination` 在模块加载期断言）。
 */
export interface RouteSpec<TIn = unknown, TOut = unknown> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 路径模板，支持 `:id` */
  path: string;
  /** 取资源 id 的参数名；缺省 `id`。仅当 auth 非 public 时使用 */
  idParam?: string;
  auth:
    | { public: true }
    | {
        public: false;
        resourceType: ResourceType;
        mode: AccessMode;
        /**
         * 定制 ref 构造。
         *
         * 第三参  是链在 withOwner 段读到的**资源行归属**：
         * 默认 ref 用它填 familyId / tripId，避免信请求体（水平越权）。
         */
        ref?: (id: bigint, req: RawRequest, resolved: ResolvedOwnership) => ResourceRef;
      };
  schema?: z.ZodSchema<TIn>;
  handler: HandlerSpec<TIn, TOut>['handler'];
}

/** 编译后的路由（路径已正则化） */
interface CompiledRoute {
  spec: RouteSpec<never, unknown>;
  regex: RegExp;
  paramNames: string[];
}

export interface DispatchOptions {
  deps: ChainDeps;
  routes: RouteSpec<never, unknown>[];
  /** 未命中路由时的兜底（默认 404 同形） */
  onNoRoute?: (req: RawRequest) => ChainResult;
}

/** 把 `/wish/:id` 编译成 `^/wish/([^/]+)$` */
function compilePath(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${escaped}/?$`), paramNames };
}

export function createDispatcher(options: DispatchOptions) {
  const compiled: CompiledRoute[] = options.routes.map((r) => {
    const { regex, paramNames } = compilePath(r.path);
    return {
      spec: r,
      regex,
      paramNames,
    };
  });

  return async function dispatch(req: RawRequest): Promise<ChainResult> {
    const match = matchRoute(compiled, req);
    if (!match) {
      if (options.onNoRoute) return options.onNoRoute(req);
      return notFoundResult();
    }

    const { spec, params } = match;
    const rawId = params[spec.idParam ?? 'id'];

    // 构造 ChainContext：token 从 Authorization 提取
    const ctx: ChainContext = {
      token: extractBearer(req.headers['authorization'] ?? req.headers['Authorization']),
      requestId: req.headers['x-request-id'],
    };

    // 合并 query + path params 作为入参来源
    const rawInput =
      req.method === 'GET' || req.method === 'DELETE'
        ? { ...(req.query ?? {}), ...params }
        : { ...(req.body as Record<string, unknown> | undefined), ...params };

    const authSpec: HandlerSpec<never, unknown>['auth'] = spec.auth.public
      ? { public: true }
      : {
          public: false,
          mode: spec.auth.mode,
          resource: (id: bigint, resolved: ResolvedOwnership): ResourceRef => {
            if (spec.auth.public) {
              // 不可达分支 —— 仅为类型收窄
              return { type: 'user', id, familyId: null, tripId: null };
            }
            if (spec.auth.ref) return spec.auth.ref(id, req, resolved);
            return {
              type: spec.auth.resourceType,
              id,
              // 🔴 用**资源行**上的归属（resolved），不是请求体 ——
              //    信请求体 = 让人自己声明自己有权，等于没有权限系统
              familyId: resolved.familyId,
              tripId: resolved.tripId,
            };
          },
        };

    return runChain(
      options.deps,
      {
        auth: authSpec,
        schema: spec.schema,
        handler: spec.handler,
      },
      ctx,
      rawInput,
      rawId,
      params,
    );
  };
}

function matchRoute(
  compiled: CompiledRoute[],
  req: RawRequest,
): { spec: RouteSpec<never, unknown>; params: Record<string, string> } | null {
  const pathname = req.path.split('?')[0] ?? req.path;
  for (const c of compiled) {
    if (c.spec.method !== req.method) continue;
    const m = c.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.paramNames.forEach((name, i) => {
      params[name] = m[i + 1] ?? '';
    });
    return { spec: c.spec, params };
  }
  return null;
}

/**
 * 🔴 已删除「从请求体取 familyId / tripId 线索」的旧实现。
 *
 * 那正是水平越权的经典入口：调用方在 body 里写 `familyId=别人的家庭`，
 * 权限判定就会拿这个值去比对，等于让人自己声明自己有权。
 * 现在归属**只能**来自 withOwner 段对资源行的读取（见 chain.ts 第 5 段），
 * 派发器只负责把 `resolved` 透传给 `spec.auth.ref`。
 */

/** 未命中路由 —— 与 404 同形，不泄露「该路径是否存在」 */
function notFoundResult(): ChainResult {
  return {
    httpStatus: 404,
    envelope: { code: 4040, message: '资源不存在', data: null, meta: {} },
    reachedStage: 1,
  };
}
