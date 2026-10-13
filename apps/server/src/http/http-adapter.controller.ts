/**
 * HTTP 适配器 —— NestJS ⇄ 派发器
 * ============================================================================
 * 职责边界（严格）：
 *   ✅ 取出原始 HTTP 入参（method/path/headers/query/body/params）
 *   ✅ 调 `dispatch(req)`
 *   ✅ 按 `ChainResult.httpStatus` 写回状态码 + JSON 信封
 *   ⛔ 不做任何业务判断、鉴权、校验 —— 那些全在 8 段链里
 *
 * 这样「controller 薄」是可机械校验的：本文件除转发外没有第二个分支。
 * 见 `common/ci/access-gate.ts`。
 *
 * 🔴 出参形状唯一
 *   成功 / 401 / 403 / 404 / 422 / 409 / 500 一律同形 `{code,message,data,meta}`。
 *   客户端只需一套解析逻辑。
 */

import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { RawRequest } from '../common/middleware/dispatcher.js';
import type { BuiltApp } from '../composition-root.js';
// 令牌定义在叶子模块（不是 app.module）以避免循环依赖，详见 app-token.ts
import { APP_TOKEN } from './app-token.js';

/** 路由前缀（与客户端 baseURL 对齐） */
export const API_PREFIX = 'api';

@Controller(API_PREFIX)
export class HttpAdapterController {
  constructor(@Inject(APP_TOKEN) private readonly app: BuiltApp) {}

  /**
   * 通配所有方法 + 所有子路径，交给派发器按路由表匹配。
   *
   * ⚠️ NestJS 的 `@All('*')` 在 Express 5 下需要 `'{*path}'` 语法；
   * ⚠️ 必须用裸 `'*'`，不能用 `'*path'`：
   *    express 4.22.1 的 path-to-regexp 已是 0.1.13，`*name` 语义从「纯通配」
   *    变为「`.*` + 字面量 name」——`'/api/*path'` 编译为
   *    `/^\/api\/(.*)path\/?$/i`，要求 URL 以 "path" 结尾，一切真实请求 miss。
   *    （`'{*path}'` 是 path-to-regexp v6+ 语法，0.1.13 不识别，同样不可用。）
   *    本 controller 自行从 originalUrl 剥前缀，不依赖 req.params，裸通配即足。
   */
  @All('*')
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const prefix = `/${API_PREFIX}`;
    const full = req.originalUrl ?? req.url ?? '/';
    const pathname = full.split('?')[0] ?? full;
    const path = pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;

    const raw: RawRequest = {
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      headers: normalizeHeaders(req.headers),
      params: (req.params ?? {}) as Record<string, string>,
      query: normalizeQuery(req.query),
      body: req.body as unknown,
    };

    const result = await this.app.dispatch(raw);

    res.status(result.httpStatus).json(result.envelope);
  }
}

/** header 值归一化为 `string | undefined`（数组取首个） */
function normalizeHeaders(h: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined);
  }
  return out;
}

/** query 值归一化为 `string | undefined`（数组取首个） */
function normalizeQuery(q: Record<string, unknown>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(q)) {
    out[k] = Array.isArray(v) ? (v[0] as string | undefined) : (v as string | undefined);
  }
  return out;
}
