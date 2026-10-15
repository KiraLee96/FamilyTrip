/**
 * 安排正文块渲染器（H5 / 微信小程序同构，单份实现不 fork）
 * ============================================================================
 * 用途：把一条安排（ItineraryItem）的正文渲染成参考截图那样的**混排卡片** ——
 *   段落 / 灰底引用 / 等宽代码 / 外链 / 内嵌图片，顺序与 blocks 数组一致。
 *
 * 数据来源与降级链（与 api/types.ts 的契约注释同源）：
 *   · blocks 由服务端下发（读接口已把 image 块的 assetId 解析成 url，方案 A）；
 *   · 老数据没有 blocks 而只有 note → 这里把 note 当首个 text 段落兜底渲染，
 *     所以「老数据/新数据」在界面上是同一条渲染路径，不需要分支 fork；
 *   · 图片三级降级：localImagePaths（本会话刚上传的本地临时路径，零延迟） >
 *     block.url（真后端持久 URL）> 占位卡（Mock 无 url、或远程图加载失败）。
 *     onError 逐图降级，坏一张不影响其余块。
 *
 * 多端差异只在一处：打开外链。小程序不允许任意 web-view 跳转，
 * 统一「复制链接 + 提示」，H5 额外新开窗口 —— 逻辑不复制两份。
 */

import { useState } from 'react';
import { Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import type { ItineraryBlock } from '../api/types';
import { Icon } from './Icon';

const IS_H5 = process.env.TARO_ENV === 'h5';

export interface ItineraryContentProps {
  /** 正文块（有序；缺省表示老数据，退化为 fallbackText 单段） */
  blocks?: ItineraryBlock[];
  /** 老数据的纯文本备注（无 blocks 时作为首个段落渲染） */
  fallbackText?: string;
  /**
   * 本会话上传图片的本地路径覆盖（assetId → tempFilePath）。
   * 由页面上传成功后回填：Mock/离线环境下 url 为空，靠它即时可见。
   */
  localImagePaths?: Record<string, string>;
}

/** 打开外链：小程序只允许复制，H5 复制 + 新开窗口（失败静默，不打断阅读） */
function openLink(url: string): void {
  void Taro.setClipboardData({ data: url })
    .then(() => Taro.showToast({ title: '链接已复制，可在浏览器打开', icon: 'none' }))
    .catch(() => {
      /* 复制失败不阻断：用户仍可从卡片文本里读出链接 */
    });
  if (IS_H5) {
    window.open(url, '_blank');
  }
}

export function ItineraryContent({ blocks, fallbackText, localImagePaths }: ItineraryContentProps) {
  /** 远程图加载失败的块下标集合 → 降级占位卡（不整卡消失） */
  const [broken, setBroken] = useState<Record<number, boolean>>({});

  const list: ItineraryBlock[] =
    blocks !== undefined && blocks.length > 0
      ? blocks
      : fallbackText !== undefined && fallbackText !== ''
        ? [{ type: 'text', text: fallbackText }]
        : [];

  if (list.length === 0) return null;

  return (
    <View className="blks">
      {list.map((b, idx) => {
        // 块无稳定 id：用「下标 + 类型」作 key —— 数组是整体替换语义，
        // 增删块会重建列表，不会出现错位复用（React 复用的最坏后果只是重渲染）。
        const key = `${idx}-${b.type}`;

        if (b.type === 'quote') {
          return (
            <View className="blk blk--quote" key={key}>
              <Text className="blk__text">{b.text}</Text>
            </View>
          );
        }

        if (b.type === 'code') {
          return (
            <View className="blk blk--code" key={key}>
              <Text className="blk__code-text">{b.text}</Text>
            </View>
          );
        }

        if (b.type === 'link') {
          return (
            <View className="blk blk--link" key={key} onClick={() => openLink(b.url)}>
              <Icon name="link" size={12} />
              <Text className="blk__link-text">{b.text}</Text>
            </View>
          );
        }

        if (b.type === 'image') {
          const src =
            (b.assetId !== undefined ? localImagePaths?.[b.assetId] : undefined) ??
            (broken[idx] === true ? '' : (b.url ?? ''));
          return (
            <View className="blk blk--image" key={key}>
              {src !== '' ? (
                <Image
                  className="blk__img"
                  src={src}
                  mode="widthFix"
                  onError={() => setBroken((m) => (m[idx] === true ? m : { ...m, [idx]: true }))}
                />
              ) : (
                <View className="blk__img-ph">
                  <Icon name="camera" size={22} />
                  <Text className="blk__img-ph-text">图片暂不可显示</Text>
                </View>
              )}
              {b.caption !== undefined && b.caption !== '' && (
                <Text className="blk__cap">{b.caption}</Text>
              )}
            </View>
          );
        }

        return (
          <Text className="blk blk__text" key={key}>
            {b.text}
          </Text>
        );
      })}
    </View>
  );
}

export default ItineraryContent;
