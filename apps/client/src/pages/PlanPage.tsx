/**
 * 年度规划 —— 全年出行总览
 * ============================================================================
 * 把「已完成 / 已计划 / 草稿」按季度归位，回答一个很实际的问题：
 * 「这一年我们打算去哪儿、去了哪儿、花了多少天」。
 * 数据全部由 /trips 聚合得出，不额外依赖后端接口，避免原型期加接口。
 */

import { useCallback } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/index';
import type { Trip } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { StatusChip, shortDate, tripDays } from '../components/shared';
import { useAsync } from '../hooks/useAsync';

const QUARTERS = [
  { q: 1, months: [1, 2, 3], label: '第一季度', season: '春' },
  { q: 2, months: [4, 5, 6], label: '第二季度', season: '夏' },
  { q: 3, months: [7, 8, 9], label: '第三季度', season: '秋' },
  { q: 4, months: [10, 11, 12], label: '第四季度', season: '冬' },
];

export function PlanPage() {
  const q = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = q.data ?? [];
  if (list.length === 0) return <Empty text="还没有数据，先去建一个行程" />;

  const year = new Date().getFullYear();
  const finished = list.filter((t) => t.status === 'FINISHED');
  const planned = list.filter((t) => t.status === 'PLANNED' || t.status === 'ONGOING');
  const totalDays = list.reduce((n, t) => n + tripDays(t), 0);
  const places = new Set(list.flatMap((t) => (t.destinations ?? []).map((d) => d.name))).size;

  return (
    <>
      <div className="year__hero">
        <div className="year__n">{year}</div>
        <div className="year__cap">全家的出行年度</div>
        <div className="year__stats">
          <div className="year__stat">
            <b>{list.length}</b>
            <span>个行程</span>
          </div>
          <div className="year__stat">
            <b>{finished.length}</b>
            <span>已完成</span>
          </div>
          <div className="year__stat">
            <b>{places}</b>
            <span>个目的地</span>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>全年在路上</div>
            <div className="muted" style={{ marginTop: 2 }}>
              已计划 {planned.length} 个 · 合计 {totalDays} 天
            </div>
          </div>
          <Icon name="route" size={22} />
        </div>
      </div>

      <div className="card">
        {QUARTERS.map(({ q: n, months, label, season }) => {
          const items = list.filter((t) => {
            const d = t.startDate;
            if (!d) return false;
            const m = Number(d.slice(5, 7));
            return months.includes(m);
          });
          return (
            <div className="q" key={n}>
              <div className="q__no">{n}</div>
              <div className="q__body">
                <div className="q__label">
                  {label}
                  <span className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                    {season}
                  </span>
                </div>
                {items.length === 0 ? (
                  <div className="muted" style={{ marginTop: 5 }}>
                    暂无安排
                  </div>
                ) : (
                  <div className="q__trips">
                    {items.map((t) => (
                      <TripPill key={t.id} trip={t} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
        按出发月份归入季度；未定日期的行程暂不显示
      </p>
    </>
  );
}

function TripPill({ trip }: { trip: Trip }) {
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="chip"
      style={{ height: 30, padding: '0 10px', textDecoration: 'none' }}
    >
      {shortDate(trip.startDate)} {trip.title}
      <StatusChip status={trip.status} />
    </Link>
  );
}
