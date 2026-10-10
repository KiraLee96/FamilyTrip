/**
 * 路由根 —— 路由表 + HashRouter
 * ============================================================================
 * 用 HashRouter 而非 BrowserRouter：H5 原型可能被直接双击打开或部署到静态托管，
 * Hash 路由无需服务端 rewrite 即可工作，切 Taro 时也不会有差异。
 */

import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './App';
import { HomePage } from './pages/HomePage';
import { PlanPage } from './pages/PlanPage';
import { TripDetailPage } from './pages/TripDetailPage';
import { TripsPage } from './pages/TripsPage';
import { WishPoolPage } from './pages/WishPoolPage';

export function Root() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<HomePage />} />
          <Route path="wishes" element={<WishPoolPage />} />
          <Route path="trips" element={<TripsPage />} />
          <Route path="trips/:tripId" element={<TripDetailPage />} />
          <Route path="plan" element={<PlanPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
