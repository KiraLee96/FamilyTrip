/**
 * 导航抽象层 —— H5 / 微信小程序 共用同一套跳转语义
 * ============================================================================
 * 设计要点（契约优先，不 fork）：
 *   - H5 原型期用 react-router（HashRouter）；小程序期改走 Taro 页面栈。
 *   - 页面与组件只依赖本文件的 `navigate / back / useRouteParams`，
 *     不感知底层是哪种路由实现，从而一套代码双端运行。
 *
 * 路由映射（逻辑路径 → Taro 页面，与 app.config.ts 的 pages 一一对应）：
 *   /            → pages/HomePage      （tab：总览）
 *   /plan        → pages/PlanPage      （tab：规划）
 *   /trips       → pages/TripsPage     （tab：行程）
 *   /items       → pages/ItemsPage     （tab：物品）
 *   /profile     → pages/ProfilePage   （tab：我的，2026-10-14 账号管理回归）
 *   /memory      → pages/MemoryPage    （非 tab：回忆墙，从总览页「最近回忆」进入）
 *   /wishes      → pages/WishPoolPage  （非 tab，从首页/规划页心愿区块进入）
 *   /trips/new   → pages/TripCreatePage（非 tab，须先于 /trips/:id 匹配）
 *   /trips/:id   → pages/TripDetailPage（非 tab，带 query 参数，?tab=expense 可定位花销）
 *   /trips/join  → pages/JoinTripPage  （非 tab，?invite=CODE 凭行程邀请码加入）
 *   /join        → pages/JoinFamilyPage（非 tab，?invite=CODE 凭邀请码加入家庭）
 *
 * 2026-10-14 修复：此前非 tab 页（/profile /wishes /memory）落在 fallback
 * `return { url: to }`，产出 `/profile` 这类非法页面路径，navigateTo 静默
 * 失败（.catch 吞错）——表现为「头像点了没反应」。现全部显式映射。
 */

import Taro from '@tarojs/taro';

/** tab 页：用 switchTab 切换；非 tab 页：用 navigateTo 压栈 */
const TAB_PAGE: Record<string, string> = {
  '/': 'pages/HomePage',
  '/plan': 'pages/PlanPage',
  '/trips': 'pages/TripsPage',
  '/items': 'pages/ItemsPage',
  '/profile': 'pages/ProfilePage',
};

/** 非 tab 页：显式映射，禁止再落 fallback（防静默失败） */
const NON_TAB_PAGE: Record<string, string> = {
  '/memory': 'pages/MemoryPage',
  '/wishes': 'pages/WishPoolPage',
  '/profile': 'pages/ProfilePage',
  '/trips/new': 'pages/TripCreatePage',
  '/trips/join': 'pages/JoinTripPage',
  '/join': 'pages/JoinFamilyPage',
};

function toTaroUrl(to: string): { url: string; tab: boolean } {
  // 先切出查询串：tab 页不接受 query，非 tab 页原样透传（如 /join?invite=XXXX）
  const qIndex = to.indexOf('?');
  const path = qIndex >= 0 ? to.slice(0, qIndex) : to;
  const qs = qIndex >= 0 ? to.slice(qIndex) : '';

  // 行程详情：/trips/:id → /pages/TripDetailPage?id=:id（须先于 /trips 前缀判断）
  if (path.startsWith('/trips/') && path !== '/trips/new' && path !== '/trips/join') {
    const id = encodeURIComponent(path.slice('/trips/'.length));
    return { url: `/pages/TripDetailPage?id=${id}`, tab: false };
  }

  const tabPage = TAB_PAGE[path];
  if (tabPage) return { url: `/${tabPage}`, tab: true };

  const nonTabPage = NON_TAB_PAGE[path];
  if (nonTabPage) return { url: `/${nonTabPage}${qs}`, tab: false };

  // 未登记的逻辑路径：开发期配置疏漏，显式告警而不是静默跳转一个死链
  console.error(`[nav] 未登记的路由：${to}（请在 nav/index.ts 补全映射）`);
  return { url: to, tab: false };
}

/** 跳转：tab 页走 switchTab，其余走 navigateTo（带参数时走 query） */
export function navigate(to: string): void {
  if (!to) return;
  const { url, tab } = toTaroUrl(to);
  if (tab) {
    void Taro.switchTab({ url }).catch(() => {});
    return;
  }
  void Taro.navigateTo({ url }).catch(() => {});
}

/** 返回上一页 */
export function back(): void {
  void Taro.navigateBack().catch(() => {});
}

/** 读取当前页面路由参数（替代 react-router 的 useParams） */
export function useRouteParams<T extends Record<string, string> = Record<string, string>>(): T {
  const router = Taro.getCurrentInstance().router;
  return (router?.params ?? {}) as T;
}
