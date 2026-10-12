/**
 * Taro 应用配置 —— 页面注册 + 原生 TabBar
 * ============================================================================
 * - pages 与 nav 抽象层的路由映射一一对应（见 src/nav/index.ts）
 * - tabBar 用「纯文字」四标签，刻意不配 iconPath，避免引入 PNG 资源
 *   （小程序要求 tabBar 图标必须是本地图片，原型期不增加资源维护面）
 */

export default {
  pages: [
    'pages/HomePage',
    'pages/WishPoolPage',
    'pages/TripsPage',
    'pages/TripDetailPage',
    'pages/PlanPage',
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
      { pagePath: 'pages/WishPoolPage', text: '心愿池' },
      { pagePath: 'pages/TripsPage', text: '行程' },
      { pagePath: 'pages/PlanPage', text: '年度规划' },
    ],
  },
};
