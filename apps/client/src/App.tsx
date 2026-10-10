/**
 * 应用外壳 —— 导航栏 + 路由出口 + 底部标签栏
 * ============================================================================
 * 结构：手机容器(375) → 顶部栏 → 滚动区(Outlet) → 底部 TabBar
 * 数据源徽标常驻右上角：mock(橙) / http(绿)，切换后端时一眼可辨。
 */

import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { DATA_SOURCE } from './api/index';
import { Icon, type IconName } from './components/Icon';

interface TabDef {
  to: string;
  label: string;
  icon: IconName;
}

/** 底部四个主入口，对应交互稿 01–04 的四个模块 */
const TABS: TabDef[] = [
  { to: '/', label: '首页', icon: 'home' },
  { to: '/wishes', label: '心愿池', icon: 'sparkles' },
  { to: '/trips', label: '行程', icon: 'route' },
  { to: '/plan', label: '年度规划', icon: 'calendar' },
];

const TITLES: Record<string, { title: string; sub: string }> = {
  '/': { title: '家庭出行', sub: '把想一起去的地方，一件件排上' },
  '/wishes': { title: '心愿池', sub: '全家投票，票高的先安排' },
  '/trips': { title: '行程', sub: '按天看安排，不慌不赶' },
  '/plan': { title: '年度规划', sub: '一年想去哪，提前有个数' },
};

export function AppShell() {
  const { pathname } = useLocation();
  const head = TITLES[pathname] ?? { title: '家庭出行', sub: '' };

  return (
    <div className="phone">
      <header className="navbar">
        <Icon name="map-pin" size={20} className="navbar__icon" />
        <div>
          <div className="navbar__title">{head.title}</div>
          <div className="navbar__sub">{head.sub}</div>
        </div>
        <div className="navbar__spacer" />
        <span className={`badge badge--${DATA_SOURCE}`}>
          <i className="badge__dot" />
          {DATA_SOURCE === 'mock' ? '示例数据' : '已连后端'}
        </span>
      </header>

      <main className="screen">
        <Outlet />
      </main>

      <nav className="tabbar">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === '/'}
            className={({ isActive }) => (isActive ? 'tab tab--on' : 'tab')}
          >
            <Icon name={t.icon} size={21} />
            <span>{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
