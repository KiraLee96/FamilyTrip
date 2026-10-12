/**
 * 登录态 hook（A6）
 * ============================================================================
 * 订阅 api/session.ts 的广播：bootstrap / 重新登录 / 登出后自动重渲染。
 * 用 useSyncExternalStore 保证并发渲染下快照一致（React 18）。
 */

import { useSyncExternalStore } from 'react';
import { getUser, subscribe } from '../api/session';
import type { User } from '../api/types';

export function useSession(): User | undefined {
  return useSyncExternalStore(subscribe, getUser, getUser);
}
