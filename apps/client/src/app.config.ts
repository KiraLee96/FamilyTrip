/**
 * Taro 应用配置 —— 页面注册 + 原生 TabBar
 * ============================================================================
 * - pages 与 nav 抽象层的路由映射一一对应（见 src/nav/index.ts）
 * - tabBar 用「纯文字」五标签，刻意不配 iconPath，避免引入 PNG 资源
 *   （小程序要求 tabBar 图标必须是本地图片，原型期不增加资源维护面；
 *    设计稿中的线性图标待图标资源就位后再补）
 * - 2026-10-13 设计稿改版：tab 顺序 = 总览 / 规划 / 行程 / 物品 / 回忆，
 *   「我的」（ProfilePage）降级为非 tab 页，从总览页头像进入；
 *   新增「回忆墙」MemoryPage 占「回忆」tab
 * - 视觉：米纸底 #F5F0E4 + 深绿主色 #1E5B45（微信 tabBar 上限 5 个）
 */

export default {
  pages: [
    'pages/HomePage',
    'pages/PlanPage',
    'pages/TripsPage',
    'pages/ItemsPage',
    'pages/MemoryPage',
    'pages/ProfilePage',
    'pages/WishPoolPage',
    'pages/TripDetailPage',
    'pages/TripCreatePage',
    'pages/JoinFamilyPage',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#f5f0e4',
    navigationBarTitleText: '家庭出行计划',
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
      { pagePath: 'pages/MemoryPage', text: '回忆' },
    ],
  },
};
