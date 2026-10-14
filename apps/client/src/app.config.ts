/**
 * Taro 应用配置 —— 页面注册 + 原生 TabBar
 * ============================================================================
 * - pages 与 nav 抽象层的路由映射一一对应（见 src/nav/index.ts）
 * - tabBar 用「纯文字」五标签，刻意不配 iconPath，避免引入 PNG 资源
 *   （小程序要求 tabBar 图标必须是本地图片，原型期不增加资源维护面）
 * - M-Client-2：心愿池由 tab 降级为「首页内区块」，tabBar 腾给「物品 / 我的」
 *   （微信 tabBar 硬上限 5 个，6 个会被构建期拒绝）
 */

export default {
  pages: [
    'pages/HomePage',
    'pages/TripsPage',
    'pages/ItemsPage',
    'pages/PlanPage',
    'pages/ProfilePage',
    'pages/WishPoolPage',
    'pages/TripDetailPage',
    'pages/TripCreatePage',
    'pages/JoinFamilyPage',
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: '家庭出行',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f2f4f8',
  },
  tabBar: {
    color: '#98a0b0',
    selectedColor: '#3b7cff',
    backgroundColor: '#ffffff',
    borderStyle: 'black',
    list: [
      { pagePath: 'pages/HomePage', text: '首页' },
      { pagePath: 'pages/TripsPage', text: '行程' },
      { pagePath: 'pages/ItemsPage', text: '物品' },
      { pagePath: 'pages/PlanPage', text: '年度规划' },
      { pagePath: 'pages/ProfilePage', text: '我的' },
    ],
  },
};
