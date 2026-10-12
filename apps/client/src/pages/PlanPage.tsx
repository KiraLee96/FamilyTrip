/**
 * 年度规划 —— 全年出行总览（Taro 同构版）
 * ============================================================================
 * 把「已完成 / 已计划 / 草稿」按季度归位。
 * 数据全部由 /trips 聚合得出，不额外依赖后端接口。
 */

import { useCallback, useState } from 'react';
import { Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';

import { ApiError, api } from '../api/index';
import type { MemorySnapshot, Trip } from '../api/types';
import { Icon } from '../components/Icon';
import { MemoryCard } from '../components/MemoryCard';
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

      <AnnualMemorySection year={year} />

      <Text className="muted" style={{ textAlign: 'center', marginTop: 4 }}>
        按出发月份归入季度；未定日期的行程暂不显示
      </Text>
    </PageLayout>
  );
}

/**
 * 年度回忆区块（memory 域 ANNUAL 快照）
 * 幂等：本年度回忆已存在则直接展示既有快照（created=false），不覆盖。
 * 加载失败/未生成时静默降级为「生成入口」，不阻塞主界面。
 */
function AnnualMemorySection({ year }: { year: number }) {
  const [gen, setGen] = useState<{ snapshot: MemorySnapshot; created: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState('');

  const list = useAsync(
    useCallback(() => api.listMemories({ type: 'ANNUAL', year }), [year]),
    [year],
  );

  const detail = useAsync(
    useCallback(async (): Promise<MemorySnapshot | null> => {
      if (gen) return gen.snapshot;
      const hit = (list.data ?? []).find((m) => m.year === year);
      if (!hit) return null;
      const d = await api.getMemory(hit.id);
      return d.snapshot;
    }, [list.data, gen, year]),
    [list.data, gen, year],
  );

  const generate = async () => {
    setBusy(true);
    setGenErr('');
    try {
      const r = await api.generateAnnualMemory(year);
      setGen({ snapshot: r.snapshot, created: r.created });
    } catch (e) {
      setGenErr(e instanceof ApiError ? `${e.message}（code ${e.code}）` : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (list.loading || detail.loading) return null;

  const snap = detail.data ?? null;

  return (
    <>
      <Text className="section-title">年度回忆 · {year}</Text>
      {snap ? (
        <MemoryCard
          snapshot={snap}
          note={gen !== null && !gen.created ? '本年度回忆已存在，快照不可覆盖。' : undefined}
        />
      ) : (
        <View className="card memory__empty">
          <Text className="memory__empty-title">{year} 年的回忆还没生成</Text>
          <Text className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: '6px 0 12px' }}>
            年底一键生成本年度回忆：全年行程、花销汇总、照片数，定格成不可变的家庭档案。
          </Text>
          <View
            className={busy ? 'add-row__btn add-row__btn--off' : 'add-row__btn'}
            onClick={() => {
              if (!busy) void generate();
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>
              {busy ? '生成中…' : `生成 ${year} 年度回忆`}
            </Text>
          </View>
          {genErr !== '' && <ErrorBox message={genErr} onRetry={() => void generate()} />}
        </View>
      )}
    </>
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
