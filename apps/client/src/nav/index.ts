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
 *   /profile     → pages/ProfilePage   （tab：我的，2026-10-14 账号管理回归）
 *   /memory      → pages/MemoryPage    （非 tab：回忆墙，从总览页「最近回忆」进入）
 *   /wishes      → pages/WishPoolPage  （非 tab，从首页/规划页心愿区块进入）
 *   /trips/new   → pages/TripCreatePage（非 tab，须先于 /trips/:id 匹配）
 *   /trips/:id   → pages/TripDetailPage（非 tab，带 query 参数，?tab=expense 可定位花销）
 *   /trips/:id/manage → pages/TripManagePage（非 tab，邀请同行人 + 参与人，2026-10-26）
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
  // 行程管理：/trips/:id/manage → /pages/TripManagePage?id=:id
  // 🔴 2026-10-26：新增 /manage 子路径后，必须先拦它，否则会被下方 `/trips/` 分支
  //    误当成 id（id 会变成 "101/manage"，页面拿到脏 id 静默显示空态）。
  // 🔴 2026-10-16 修复一：此前此分支漏拼 qs，导致 /trips/101?tab=expense（总览页
  //    「查看账本」入口）与 ?tab=memory&readonly=1（回忆墙只读入口）的 query 全丢，
  //    页面永远落到默认 itinerary tab。非 tab 页本就该原样透传查询串。
  // 🔴 2026-10-16 修复二：qs 自带前导 '?'，直接拼在 "?id=" 后会形成双重 '?'，
  //    浏览器把第二个 '?' 当作 id 值的一部分（id 被污染成 "103?tab=memory"），
  //    必须剥掉前导 '?' 并用 '&' 连接。
  if (path.startsWith('/trips/') && path.endsWith('/manage')) {
    const rawId = path.slice('/trips/'.length, path.length - '/manage'.length);
    const id = encodeURIComponent(rawId);
    const tail = qs.startsWith('?') ? qs.slice(1) : qs;
    return {
      url:
        tail === '' ? `/pages/TripManagePage?id=${id}` : `/pages/TripManagePage?id=${id}&${tail}`,
      tab: false,
    };
  }

  if (path.startsWith('/trips/') && path !== '/trips/new' && path !== '/trips/join') {
    const id = encodeURIComponent(path.slice('/trips/'.length));
    const tail = qs.startsWith('?') ? qs.slice(1) : qs;
    return {
      url:
        tail === '' ? `/pages/TripDetailPage?id=${id}` : `/pages/TripDetailPage?id=${id}&${tail}`,
      tab: false,
    };
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

/**
 * 「返回」语义的跳转 —— 有上一页就**退栈**，没有才重定向。
 * ============================================================================
 * 🔴 2026-10-26 修复「routeDone with a webviewId N is not found」：
 *    页面之间来回跳时，如果用 `Link`（= navigateTo）表达「返回」，每往返一次
 *    就往页面栈里压一层**新页面实例**（详情 → 管理 → 详情' → 管理' …）。
 *    微信小程序栈上限 10 层，撞上限后路由层引用的 webview 已被销毁，于是报
 *    `[Page route 错误(system error)] routeDone with a webviewId N is not found`。
 *
 *    规则：**表达「回退」只能用 back / backOr，永远不要用 Link 指回上一页**。
 *    用 `getCurrentPages().length > 1` 判断是否有上一页 —— 直接深链进入本页
 *    （扫码 / 分享卡片 / 开发者工具启动页）时栈里只有自己，此时退栈会失败，
 *    改为 redirectTo 覆盖当前页，保证用户不会卡在一个没有出口的页面。
 */
export function backOr(fallbackTo: string): void {
  const depth = Taro.getCurrentPages().length;
  if (depth > 1) {
    void Taro.navigateBack().catch(() => {});
    return;
  }
  const { url } = toTaroUrl(fallbackTo);
  void Taro.redirectTo({ url }).catch(() => {});
}

/** 读取当前页面路由参数（替代 react-router 的 useParams） */
export function useRouteParams<T extends Record<string, string> = Record<string, string>>(): T {
  const router = Taro.getCurrentInstance().router;
  return (router?.params ?? {}) as T;
}
