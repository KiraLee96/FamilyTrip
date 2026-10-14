/**
 * 导航抽象层 —— H5 / 微信小程序 共用同一套跳转语义
 * ============================================================================
 * 设计要点（契约优先，不 fork）：
 *   - H5 原型期用 react-router（HashRouter）；小程序期改走 Taro 页面栈。
 *   - 页面与组件只依赖本文件的 `navigate / back / useRouteParams`，
 *     不感知底层是哪种路由实现，从而一套代码双端运行。
 *
 * 路由映射（逻辑路径 → Taro 页面，与 app.config.ts 的 pages 一一对应）：
 *   /            → pages/HomePage      （tab）
 *   /trips       → pages/TripsPage     （tab）
 *   /items       → pages/ItemsPage     （tab，M-Client-2 新增）
 *   /plan        → pages/PlanPage      （tab）
 *   /profile     → pages/ProfilePage   （tab，M-Client-2 新增）
 *   /wishes      → pages/WishPoolPage  （M-Client-2 起降级为非 tab，从首页区块进入）
 *   /trips/new   → pages/TripCreatePage（非 tab，须先于 /trips/:id 匹配）
 *   /trips/:id   → pages/TripDetailPage（非 tab，带 query 参数）
 *   /join        → pages/JoinFamilyPage（非 tab，?invite=CODE 凭邀请码加入）
 */

import Taro from '@tarojs/taro';

/** tab 页：用 switchTab 切换；非 tab 页：用 navigateTo 压栈 */
const TAB_PAGE: Record<string, string> = {
  '/': 'pages/HomePage',
  '/trips': 'pages/TripsPage',
  '/items': 'pages/ItemsPage',
  '/plan': 'pages/PlanPage',
  '/profile': 'pages/ProfilePage',
};

function toTaroUrl(to: string): { url: string; tab: boolean } {
  // 先切出查询串：tab 页不接受 query，非 tab 页原样透传（如 /join?invite=XXXX）
  const qIndex = to.indexOf('?');
  const path = qIndex >= 0 ? to.slice(0, qIndex) : to;
  const qs = qIndex >= 0 ? to.slice(qIndex) : '';
  if (path === '/trips/new') {
    return { url: `/pages/TripCreatePage${qs}`, tab: false };
  }
  if (path === '/join') {
    return { url: `/pages/JoinFamilyPage${qs}`, tab: false };
  }
  if (path.startsWith('/trips/')) {
    const id = encodeURIComponent(path.slice('/trips/'.length));
    return { url: `/pages/TripDetailPage?id=${id}`, tab: false };
  }
  const page = TAB_PAGE[path];
  if (page) return { url: `/${page}`, tab: true };
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
