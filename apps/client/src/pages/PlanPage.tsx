/**
 * 年度规划 —— 年份切换 + 统计三宫格 + 年度备忘 + 出行日历 + 心愿池
 * ============================================================================
 * 版式对齐 2026-10-13 设计稿（截图 3）：
 *   页头「年度规划」+ 虚线徽章「2026」
 *   ① 年份分段：2025 / 2026 / 2027（当前选中深绿实心）
 *   ② 统计三宫格：计划出行（次）/ 心愿（条）/ 已实现
 *   ③ 年度备忘卡：本地存储（Taro.setStorageSync，不依赖接口），可编辑
 *   ④ 出行日历：12 月圆点网格，有行程实心、选中月橙环；下方列该月行程
 *   ⑤ 心愿池内嵌：投票 + 状态筛选；完整池跳 /wishes
 *   ⑥ 年度回忆：memory 域 ANNUAL 快照（幂等生成，不可覆盖）
 *
 * 数据全部由 /trips /wishes 聚合得出，不额外依赖后端接口。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';

import { ApiError, api } from '../api/index';
import type { MemorySnapshot, Trip, Wish } from '../api/types';
import { Icon } from '../components/Icon';
import { MemoryCard } from '../components/MemoryCard';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import {
  MONTH_LABELS,
  StatusChip,
  WISH_STATUS_TEXT,
  dateRange,
  tripDays,
} from '../components/shared';
import { useAsync } from '../hooks/useAsync';

/** 年度备忘的本地存储 key（原型期不依赖后端；真后端可迁移为家庭备注字段） */
const MEMO_KEY = 'family-trip-annual-memo';

/** 心愿筛选项（契约无「已实现」心愿态，仅保留有数据支撑的三项） */
const WISH_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'mine', label: '我的' },
  { key: 'open', label: '待规划' },
  { key: 'adopted', label: '已规划' },
] as const;

type WishFilter = (typeof WISH_FILTERS)[number]['key'];

/** 行程所属年份（优先出发日，其次结束日；都无则 null） */
function tripYear(t: Trip): number | null {
  const d = t.startDate ?? t.endDate;
  if (!d) return null;
  const y = Number(d.slice(0, 4));
  return Number.isNaN(y) ? null : y;
}

function loadMemo(year: number): string {
  try {
    return Taro.getStorageSync<string | undefined>(`${MEMO_KEY}-${year}`) ?? '';
  } catch {
    return '';
  }
}

function saveMemo(year: number, text: string): void {
  try {
    Taro.setStorageSync(`${MEMO_KEY}-${year}`, text);
  } catch {
    /* 存储不可用（隐私模式等）：仅放弃持久化，不阻塞编辑 */
  }
}

