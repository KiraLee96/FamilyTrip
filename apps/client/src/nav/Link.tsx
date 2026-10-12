/**
 * Link —— 替代 react-router 的 <Link>，双端共用
 * ============================================================================
 * 渲染为 Taro <View>，点击时走 nav 抽象层的 navigate(to)。
 * 这样页面里写 <Link to="/trips/101"> 在 H5 与小程序行为一致，无需 fork。
 */

import type { CSSProperties, ReactNode } from 'react';
import { View } from '@tarojs/components';

import { navigate } from './index';

export interface LinkProps {
  to: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onClick?: () => void;
}

export function Link({ to, className, style, children, onClick }: LinkProps) {
  return (
    <View
      className={className}
      style={style}
      onClick={() => {
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </View>
  );
}
