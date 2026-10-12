/**
 * Taro 应用入口 —— 替代原 Vite 的 main.tsx / HashRouter
 * ============================================================================
 * 只做两件事：挂载启动钩子、引入全局样式。
 * 页面与路由由 Taro 根据 app.config.ts 的 pages / tabBar 自动装配，
 * 不再需要 react-router 与手动 <HashRouter>。
 */

import type { PropsWithChildren } from 'react';
import { useLaunch } from '@tarojs/taro';

import { bootstrapSession } from './api/session';
import './styles/theme.css';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // A6：启动即恢复/建立登录态。失败不阻塞渲染（内部降级为未登录）
    void bootstrapSession();
  });

  // children 由 Taro 注入（当前页面），原样返回即可
  return children;
}
