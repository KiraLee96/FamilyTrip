/**
 * 回忆快照卡片（多端同构）
 * ============================================================================
 * 展示 memory 域的不可变快照（MemorySnapshot）。
 * 行程详情页与年度规划页共用 —— 同一组件，不 fork。
 *
 * 隐私口径：快照只含共享域数据（出行/日程/花销汇总/照片计数），
 * PERSONAL 清单项绝不进入回忆（后端 D4 保证，前端不额外渲染）。
 */

import { Text, View } from '@tarojs/components';
import { Icon } from './Icon';
import { shortDate } from './shared';
import type { MemorySnapshot } from '../api/types';

/** 分 → 元字符串（后端金额是最小货币单位，避免浮点误差） */
function minorToYuan(minor: string | undefined): string {
  if (minor === undefined || minor === '') return '0.00';
  const n = Number(minor);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : '0.00';
}

export function MemoryCard({
  snapshot,
  note,
}: {
  snapshot: MemorySnapshot;
  /** 附加提示（如「同年已存在，展示的是另一篇」） */
  note?: string;
}) {
  const isTrip = snapshot.type === 'TRIP';

  return (
    <View className="card">
      <View className="memory__head">
        <Text className="memory__badge">
          <Icon name={isTrip ? 'route' : 'calendar'} size={12} />
          {isTrip ? '出行回忆' : '年度回忆'} · {snapshot.year}
        </Text>
        <Text className="muted" style={{ fontSize: 10.5 }}>
          快照不可变
        </Text>
      </View>

      {snapshot.trip && (
        <View className="memory__trip">
          <Text className="memory__trip-title">{snapshot.trip.title}</Text>
          <Text className="memory__trip-sub">
            {shortDate(snapshot.trip.startDate ?? '')} – {shortDate(snapshot.trip.endDate ?? '')} ·{' '}
            {snapshot.trip.memberNames.length > 0
              ? snapshot.trip.memberNames.join('、')
              : `${snapshot.trip.memberCount} 人`}
          </Text>
        </View>
      )}

      {(snapshot.itinerary ?? []).length > 0 && (
        <View className="memory__block">
          <Text className="memory__block-title">
            <Icon name="route" size={12} />
            走过的安排（{snapshot.itinerary!.length}）
          </Text>
          {(snapshot.itinerary ?? []).map((it, i) => (
            <View className="memory__row" key={`${it.date ?? ''}-${it.title}-${i}`}>
              <Text className="memory__row-date">{it.date ? shortDate(it.date) : '—'}</Text>
              <Text className="memory__row-title">{it.title}</Text>
              {it.location && <Text className="memory__row-loc">{it.location}</Text>}
            </View>
          ))}
        </View>
      )}

      {snapshot.expenseSummary && (
        <View className="memory__block">
          <Text className="memory__block-title">
            <Icon name="wallet" size={12} />
            花销汇总
          </Text>
          <View className="memory__money">
            <Text className="memory__money-num">
              ¥{minorToYuan(snapshot.expenseSummary.totalMinor)}
            </Text>
            <Text className="muted" style={{ fontSize: 11 }}>
              {snapshot.expenseSummary.currency}
            </Text>
          </View>
          {snapshot.expenseSummary.pendingRateCount > 0 && (
            <Text className="memory__hint">
              另有 {snapshot.expenseSummary.pendingRateCount} 笔待补汇率，未计入合计
            </Text>
          )}
          {Object.keys(snapshot.expenseSummary.byCategory).length > 0 && (
            <View className="memory__cats">
              {Object.entries(snapshot.expenseSummary.byCategory).map(([cat, v]) => (
                <Text className="chip" key={cat}>
                  {cat} ¥{minorToYuan(v)}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      <View className="memory__foot">
        <Text className="muted" style={{ fontSize: 11 }}>
          <Icon name="camera" size={12} />
          照片 {snapshot.mediaCount ?? 0} 张 · 生成于{' '}
          {snapshot.generatedAt ? snapshot.generatedAt.slice(0, 10) : '—'}
        </Text>
      </View>

      {note && <Text className="memory__hint">{note}</Text>}
    </View>
  );
}