export function PlanPage() {
  const nowYear = new Date().getFullYear();
  const nowMonth = new Date().getMonth() + 1;
  const [year, setYear] = useState(nowYear);
  const [month, setMonth] = useState(nowMonth);
  const [wishFilter, setWishFilter] = useState<WishFilter>('all');

  const tripsQ = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );
  const wishesQ = useAsync(
    useCallback(() => api.listWishes(), []),
    [],
  );
  const familiesQ = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  // 年份候选：行程年份 ∪ {今年-1, 今年, 今年+1}
  const years = useMemo(() => {
    const set = new Set<number>([nowYear - 1, nowYear, nowYear + 1]);
    for (const t of tripsQ.data ?? []) {
      const y = tripYear(t);
      if (y !== null) set.add(y);
    }
    return [...set].sort((a, b) => a - b);
  }, [tripsQ.data, nowYear]);

  // 当年有行程的月份集合（必须在早退之前声明：hooks 数量不能随加载态变化，否则 React #310）
  const onMonths = useMemo(() => {
    const set = new Set<number>();
    for (const t of tripsQ.data ?? []) {
      if (tripYear(t) !== year) continue;
      if (t.startDate) set.add(Number(t.startDate.slice(5, 7)));
    }
    return set;
  }, [tripsQ.data, year]);

  if (tripsQ.loading || wishesQ.loading) return <Loading />;
  if (tripsQ.error) return <ErrorBox message={tripsQ.error} onRetry={tripsQ.reload} />;
  if (wishesQ.error) return <ErrorBox message={wishesQ.error} onRetry={wishesQ.reload} />;

  const all = tripsQ.data ?? [];
  const list = all.filter((t) => tripYear(t) === year);
  const finished = list.filter((t) => t.status === 'FINISHED');

  const wishes = (wishesQ.data ?? []).filter((w) => w.status !== 'ARCHIVED');
  const memberCount = familiesQ.data?.[0]?.memberCount ?? 0;

  const monthTrips = list.filter(
    (t) => t.startDate?.slice(5, 7) === String(month).padStart(2, '0'),
  );

  return (
    <PageLayout title="年度规划" sub="把想去的地方，排进一年的行程里" badge={String(year)}>
      {/* ① 年份切换 */}
      <View className="seg">
        {years.map((y) => (
          <Text
            key={y}
            className={y === year ? 'seg__btn seg__btn--on' : 'seg__btn'}
            onClick={() => setYear(y)}
          >
            {y}
          </Text>
        ))}
      </View>

      {/* ② 统计三宫格 */}
      <View className="stat-grid">
        <View className="stat">
          <Text className="stat__n">{list.length}</Text>
          <Text className="stat__cap">计划出行（次）</Text>
        </View>
        <View className="stat">
          <Text className="stat__n">{wishes.length}</Text>
          <Text className="stat__cap">心愿（条）</Text>
        </View>
        <View className="stat">
          <Text className="stat__n">{finished.length}</Text>
          <Text className="stat__cap">已实现</Text>
        </View>
      </View>

      {/* ③ 年度备忘（本地存储） */}
      <AnnualMemo year={year} />

      {/* ④ 出行日历 */}
      <View className="section-title">
        出行日历
        <Text className="section-title__side" style={{ marginLeft: 8 }}>
          {year} 年
        </Text>
      </View>
      <View className="card">
        <View className="cal-grid">
          {MONTH_LABELS.map((label, i) => {
            const m = i + 1;
            const on = onMonths.has(m);
            const sel = m === month;
            return (
              <View className="cal-cell" key={label} onClick={() => setMonth(m)}>
                <View
                  className={`cal-cell__dot${on ? ' cal-cell__dot--on' : ''}${sel ? ' cal-cell__dot--sel' : ''}`}
                >
                  {m}
                </View>
                <Text className="cal-cell__label">{label}</Text>
              </View>
            );
          })}
        </View>

        <View style={{ marginTop: 16 }}>
          <Text style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
            {month} 月 · {monthTrips.length} 个行程
          </Text>
          {monthTrips.length === 0 ? (
            <Text className="muted" style={{ display: 'block', marginTop: 8 }}>
              这个月还没有安排
            </Text>
          ) : (
            monthTrips.map((t) => (
              <Link
                key={t.id}
                to={`/trips/${t.id}`}
                className="trip"
                style={{ marginTop: 10, marginBottom: 0, padding: 14 }}
              >
                <View className="trip__top">
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text className="trip__title" style={{ fontSize: 15.5 }}>
                      {t.title}
                    </Text>
                    <View className="trip__meta">
                      <Text>
                        <Icon name="map-pin" size={13} />
                        {(t.destinations ?? []).map((d) => d.name).join(' · ') || '目的地待定'}
                      </Text>
                      <Text>
                        <Icon name="calendar" size={13} />
                        {dateRange(t)}
                      </Text>
                      <Text>
                        <Icon name="users" size={13} />
                        {memberCount} 人同行
                      </Text>
                    </View>
                  </View>
                  <StatusChip status={t.status} />
                </View>
              </Link>
            ))
          )}
        </View>
      </View>

      {/* ⑤ 心愿池内嵌 */}
      <View className="section-title">
        心愿池
        <Text className="section-title__side" style={{ marginLeft: 8 }}>
          {year} 年 · {wishes.length} 条
        </Text>
        <Link to="/wishes" className="section-title__side" style={{ marginLeft: 'auto' }}>
          去心愿池
          <Icon name="chevron-right" size={13} />
        </Link>
      </View>
      <View className="seg">
        {WISH_FILTERS.map((f) => (
          <Text
            key={f.key}
            className={wishFilter === f.key ? 'seg__btn seg__btn--on' : 'seg__btn'}
            onClick={() => setWishFilter(f.key)}
          >
            {f.label}
          </Text>
        ))}
      </View>
      <WishPoolInline filter={wishFilter} wishes={wishes} />

      {/* ⑥ 年度回忆 */}
      <AnnualMemorySection year={year} />
    </PageLayout>
  );
}

