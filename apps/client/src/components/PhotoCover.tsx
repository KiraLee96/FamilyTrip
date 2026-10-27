/**
 * 回忆组封面（回忆墙 / 首页「最近回忆」共用）
 * ============================================================================
 * 为什么抽出来：两处都是「有封面就铺满、没有就占位」，直接写 `<Image src>` 时
 * **URL 打不开就是一个浏览器破图小图标**（Chrome 那个小方块），看起来像页面坏了。
 * 回忆墙是"照片归档"的地方，一张破图比空占位更让人怀疑"照片丢了"。
 *
 * 语义：
 *   · url 为空         → 灰底 + 图标（尚未有封面）
 *   · url 有值但加载失败 → 灰底 + 图标 + 不打扰的提示（加载失败）
 *   · 正常             → 铺满
 */

import { useState } from 'react';
import { Image, Text, View } from '@tarojs/components';

export function PhotoCover({
  url,
  className = 'memo-card__cover',
  emptyClassName = 'memo-card__cover memo-card__cover--empty',
}: {
  url: string;
  /** 铺满用的 class（默认对齐 memo-card 的封面） */
  className?: string;
  /** 占位用的 class */
  emptyClassName?: string;
}) {
  const [broken, setBroken] = useState(false);

  if (url === '' || broken) {
    return (
      <View className={emptyClassName}>
        <Text style={{ fontSize: 22 }}>{url === '' ? '🖼️' : '⚠️'}</Text>
      </View>
    );
  }

  return (
    <Image className={className} src={url} mode="aspectFill" onError={() => setBroken(true)} />
  );
}
