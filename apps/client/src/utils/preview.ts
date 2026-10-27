/**
 * 图片全屏预览（多端同构）
 * ============================================================================
 * 抽出来的原因：回忆墙与行程「照片」tab 是两处入口、同一种诉求 ——
 * 「点一下能看大图，还能左右滑着看」。写两遍必然会漂移（一处能滑一处只能看单张）。
 *
 * 多端差异由 Taro 抹平：
 *   · 小程序端 → `wx.previewImage` 原生图片预览层
 *   · H5 端     → Taro 映射成浏览器图片预览
 * 两端的入参语义一致（`urls` 全集 + `current` 当前项），故视图层无需判断环境。
 *
 * 边界：空地址一律过滤。列表里混着空串（未拿到持久 URL 的资产）时，
 * 不过滤会让预览层出现一张点不开的白图。
 */

import Taro from '@tarojs/taro';

/** 点开某张图的全屏预览；无可预览地址时静默返回（不弹空预览层） */
export function previewPhotos(urls: string[], current: string): void {
  const list = urls.filter((u) => typeof u === 'string' && u !== '');
  if (current === '' || list.length === 0) return;
  void Taro.previewImage({ urls: list, current });
}
