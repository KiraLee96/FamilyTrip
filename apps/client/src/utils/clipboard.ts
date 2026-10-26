/**
 * 邀请码 / 链接复制 —— H5 / 小程序共用
 * ============================================================================
 * 家庭邀请码与行程邀请码共用同一交互：复制 → toast 反馈。
 * 抽成工具函数而非各页一份实现，避免双份维护（红线 #2 同源原则）。
 *
 * 🔴 2026-10-26 修复「复制显示失败」：
 *    原实现只有一条路 —— `Taro.setClipboardData().catch(→ 提示复制失败)`。
 *    实际有两种必然失败的场景：
 *      ① H5 非安全上下文（http://192.168.x.x:端口 这类内网预览的标准形态）：
 *         `navigator.clipboard` 为 undefined，Taro 直接 reject；
 *      ② 小程序侧偶发 `setClipboardData:fail`（权限 / 时序 / 开发者工具）。
 *    两者都会让用户看到「复制失败，请手动记录」，而界面上根本没有可复制的文本
 *    —— 反馈里的「复制显示失败」正是这条。
 *
 *    现在改成三档降级：
 *      1. 小程序 → `Taro.setClipboardData`（唯一正规通道）
 *      2. H5 安全上下文 → `navigator.clipboard.writeText`
 *      3. H5 非安全上下文 → 隐藏 textarea + `document.execCommand('copy')`
 *    全失败时不再干巴巴报错，而是把内容弹出来让人手动长按复制（信息不丢）。
 */

import Taro from '@tarojs/taro';

/** 编译期常量：用于双端分流（与项目其它地方的 IS_WEAPP 同口径） */
const IS_WEAPP = process.env.TARO_ENV === 'weapp';

/** 小程序侧复制：唯一正规通道，失败即返回 false 由上层降级 */
async function copyByTaro(text: string): Promise<boolean> {
  try {
    await Taro.setClipboardData({ data: text });
    return true;
  } catch {
    return false;
  }
}

/** H5 侧复制：安全上下文用 async clipboard，退化用 execCommand */
async function copyByWeb(text: string): Promise<boolean> {
  if (typeof document === 'undefined') return false;

  // ① 安全上下文（https / localhost）：首选异步剪贴板 API
  const clipboard = document.defaultView?.navigator.clipboard;
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 落到 ②：部分浏览器在缺少用户手势时会 reject
    }
  }

  // ② 非安全上下文兜底：隐藏 textarea + execCommand（老 API 但兼容面最广）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 固定定位到视口外，避免页面滚动；只读避免呼出键盘
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 兜底：把待复制内容弹出来，让用户手动选中复制。
 * 比「复制失败，请手动记录」有用得多 —— 后者连内容都不给人看。
 */
function showManualCopy(text: string, title = '请手动复制'): void {
  void Taro.showModal({ title, content: text, confirmText: '知道了', showCancel: false });
}

/**
 * 复制文本到剪贴板。
 * @returns 是否复制成功（调用方一般忽略；失败时会自动弹出手动复制框）
 */
export async function copyText(text: string, okMessage = '已复制'): Promise<boolean> {
  const value = text.trim();
  if (value === '') return false;

  const ok = IS_WEAPP ? await copyByTaro(value) : await copyByWeb(value);
  if (ok) {
    void Taro.showToast({ title: okMessage, icon: 'none' });
    return true;
  }
  showManualCopy(value);
  return false;
}

/**
 * 生成「凭邀请码加入」的可分发链接（仅 H5 有意义）。
 * ============================================================================
 * 小程序里分享走原生转发卡片（path 由 useShareAppMessage 给出），没有 URL 概念；
 * H5 里没有转发面板，只能给一条可粘贴的链接 —— 这是「分享之后无效」在 Web 端
 * 的正解（原先那个 `openType="share"` 的按钮在 H5 下点了完全没反应）。
 *
 * @param code 邀请码
 * @param target family = 加入家庭（JoinFamilyPage）；trip = 加入行程（JoinTripPage）
 *
 * 路由形态两种都覆盖：Taro H5 默认 hash 路由（#/pages/...），
 * 若将来切 browser 路由，则退化成 /pages/... 直链。
 */
export function buildJoinLink(code: string, target: 'family' | 'trip' = 'family'): string {
  const invite = encodeURIComponent(code.trim().toUpperCase());
  const page = target === 'family' ? 'JoinFamilyPage' : 'JoinTripPage';
  if (typeof window === 'undefined') return `/pages/${page}?invite=${invite}`;
  const { origin, pathname, hash } = window.location;
  // hash 为空或已带 #/ → hash 路由；pathname 里已含 /pages/ → browser 路由
  const hashRouting = hash.startsWith('#/') || !pathname.includes('/pages/');
  return hashRouting
    ? `${origin}${pathname}#/pages/${page}?invite=${invite}`
    : `${origin}/pages/${page}?invite=${invite}`;
}
