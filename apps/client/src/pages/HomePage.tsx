/**
 * 首页 —— 当前主出行 + 备选行程 + 待办提醒
 * ============================================================================
 * 信息优先级：正在筹备的出行放最上面，做成「主卡」；
 * 其余行程收成紧凑列表；清单未完成项当作提醒露出，让首页有「事要做」的感觉。
 */

import { useCallback } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/index';
import type { ChecklistItem, Trip } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { Progress, SectionTitle, StatusChip, dateRange, shortDate } from '../components/shared';
import { useAsync } from '../hooks/useAsync';

export function HomePage() {
  const trips = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );
  const checks = useAsync(
    useCallback(() => api.listChecklist('SHARED'), []),
    [],
  );

  if (trips.loading) return <Loading />;
  if (trips.error) return <ErrorBox message={trips.error} onRetry={trips.reload} />;

  const list = trips.data ?? [];
  if (list.length === 0) return <Empty text="还没有出行计划，先去心愿池挑一个吧" />;

  // 主卡：优先「进行中」，其次「已计划」，最后取第一条
  const primary =
    list.find((t) => t.status === 'ONGOING') ??
    list.find((t) => t.status === 'PLANNED') ??
    list[0]!;
  const others = list.filter((t) => t.id !== primary.id);

  const shared = checks.data ?? [];
  const todo = shared.filter((c) => !c.done);

  return (
    <>
      <SectionTitle icon="route">正在进行</SectionTitle>
      <Link
        to={`/trips/${primary.id}`}
        className="trip"
        style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}
      >
        <div className="trip__top">
          <div style={{ flex: 1 }}>
            <div className="trip__title">{primary.title}</div>
            <div className="trip__meta">
              <span>
                <Icon name="calendar" size={14} />
                {dateRange(primary)}
              </span>
            </div>
          </div>
          <StatusChip status={primary.status} />
        </div>

        {(primary.destinations ?? []).length > 0 && (
          <div className="trip__dest">
            {(primary.destinations ?? []).map((d) => (
              <span key={d.name} className="chip">
                <Icon name="map-pin" size={12} />
                {d.name}
              </span>
            ))}
          </div>
        )}

        <Progress done={shared.length - todo.length} total={shared.length} />
      </Link>

      {todo.length > 0 && (
        <>
          <SectionTitle icon="check">还需要办（{todo.length}）</SectionTitle>
          <div className="card card--flush">
            {todo.slice(0, 3).map((c) => (
              <div key={c.id} className="check" style={{ cursor: 'default' }}>
                <span className="check__box">
                  <Icon name="circle" size={19} />
                </span>
                <span className="check__text">{c.title}</span>
                {c.assigneeName && <span className="check__who">{c.assigneeName}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {others.length > 0 && (
        <>
          <SectionTitle icon="calendar">其他行程</SectionTitle>
          {others.map((t) => (
            <MiniTrip key={t.id} trip={t} />
          ))}
        </>
      )}

      <div style={{ marginTop: 4 }}>
        <Link to="/trips" className="btn btn--ghost btn--block">
          查看全部行程
        </Link>
      </div>
    </>
  );
}

function MiniTrip({ trip }: { trip: Trip }) {
  const dest = (trip.destinations ?? []).map((d) => d.name).join(' · ');
  return (
    <Link
      to={`/trips/${trip.id}`}
      className="card row-between"
      style={{ color: 'inherit', textDecoration: 'none', padding: '13px 14px' }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 550 }}>{trip.title}</div>
        <div className="muted" style={{ marginTop: 3 }}>
          {shortDate(trip.startDate)} - {shortDate(trip.endDate)}
          {dest ? ` · ${dest}` : ''}
        </div>
      </div>
      <StatusChip status={trip.status} />
    </Link>
  );
}

/** 供他处复用：统计清单完成情况 */
export function countDone(items: ChecklistItem[]): number {
  return items.filter((c) => c.done).length;
}
