/**
 * 登录态管理（A6）—— adapter 无关的会话层
 * ============================================================================
 * 职责：
 *   · 启动时恢复持久化 token（Taro.setStorage，派发单 A6 要求）
 *   · 无 token 时静默登录：小程序走 `Taro.login()` 拿 code；
 *     H5 端 `Taro.login` 是 taro-h5 的暂不支持空实现（temporarilyNotSupport），
 *     故合成一个 code —— 服务端开发桩 stubWechat 接受任意非空 code
 *     （openid = `openid_${code}`），生产接入真实 exchanger 后需另接 H5 登录态
 *   · 登录成功后把 User 广播给界面（useSession 订阅）
 *
 * 🔴 与 ApiClient 契约的边界：
 *     `api.login(code)` 的返回契约为 User（原型接口一字不改）。
 *     token 的存储/清除由 http 实现层在收到 AuthSession 后内部完成，
 *     本模块只做「何时触发登录 / 广播登录态」，不碰接口签名。
 */

import Taro from '@tarojs/taro';
import { api, DATA_SOURCE } from './index';
import { installSessionRecoverer, resetFamilyIdCache, setToken, TOKEN_KEY } from './http';
import type { User } from './types';

const USER_KEY = 'auth_user';

let currentUser: User | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function setUser(u: User | undefined): void {
  currentUser = u;
  emit();
}

/** useSyncExternalStore 订阅入口（见 hooks/useSession.ts） */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUser(): User | undefined {
  return currentUser;
}

/** 取登录 code：小程序 wx.login；H5 合成（Taro.login 在 H5 为暂不支持的空实现） */
async function obtainCode(): Promise<string> {
  if (Taro.getEnv() === Taro.ENV_TYPE.WEB) {
    return `h5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const res = await Taro.login();
  if (!res.code) throw new Error('wx.login 未返回 code');
  return res.code;
}

function persistUser(u: User): void {
  Taro.setStorageSync(USER_KEY, JSON.stringify(u));
}

function clearSession(): void {
  setToken(undefined);
  Taro.removeStorageSync(TOKEN_KEY);
  Taro.removeStorageSync(USER_KEY);
  resetFamilyIdCache();
}

let booting: Promise<void> | undefined;

/**
 * 启动时调用一次（App.tsx useLaunch）。
 * 并发调用复用同一个 Promise；失败不抛——界面按「未登录」降级展示。
 */
export function bootstrapSession(): Promise<void> {
  booting ??= runBootstrap();
  // 幂等：bootstrap 已跑过也重复注入无副作用
  installSessionRecoverer(forceRelogin);
  return booting;
}

/**
 * 401 恢复器（http 层在凭证失效时调用）。
 * 与界面「重新登录」按钮同一套重登逻辑，但失败要抛错——
 * http 层据此放弃重试、把 401 降级给界面，而不是无限重登。
 */
async function forceRelogin(): Promise<void> {
  await retryLogin();
  if (typeof Taro.getStorageSync(TOKEN_KEY) !== 'string') {
    throw new Error('重新登录未获得 token');
  }
}

// 模块装载即注入恢复器：http 层的 401 重试不依赖 bootstrap 的启动时序
// （H5 下页面请求可能早于 App useLaunch 发出，恢复器必须先于请求就位）
installSessionRecoverer(forceRelogin);

async function runBootstrap(): Promise<void> {
  const cached = Taro.getStorageSync(TOKEN_KEY);
  const hasToken = typeof cached === 'string' && cached.length > 0;
  if (hasToken) setToken(cached);

  try {
    if (DATA_SOURCE === 'http' && !hasToken) {
      // 冷启动无 token → 静默登录（微信侧无感）
      const u = await api.login(await obtainCode());
      setUser(u);
      persistUser(u);
      return;
    }
    // mock 模式直接给 ME；http 模式带 token 拉本人资料
    const u = await api.me();
    setUser(u);
    persistUser(u);
  } catch (e) {
    console.warn('[session] 登录态初始化失败：', e);
    if (DATA_SOURCE === 'http' && hasToken) {
      // 旧 token 已失效：清掉后自动重登一次（bootstrap 失败不抛，降级未登录）
      try {
        clearSession();
        const u = await api.login(await obtainCode());
        setUser(u);
        persistUser(u);
        return;
      } catch (e2) {
        console.warn('[session] 重新静默登录失败：', e2);
      }
    }
    if (DATA_SOURCE === 'http') clearSession();
    setUser(undefined);
  }
}

/** 界面「重新登录」按钮：重置启动 Promise 后重跑 */
export function retryLogin(): Promise<void> {
  booting = undefined;
  setUser(undefined);
  return bootstrapSession();
}

/** 登出：清本地会话并重新静默登录（微信生态无显式登出 UI，回到无感态） */
export function logout(): Promise<void> {
  clearSession();
  return retryLogin();
}
