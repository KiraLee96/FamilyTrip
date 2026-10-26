/**
 * 行程手账 —— 按「即将出行 / 过往」分组（Taro 同构版）
 * ============================================================================
 * 版式对齐 2026-10-13 设计稿（截图 4）：
 *   页头「行程手账」+ 虚线徽章「N 程」
 *   ① 年份分段筛选：全部 / 2025 / 2026 / 2027
 *   ② 「▎即将出行」：PLANNED / ONGOING 按开始日期升序，主卡样式
 *   ③ 其余行程沉底（草稿 / 已完成 / 已取消）
 *   ④ 「＋ 新增行程」虚线入口条
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { navigate } from '../nav';

import { api } from '../api/index';
import type { Trip, TripStatus } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { StatusChip, dateRange } from '../components/shared';
import { tripDisplayStatus, tripIsEnded } from '../utils/constants';
import { useAsync } from '../hooks/useAsync';

/** 行程所属年份（优先出发日，其次结束日） */
function tripYear(t: Trip): number | null {
  const d = t.startDate ?? t.endDate;
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  return Number.isNaN(y) ? null : y;
}

/** 即将出行：PLANNED / ONGOING **且日期未过**（过期的显示成已完成，不再混进"即将"） */
function isUpcoming(t: Trip): boolean {
  if (!(t.status === 'PLANNED' || t.status === 'ONGOING')) return false;
  return !tripIsEnded(t);
}

const REST_LABEL: Partial<Record<TripStatus, string>> = {
  DRAFT: '草稿',
  FINISHED: '已完成',
  CANCELLED: '已取消',
};

export function TripsPage() {
  const nowYear = new Date().getFullYear();
  const [yearFilter, setYearFilter] = useState<number | 'all'>('all');

  const q = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );

  // tab 页驻留缓存：从详情页返回时不会自动重拉，用 useDidShow 刷新
  // （H5 端对应页面重新显示，小程序端对应 onShow，双端语义一致）
  Taro.useDidShow(() => {
    q.reload();
  });

  // 年份候选：行程年份 ∪ {今年-1, 今年, 今年+1}
  const years = useMemo(() => {
    const set = new Set<number>([nowYear - 1, nowYear, nowYear + 1]);
    for (const t of q.data ?? []) {
      const y = tripYear(t);
      if (y !== null) set.add(y);
    }
    return [...set].sort((a, b) => a - b);
  }, [q.data, nowYear]);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).filter((t) => yearFilter === 'all' || tripYear(t) === yearFilter);
  const upcoming = list
    .filter(isUpcoming)
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
  const rest = list.filter((t) => !isUpcoming(t));

  return (
    <PageLayout
      title="行程手账"
      sub="每一次出发，都值得好好安排"
      badge={`${(q.data ?? []).length} 程`}
    >
      {/* ① 年份筛选 */}
      <View className="seg">
        <Text
          className={yearFilter === 'all' ? 'seg__btn seg__btn--on' : 'seg__btn'}
          onClick={() => setYearFilter('all')}
        >
          全部
        </Text>
        {years.map((y) => (
          <Text
            key={y}
            className={yearFilter === y ? 'seg__btn seg__btn--on' : 'seg__btn'}
            onClick={() => setYearFilter(y)}
          >
            {y}
          </Text>
        ))}
      </View>

      {/* ② 即将出行 */}
      <View className="section-title">
        <Text className="sec-mark" />
        即将出行
      </View>
      {upcoming.length === 0 ? (
        <View className="card">
          <Empty text="没有即将到来的行程" />
        </View>
      ) : (
        upcoming.map((t) => <TripCard key={t.id} trip={t} hint />)
      )}

      {/* ③ 其余行程 */}
      {rest.length > 0 && (
        <>
          <View className="section-title">更早的行程</View>
          {rest.map((t) => (
            <TripCard key={t.id} trip={t} label={REST_LABEL[tripDisplayStatus(t)]} />
          ))}
        </>
      )}

      {/* ④ 新增行程 */}
      <View className="add-bar" onClick={() => navigate('/trips/new')}>
        <Icon name="plus" size={16} />
        <Text className="add-bar__text">新增行程</Text>
      </View>
    </PageLayout>
  );
}

/**
 * 行程卡 —— 点整张卡进入详情（内容），详情页首的信息行再进「行程管理」。
 * ============================================================================
 * 2026-10-26：去掉了「N 人同行」。原来那个数字取的是**家庭人数**
 * （families[0].memberCount），不是本次行程的参与人数 —— 家庭 4 人、本趟只去 3 人时
 * 会显示错的数字。列表接口不返回成员明细，拿不到准确值就不显示（不编造数据）；
 * 准确的「共 N 人」在详情页与行程管理页。要列表也显示，需后端在 GET /trips 补
 * memberCount（已列入派发单）。
 */
function TripCard({ trip, hint, label }: { trip: Trip; hint?: boolean; label?: string }) {
  const dests = trip.destinations ?? [];
  return (
    <Link to={`/trips/${trip.id}`} className="trip">
      <View className="trip__top">
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text className="trip__title">{trip.title}</Text>
          <View className="trip__meta">
            <Text>
              <Icon name="map-pin" size={13} />
              {dests.length > 0 ? dests.map((d) => d.name).join(' · ') : '目的地待定'}
            </Text>
            <Text>
              <Icon name="calendar" size={13} />
              {dateRange(trip)}
            </Text>
            {/* 同行人数：用后端给的 memberCount（本趟人数）。拿不到就不显示，不拿家庭人数顶替 */}
            {trip.memberCount !== undefined && (
              <Text>
                <Icon name="users" size={13} />
                {trip.memberCount} 人同行
              </Text>
            )}
          </View>
        </View>
        {/* 展示状态而非原始 status：日期过了但还没归档的行程，也要显示「已完成」 */}
        <StatusChip status={tripDisplayStatus(trip)} />
      </View>
      {hint ? (
        <Text className="muted" style={{ display: 'block', marginTop: 10 }}>
          点击查看详情与清单
        </Text>
      ) : null}
      {label ? (
        <Text className="muted" style={{ display: 'block', marginTop: 8 }}>
          {label}
        </Text>
      ) : null}
    </Link>
  );
}

export default TripsPage;
