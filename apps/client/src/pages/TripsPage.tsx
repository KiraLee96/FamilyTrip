/**
 * 行程列表 —— 按状态分组（Taro 同构版）
 * ============================================================================
 * 分组顺序：进行中 → 已计划 → 草稿 → 已完成/已取消。已完成沉底。
 */

import { useCallback } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { navigate } from '../nav';

import { api } from '../api/index';
import type { Trip, TripStatus } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
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

  // tab 页驻留缓存：从详情页返回时不会自动重拉，用 useDidShow 刷新
  // （H5 端对应页面重新显示，小程序端对应 onShow，双端语义一致）
  Taro.useDidShow(() => {
    q.reload();
  });

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = q.data ?? [];

  return (
    <PageLayout title="行程" sub="按天看安排，不慌不赶">
      <CreateTripButton />
      {list.length === 0 ? (
        <Empty text="还没有行程，从新建开始吧" />
      ) : (
        <>
          {ORDER.map((st) => {
            const group = list.filter((t) => t.status === st);
            if (group.length === 0) return null;
            return (
              <View key={st}>
                <SectionTitle icon="route">
                  {GROUP_LABEL[st]}（{group.length}）
                </SectionTitle>
                {group.map((t) => (
                  <TripCard key={t.id} trip={t} />
                ))}
              </View>
            );
          })}
        </>
      )}
    </PageLayout>
  );
}

/** 新建行程入口：空态/非空态都显示，跳 TripCreatePage */
function CreateTripButton() {
  return (
    <View className="add-bar" onClick={() => navigate('/trips/new')}>
      <Icon name="plus" size={16} />
      <Text className="add-bar__text">新建行程</Text>
    </View>
  );
}

function TripCard({ trip }: { trip: Trip }) {
  const dests = trip.destinations ?? [];
  return (
    <Link to={`/trips/${trip.id}`} className="card">
      <View className="trip__top">
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text className="trip__title" style={{ fontSize: 16 }}>
            {trip.title}
          </Text>
          <View className="trip__meta">
            <Text>
              <Icon name="calendar" size={14} />
              {dateRange(trip)}
            </Text>
            {dests.length > 0 && (
              <Text>
                <Icon name="map-pin" size={14} />
                {dests.length} 个目的地
              </Text>
            )}
          </View>
        </View>
        <StatusChip status={trip.status} />
      </View>

      {dests.length > 0 && (
        <View className="trip__dest">
          {dests.map((d) => (
            <Text key={d.name} className="chip chip--plain">
              {d.name}
            </Text>
          ))}
        </View>
      )}

      {trip.status === 'PLANNED' || trip.status === 'ONGOING' ? (
        <Progress done={tripDays(trip)} total={tripDays(trip)} label="行程天数" />
      ) : null}
    </Link>
  );
}

export default TripsPage;
