/**
 * 页面外壳 —— 大标题页头（替代原 H5 自绘 AppShell 的 header 部分）
 * ============================================================================
 * 版式对齐 2026-10-13 设计稿：
 *   · 左侧：页面大标题（26px 粗体）+ 副标题（12.5px，尾部带数据源小点）
 *   · 右侧：虚线「手账印章」徽章（2026 / 1 程 / 0 张）+ 圆形图标按钮插槽
 * 底部标签栏由小程序原生 tabBar 承担（见 app.config.ts）。
 * 双端共用，不 fork。H5 下由 Taro 路由渲染为普通页面头部。
 */

import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';

import { DATA_SOURCE } from '../api/index';

export function PageLayout({
  title,
  sub,
  badge,
  actions,
  children,
}: {
  title: string;
  sub?: string;
  /** 右上角虚线徽章文案，如「2026」「1 程」「0 张」 */
  badge?: string;
  /** 右上角徽章左侧的圆形图标按钮（头像 / 加号等） */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="page">
      <View className="page-head">
        <View className="page-head__main">
          <Text className="page-head__title">{title}</Text>
          {sub ? (
            <View className="page-head__sub">
              <Text>{sub}</Text>
              <View className={`badge badge--${DATA_SOURCE}`}>
                <View className="badge__dot" />
                <Text>{DATA_SOURCE === 'mock' ? '示例数据' : '已连后端'}</Text>
              </View>
            </View>
          ) : null}
        </View>
        <View className="page-head__right">
          {actions}
          {badge ? <Text className="stamp">{badge}</Text> : null}
        </View>
      </View>

      <View className="screen">{children}</View>
    </View>
  );
}
