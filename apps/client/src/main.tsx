/**
 * 渲染入口
 * ============================================================================
 * 只负责挂载 React 树；路由表在 `main.tsx` 内定义，避免 App.tsx 混入 router 细节。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles/theme.css';
import { Root } from './Root';

const el = document.getElementById('root');
if (!el) throw new Error('#root 未找到，请检查 index.html');

createRoot(el).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
