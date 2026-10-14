/** 共享展示组件与格式化工具（Taro 同构版：View/Text 替代 div/span） */

import type { ReactNode } from 'react';
import { Text, View } from '@tarojs/components';

import { Icon, type IconName } from './Icon';
import type { Trip, TripStatus, Wish } from '../api/types';

export const STATUS_TEXT: Record<TripStatus, string> = {
  DRAFT: '草稿',
  PLANNED: '已计划',
  ONGOING: '进行中',
  FINISHED: '已完成',
  CANCELLED: '已取消',
};

export function StatusChip({ status }: { status: TripStatus }) {
  return <Text className={`status status--${status}`}>{STATUS_TEXT[status]}</Text>;
}

/** 2026-10-01 → 10/01 */
export function shortDate(d?: string | null): string {
  if (!d) return '待定';
  const [, m, day] = d.split('-');
  return m && day ? `${m}/${day}` : d;
}

/** 出行日期区间文案 */
export function dateRange(t: Trip): string {
  if (!t.startDate && !t.endDate) return '日期待定';
  const days = tripDays(t);
  const base = `${shortDate(t.startDate)} - ${shortDate(t.endDate)}`;
  return days > 0 ? `${base} · ${days} 天` : base;
}

/** 含头含尾天数 */
export function tripDays(t: Trip): number {
  if (!t.startDate || !t.endDate) return 0;
  const a = Date.parse(`${t.startDate}T00:00:00Z`);
  const b = Date.parse(`${t.endDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

/** 距出发日还有几天（当天=0；已出发为负；无日期返回 null） */
export function daysUntil(d?: string | null): number | null {
  if (!d) return null;
  const today = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const a = Date.parse(`${todayStr}T00:00:00Z`);
  const b = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** 月份标签（1 → 1月） */
export const MONTH_LABELS: string[] = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);

/** 心愿状态文案 */
export const WISH_STATUS_TEXT: Record<Wish['status'], string> = {
  OPEN: '待规划',
  ADOPTED: '已安排',
  ARCHIVED: '已归档',
};

/** 星期几 */
export function weekday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()] ?? '';
}

export function Progress({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <View className="progress">
      <View className="progress__bar">
        <View className="progress__fill" style={{ width: `${pct}%` }} />
      </View>
      <View className="progress__label">
        <Text>{label ?? '准备进度'}</Text>
        <Text>
          {done}/{total} · {pct}%
        </Text>
      </View>
    </View>
  );
}

export function SectionTitle({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <View className="section-title">
      <Text className="section-title__icon">
        <Icon name={icon} size={16} />
      </Text>
      {children}
    </View>
  );
}
