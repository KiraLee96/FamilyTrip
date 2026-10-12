/**
 * 年度规划 —— 全年出行总览（Taro 同构版）
 * ============================================================================
 * 把「已完成 / 已计划 / 草稿」按季度归位。
 * 数据全部由 /trips 聚合得出，不额外依赖后端接口。
 */

import { useCallback } from 'react';
import { Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';

import { api } from '../api/index';
import type { Trip } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
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
    <PageLayout title="年度规划" sub="一年想去哪，提前有个数">
      <View className="year__hero">
        <Text className="year__n">{year}</Text>
        <Text className="year__cap">全家的出行年度</Text>
        <View className="year__stats">
          <View className="year__stat">
            <Text style={{ fontSize: 19, fontWeight: 700, display: 'block' }}>{list.length}</Text>
            <Text style={{ fontSize: 11, opacity: 0.9 }}>个行程</Text>
          </View>
          <View className="year__stat">
            <Text style={{ fontSize: 19, fontWeight: 700, display: 'block' }}>
              {finished.length}
            </Text>
            <Text style={{ fontSize: 11, opacity: 0.9 }}>已完成</Text>
          </View>
          <View className="year__stat">
            <Text style={{ fontSize: 19, fontWeight: 700, display: 'block' }}>{places}</Text>
            <Text style={{ fontSize: 11, opacity: 0.9 }}>个目的地</Text>
          </View>
        </View>
      </View>

      <View className="card">
        <View className="row-between">
          <View>
            <Text style={{ fontSize: 13.5, fontWeight: 600 }}>全年在路上</Text>
            <Text className="muted" style={{ marginTop: 2 }}>
              已计划 {planned.length} 个 · 合计 {totalDays} 天
            </Text>
          </View>
          <Icon name="route" size={22} />
        </View>
      </View>

      <View className="card">
        {QUARTERS.map(({ q: n, months, label, season }) => {
          const items = list.filter((t) => {
            const d = t.startDate;
            if (!d) return false;
            const m = Number(d.slice(5, 7));
            return months.includes(m);
          });
          return (
            <View className="q" key={n}>
              <Text className="q__no">{n}</Text>
              <View className="q__body">
                <View className="q__label">
                  {label}
                  <Text className="muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                    {season}
                  </Text>
                </View>
                {items.length === 0 ? (
                  <Text className="muted" style={{ marginTop: 5 }}>
                    暂无安排
                  </Text>
                ) : (
                  <View className="q__trips">
                    {items.map((t) => (
                      <TripPill key={t.id} trip={t} />
                    ))}
                  </View>
                )}
              </View>
            </View>
          );
        })}
      </View>

      <Text className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
        按出发月份归入季度；未定日期的行程暂不显示
      </Text>
    </PageLayout>
  );
}

function TripPill({ trip }: { trip: Trip }) {
  return (
    <Link to={`/trips/${trip.id}`} className="chip">
      <Text>
        {shortDate(trip.startDate)} {trip.title}
      </Text>
      <StatusChip status={trip.status} />
    </Link>
  );
}

export default PlanPage;
