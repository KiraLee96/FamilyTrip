/** 共享展示组件与格式化工具 */

import { Icon } from './Icon';
import type { Trip, TripStatus } from '../api/types';

export const STATUS_TEXT: Record<TripStatus, string> = {
  DRAFT: '草稿',
  PLANNED: '已计划',
  ONGOING: '进行中',
  FINISHED: '已完成',
  CANCELLED: '已取消',
};

export function StatusChip({ status }: { status: TripStatus }) {
  return <span className={`status status--${status}`}>{STATUS_TEXT[status]}</span>;
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

/** 星期几 */
export function weekday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()] ?? '';
}

export function Progress({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress__bar">
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress__label">
        <span>{label ?? '准备进度'}</span>
        <span>
          {done}/{total} · {pct}%
        </span>
      </div>
    </div>
  );
}

export function SectionTitle({
  icon,
  children,
}: {
  icon: Parameters<typeof Icon>[0]['name'];
  children: React.ReactNode;
}) {
  return (
    <div className="section-title">
      <span className="section-title__icon">
        <Icon name={icon} size={16} />
      </span>
      {children}
    </div>
  );
}
