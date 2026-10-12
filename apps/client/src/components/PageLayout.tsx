/**
 * 页面外壳 —— 顶部标题栏（替代原 H5 自绘 AppShell 的 header 部分）
 * ============================================================================
 * 底部标签栏已交给小程序原生 tabBar（见 app.config.ts），这里只负责：
 *   · 顶部标题 + 副标题
 *   · 右上角数据源徽标（mock 橙 / http 绿），一眼区分当前数据来源
 *   · 内容滚动容器
 * 双端共用，不 fork。H5 下由 Taro 路由渲染为普通页面头部。
 */

import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';

import { DATA_SOURCE } from '../api/index';

export function PageLayout({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <View className="page">
      <View className="navbar">
        <View className="navbar__main">
          <Text className="navbar__title">{title}</Text>
          {sub ? <Text className="navbar__sub">{sub}</Text> : null}
        </View>
        <View className="navbar__spacer" />
        <View className={`badge badge--${DATA_SOURCE}`}>
          <View className="badge__dot" />
          <Text>{DATA_SOURCE === 'mock' ? '示例数据' : '已连后端'}</Text>
        </View>
      </View>

      <View className="screen">{children}</View>
    </View>
  );
}
