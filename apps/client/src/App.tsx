/**
 * Taro 应用入口 —— 替代原 Vite 的 main.tsx / HashRouter
 * ============================================================================
 * 只做两件事：挂载启动钩子、引入全局样式。
 * 页面与路由由 Taro 根据 app.config.ts 的 pages / tabBar 自动装配，
 * 不再需要 react-router 与手动 <HashRouter>。
 */

import type { PropsWithChildren } from 'react';
import { useLaunch } from '@tarojs/taro';

import './styles/theme.css';

export default function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 小程序启动钩子；H5 下为空实现，不影响渲染
  });

  // children 由 Taro 注入（当前页面），原样返回即可
  return children;
}
