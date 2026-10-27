/**
 * Taro 应用配置 —— 页面注册 + 原生 TabBar
 * ============================================================================
 * - pages 与 nav 抽象层的路由映射一一对应（见 src/nav/index.ts）
 * - tabBar 用「纯文字」五标签，刻意不配 iconPath，避免引入 PNG 资源
 *   （小程序要求 tabBar 图标必须是本地图片，原型期不增加资源维护面；
 *    设计稿中的线性图标待图标资源就位后再补）
 * - 2026-10-14 账号管理回归：tab 顺序 = 总览 / 规划 / 行程 / 物品 / 我的。
 *   微信 tabBar 硬上限 5 个，「回忆」让位给「我的」——回忆墙 MemoryPage
 *   保留为完整页面，从总览页「最近回忆 → 回忆墙」入口进入（非 tab）。
 * - 2026-10-27 反馈④：「物品库」与「物品清单」是两个并列入口、两套权限，用户分不清。
 *   物品库的 item 表并入常备清单（家庭常备 / 我的常备两半，靠 scope 区分），
 *   同一个东西只留一个入口。
 * - 2026-10-27 反馈④第三次：「物品清单还是要作为一个 tab」——
 *   恢复为一级 tab（而不是藏进「我的」的二级 tab，那会变成页面里两个入口）。
 *   tab 顺序：总览 / 规划 / 行程 / 物品 / 我的。
 * - 视觉：米纸底 #F5F0E4 + 深绿主色 #1E5B45
 */

export default {
  pages: [
    'pages/HomePage',
    'pages/PlanPage',
    'pages/TripsPage',
    'pages/ItemsPage',
    'pages/ProfilePage',
    'pages/MemoryPage',
    'pages/WishPoolPage',
    'pages/TripDetailPage',
    'pages/TripManagePage',
    'pages/TripCreatePage',
    'pages/JoinFamilyPage',
    'pages/JoinTripPage',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#f5f0e4',
    // 2026-10-16 需求：小程序顶部标题统一为「旅行管家AllInOne」（原「家庭出行计划」）
    navigationBarTitleText: '旅行管家AllInOne',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f5f0e4',
  },
  tabBar: {
    color: '#a89e88',
    selectedColor: '#1e5b45',
    backgroundColor: '#fbf7ec',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/HomePage', text: '总览' },
      { pagePath: 'pages/PlanPage', text: '规划' },
      { pagePath: 'pages/TripsPage', text: '行程' },
      { pagePath: 'pages/ItemsPage', text: '物品' },
      { pagePath: 'pages/ProfilePage', text: '我的' },
    ],
  },
};
