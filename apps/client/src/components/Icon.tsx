/**
 * 图标 —— 用 emoji 替代内联 SVG
 * ============================================================================
 * 小程序不支持内联 <svg>，且引入图标库会增加包体积与维护面。
 * 原型期用 Unicode emoji 渲染（H5 / 小程序双端一致），后续要更精致的线性图标
 * 再换成 Taro <Image> + 字体图标或 PNG 资源。
 */

import { Text } from '@tarojs/components';

export type IconName =
  | 'home'
  | 'sparkles'
  | 'route'
  | 'calendar'
  | 'chevron-right'
  | 'map-pin'
  | 'heart'
  | 'check'
  | 'circle'
  | 'plus'
  | 'user'
  | 'clock'
  | 'wallet';

const GLYPH: Record<IconName, string> = {
  home: '🏠',
  sparkles: '✨',
  route: '🧭',
  calendar: '📅',
  'chevron-right': '›',
  'map-pin': '📍',
  heart: '❤️',
  check: '✓',
  circle: '○',
  plus: '＋',
  user: '👤',
  clock: '🕐',
  wallet: '💰',
};

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 22, className }: IconProps) {
  return (
    <Text className={className} style={{ fontSize: `${size}px`, lineHeight: `${size}px` }}>
      {GLYPH[name]}
    </Text>
  );
}
