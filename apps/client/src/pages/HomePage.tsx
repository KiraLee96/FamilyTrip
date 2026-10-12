/**
 * 首页 —— 当前主出行 + 备选行程 + 待办提醒（Taro 同构版）
 * ============================================================================
 * 信息优先级：正在筹备的出行放最上面，做成「主卡」；
 * 其余行程收成紧凑列表；清单未完成项当作提醒露出。
 */

import { useCallback } from 'react';
import { Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';

import { api } from '../api/index';
import type { ChecklistItem, Trip } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
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
    <PageLayout title="家庭出行" sub="把想一起去的地方，一件件排上">
      <SectionTitle icon="route">正在进行</SectionTitle>
      <Link to={`/trips/${primary.id}`} className="trip">
        <View className="trip__top">
          <View style={{ flex: 1 }}>
            <Text className="trip__title">{primary.title}</Text>
            <View className="trip__meta">
              <Text>
                <Icon name="calendar" size={14} />
                {dateRange(primary)}
              </Text>
            </View>
          </View>
          <StatusChip status={primary.status} />
        </View>

        {(primary.destinations ?? []).length > 0 && (
          <View className="trip__dest">
            {(primary.destinations ?? []).map((d) => (
              <Text key={d.name} className="chip">
                <Icon name="map-pin" size={12} />
                {d.name}
              </Text>
            ))}
          </View>
        )}

        <Progress done={shared.length - todo.length} total={shared.length} />
      </Link>

      {todo.length > 0 && (
        <>
          <SectionTitle icon="check">还需要办（{todo.length}）</SectionTitle>
          <View className="card card--flush">
            {todo.slice(0, 3).map((c) => (
              <View key={c.id} className="check" style={{ cursor: 'default' }}>
                <Text className="check__box">
                  <Icon name="circle" size={19} />
                </Text>
                <Text className="check__text">{c.title}</Text>
                {c.assigneeName && <Text className="check__who">{c.assigneeName}</Text>}
              </View>
            ))}
          </View>
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

      <View style={{ marginTop: 4 }}>
        <Link to="/trips" className="btn btn--ghost btn--block">
          查看全部行程
        </Link>
      </View>
    </PageLayout>
  );
}

function MiniTrip({ trip }: { trip: Trip }) {
  const dest = (trip.destinations ?? []).map((d) => d.name).join(' · ');
  return (
    <Link to={`/trips/${trip.id}`} className="card row-between">
      <View style={{ minWidth: 0 }}>
        <Text style={{ fontSize: 14.5, fontWeight: 550 }}>{trip.title}</Text>
        <Text className="muted" style={{ marginTop: 3 }}>
          {shortDate(trip.startDate)} - {shortDate(trip.endDate)}
          {dest ? ` · ${dest}` : ''}
        </Text>
      </View>
      <StatusChip status={trip.status} />
    </Link>
  );
}

/** 供他处复用：统计清单完成情况 */
export function countDone(items: ChecklistItem[]): number {
  return items.filter((c) => c.done).length;
}

export default HomePage;
