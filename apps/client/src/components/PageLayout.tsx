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
              {/*
                数据源标记只在 Mock 模式下出现（「示例数据」）。
                真后端不再挂「已连后端」—— 用户反馈那是调试信息，进生产界面里属于噪声，
                而且会让用户以为「连上了才是正常的」。（2026-10-22）
              */}
              {DATA_SOURCE === 'mock' && (
                <View className="badge badge--mock">
                  <View className="badge__dot" />
                  <Text>示例数据</Text>
                </View>
              )}
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
