/**
 * 线性图标 —— 纯 path 绘制，不依赖任何图标库
 * ============================================================================
 * 理由：小程序包体积敏感，且原型期引入图标库会额外增加一套依赖与维护面。
 * 这里统一 24×24 viewBox、2px 描边、取 currentColor，保证与文字同色可控。
 */

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

const PATHS: Record<IconName, string> = {
  home: 'M3 10.2 12 3l9 7.2M5.4 9.4V20h13.2V9.4M9.6 20v-5.4h4.8V20',
  sparkles:
    'M12 3.2l1.7 4.3 4.3 1.7-4.3 1.7L12 15.2l-1.7-4.3L6 9.2l4.3-1.7zM18.6 15.2l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  route:
    'M6.5 4.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zM17.5 15.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6zM6.5 8.8v4.4a3.4 3.4 0 0 0 3.4 3.4h5',
  calendar: 'M4.2 6.4h15.6v13.4H4.2zM4.2 10.4h15.6M8.4 3.6v4M15.6 3.6v4',
  'chevron-right': 'M9.5 5.5 16 12l-6.5 6.5',
  'map-pin': 'M12 21.2s6.4-5.6 6.4-10.4A6.4 6.4 0 0 0 5.6 10.8C5.6 15.6 12 21.2 12 21.2z',
  heart:
    'M12 20.3s-7.4-4.6-7.4-9.6a4.2 4.2 0 0 1 7.4-2.8 4.2 4.2 0 0 1 7.4 2.8c0 5-7.4 9.6-7.4 9.6z',
  check: 'M5 12.6 9.6 17 19 6.8',
  circle: 'M12 4.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2z',
  plus: 'M12 5.2v13.6M5.2 12h13.6',
  user: 'M12 3.6a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6zM4.6 20.4a7.4 7.4 0 0 1 14.8 0',
  clock: 'M12 4.4a7.6 7.6 0 1 1 0 15.2 7.6 7.6 0 0 1 0-15.2zM12 7.8v4.6l3.1 1.9',
  wallet: 'M4.2 7.4h15.6v11.2H4.2zM4.2 7.4l1.4-2.8h12.2l1.4 2.8M15.4 13h2.8',
};

export interface IconProps {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function Icon({ name, size = 22, strokeWidth = 1.9, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