/** 年度备忘卡：本地存储，点右侧圆珠笔切换编辑 */
function AnnualMemo({ year }: { year: number }) {
  const [text, setText] = useState(() => loadMemo(year));
  const [editing, setEditing] = useState(false);

  // 切换年份时加载对应年份的备忘
  useEffect(() => {
    setText(loadMemo(year));
    setEditing(false);
  }, [year]);

  return (
    <View className="card">
      <View className="memo">
        <View className="memo__body">
          <Text className="memo__title">年度备忘</Text>
          {editing ? (
            <View style={{ marginTop: 8 }}>
              <Input
                className="input"
                style={{ height: 40 }}
                value={text}
                onInput={(e) => setText(e.detail.value)}
                placeholder="记下这一年的出行心愿…"
              />
              <View style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <View
                  className="btn"
                  style={{ flex: 1 }}
                  onClick={() => {
                    saveMemo(year, text);
                    setEditing(false);
                    void Taro.showToast({ title: '已保存', icon: 'none' });
                  }}
                >
                  保存
                </View>
                <View className="btn btn--ghost" onClick={() => setEditing(false)}>
                  取消
                </View>
              </View>
            </View>
          ) : (
            <Text className="memo__text">{text || '还没有写，记下这一年的出行心愿吧'}</Text>
          )}
        </View>
        {!editing && (
          <View className="memo__edit" onClick={() => setEditing(true)}>
            <Icon name="edit" size={15} />
          </View>
        )}
      </View>
    </View>
  );
}

/**
 * 心愿池内嵌（规划页）—— 投票 + 筛选。
 * 注意：编辑态暂用只读展示 + 保存/取消（真输入需要 input 组件受控改造，
 * 本地备忘先行落地；契约未定义 createWish，新建心愿走 /wishes 完整池）。
 */
function WishPoolInline({ filter, wishes }: { filter: WishFilter; wishes: Wish[] }) {
  const [local, setLocal] = useState<Record<string, Wish>>({});

  /**
   * 投票（2026-10-27 修复）：服务端只回 `{ voteCount, votedByMe }`，不是整条 wish。
   * 这处与首页、心愿池页是**三份重复实现**，同一个信封误读一起错了三遍 ——
   * 正因为它只影响"点了没反应"，三处都没被注意到。
   */
  const onVote = async (wish: Wish) => {
    try {
      const r = await api.voteWish(wish.id);
      setLocal((m) => {
        const base = m[wish.id] ?? wish;
        return { ...m, [wish.id]: { ...base, votes: r.votes, votedByMe: r.votedByMe } };
      });
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '投票失败', icon: 'none' });
    }
  };

  const list = wishes.map((w) => local[w.id] ?? w);
  const shown = list
    .filter((w) => {
      if (filter === 'mine') return w.votedByMe;
      if (filter === 'open') return w.status === 'OPEN';
      if (filter === 'adopted') return w.status === 'ADOPTED';
      return true;
    })
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 3);

  if (shown.length === 0) {
    return (
      <View className="card">
        <Empty text="这个筛选下还没有心愿" />
      </View>
    );
  }

  return (
    <View className="card card--flush">
      {shown.map((w) => (
        <View className="wish" key={w.id}>
          <View className="wish__body">
            <View className="wish__title">
              <Text>{w.title}</Text>
              <Text className={`note-slip__st note-slip__st--${w.status.toLowerCase()}`}>
                {WISH_STATUS_TEXT[w.status]}
              </Text>
            </View>
            {w.note ? <Text className="wish__note">{w.note}</Text> : null}
            {(w.tags ?? []).length > 0 && (
              <View className="wish__tags">
                {(w.tags ?? []).map((t) => (
                  <Text key={t} className="tag">
                    {t}
                  </Text>
                ))}
              </View>
            )}
          </View>
          <View className={w.votedByMe ? 'vote vote--on' : 'vote'} onClick={() => void onVote(w)}>
            <Icon name="heart" size={14} />
            <Text className="vote__n">{w.votes}</Text>
            <Text className="vote__cap">{w.votedByMe ? '已投' : '想去'}</Text>
          </View>
        </View>
      ))}
    </View>
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
      <View className="section-title">年度回忆 · {year}</View>
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
            style={{ margin: '0 auto' }}
            onClick={() => {
              if (!busy) void generate();
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 600 }}>
              {busy ? '生成中…' : `生成 ${year} 年度回忆`}
            </Text>
          </View>
          {genErr !== '' && <ErrorBox message={genErr} onRetry={() => void generate()} />}
        </View>
      )}
    </>
  );
}

/** 全年行程天数（统计行尾展示，保留原信息） */
export function planTotalDays(list: Trip[]): number {
  return list.reduce((n, t) => n + tripDays(t), 0);
}

export default PlanPage;
