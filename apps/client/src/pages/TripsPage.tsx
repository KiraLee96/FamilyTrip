/**
 * 行程列表 —— 按状态分组
 * ============================================================================
 * 分组顺序刻意按「用户关心程度」排：进行中 → 已计划 → 草稿 → 已完成/已取消。
 * 已完成沉底，符合旅行类应用惯例。
 */

import { useCallback } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/index';
import type { Trip, TripStatus } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { Progress, SectionTitle, StatusChip, dateRange, tripDays } from '../components/shared';
import { useAsync } from '../hooks/useAsync';

const ORDER: TripStatus[] = ['ONGOING', 'PLANNED', 'DRAFT', 'FINISHED', 'CANCELLED'];
const GROUP_LABEL: Record<TripStatus, string> = {
  ONGOING: '进行中',
  PLANNED: '已计划',
  DRAFT: '草稿',
  FINISHED: '已完成',
  CANCELLED: '已取消',
};

export function TripsPage() {
  const q = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = q.data ?? [];
  if (list.length === 0) return <Empty text="还没有行程，去心愿池挑一个吧" />;

  return (
    <>
      {ORDER.map((st) => {
        const group = list.filter((t) => t.status === st);
        if (group.length === 0) return null;
        return (
          <div key={st}>
            <SectionTitle icon="route">
              {GROUP_LABEL[st]}（{group.length}）
            </SectionTitle>
            {group.map((t) => (
              <TripCard key={t.id} trip={t} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const dests = trip.destinations ?? [];
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="card"
      style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
    >
      <div className="trip__top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="trip__title" style={{ fontSize: 16 }}>
            {trip.title}
          </div>
          <div className="trip__meta">
            <span>
              <Icon name="calendar" size={14} />
              {dateRange(trip)}
            </span>
            {dests.length > 0 && (
              <span>
                <Icon name="map-pin" size={14} />
                {dests.length} 个目的地
              </span>
            )}
          </div>
        </div>
        <StatusChip status={trip.status} />
      </div>

      {dests.length > 0 && (
        <div className="trip__dest">
          {dests.map((d) => (
            <span key={d.name} className="chip chip--plain">
              {d.name}
            </span>
          ))}
        </div>
      )}

      {trip.status === 'PLANNED' || trip.status === 'ONGOING' ? (
        <Progress done={tripDays(trip)} total={tripDays(trip)} label="行程天数" />
      ) : null}
    </Link>
  );
}
