/**
 * 邀请码复制 —— H5 / 小程序共用（Taro API 双端可用）
 * ============================================================================
 * 家庭邀请码与行程邀请码共用同一交互：复制 → toast 反馈。
 * 抽成工具函数而非各页一份实现，避免双份维护（红线 #2 同源原则）。
 */

import Taro from '@tarojs/taro';

/** 复制文本到剪贴板并toast 反馈；失败提示手动记录 */
export function copyText(text: string, okMessage = '已复制'): void {
  void Taro.setClipboardData({ data: text })
    .then(() => {
      void Taro.showToast({ title: okMessage, icon: 'none' });
    })
    .catch(() => {
      void Taro.showToast({ title: '复制失败，请手动记录', icon: 'none' });
    });
}
