/**
 * API 基址解析（纯函数，便于单测锁定口径）
 * ============================================================================
 * 放在独立文件里，是因为 `config/index.ts` 依赖 `@tarojs/cli`（构建期 Node 环境），
 * 直接 import 到 vitest 会拖进整个 Taro CLI；这里只放零依赖的解析规则。
 *
 * 规则（2026-11-12）：
 *   · 未设置 / 未注入  → 线上后端（**默认，含 `taro dev:weapp` watch**）
 *   · 显式设为空字符串 → 空串 → 客户端回落 Mock（逃生口，仅离线原型用）
 *   · 显式设了其他值   → 原样透传（本地联调自建后端 / 预发环境）
 *
 * 🔴 不要用 `|| DEFAULT`：`'' || DEFAULT` 会把逃生口吃掉，Mock 就再也回不去了。
 *    `??` 只在 `undefined` / `null` 时兜底，正是这里需要的语义。
 */

/** 线上后端（生产与开发态共用；此前仅 NODE_ENV=production 才生效） */
export const DEFAULT_API_BASE_URL = 'https://api.familytripallinone.cn/api';

export function resolveApiBaseUrl(raw: string | undefined): string {
  return raw ?? DEFAULT_API_BASE_URL;
}

/** 供 `api/index.ts` 判定 adapter：`''` → Mock，非空 → http */
export function hasBackend(baseUrl: string): boolean {
  return Boolean(baseUrl);
}
