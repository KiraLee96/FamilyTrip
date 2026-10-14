/**
 * 首页 —— 当前主出行 + 心愿池区块 + 备选行程 + 待办提醒（Taro 同构版）
 * ============================================================================
 * 信息优先级：正在筹备的出行放最上面，做成「主卡」；
 * 其余行程收成紧凑列表；清单未完成项当作提醒露出。
 *
 * M-Client-2：心愿池由独立 tab 降级为首页区块（微信 tabBar 上限 5 个），
 *   投票能力保留；完整心愿池仍可从区块底部进入（/wishes，非 tab 页）。
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';

import { api, DATA_SOURCE } from '../api/index';
import type { ChecklistItem, Trip, Wish } from '../api/types';
import { retryLogin } from '../api/session';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { Progress, SectionTitle, StatusChip, dateRange, shortDate } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { useSession } from '../hooks/useSession';

export function HomePage() {
  const me = useSession();
  const [relogining, setRelogining] = useState(false);
  const trips = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
  );

  // 主行程 id（供清单按行程收敛；hooks 需无条件执行，故用 useMemo 从数据推导）
  const primaryId = useMemo(() => {
    const list = trips.data ?? [];
    const p =
      list.find((t) => t.status === 'ONGOING') ??
      list.find((t) => t.status === 'PLANNED') ??
      list[0];
    return p?.id ?? '';
  }, [trips.data]);

  const checks = useAsync(
    useCallback(
      async () => (primaryId === '' ? [] : api.listTripChecklist(primaryId, 'SHARED')),
      [primaryId],
    ),
    [primaryId],
  );

  // http 模式且未拿到登录态：bootstrap 静默登录失败，给手动重试入口。
  // 声明放在各早退分支之前——加载/错误/空态时登录卡片同样要可见
  const loginPending = DATA_SOURCE === 'http' && me === undefined;
  const sessionCard = loginPending ? (
    <View className="card" style={{ marginBottom: 12 }}>
      <Text className="muted" style={{ fontSize: 13 }}>
        微信登录未完成，数据可能加载失败
      </Text>
      <View
        className="btn btn--ghost btn--block"
        style={{ marginTop: 8, opacity: relogining ? 0.6 : 1 }}
        onClick={() => {
          setRelogining(true);
          void retryLogin().finally(() => setRelogining(false));
        }}
      >
        <Text>{relogining ? '登录中…' : '重新登录'}</Text>
      </View>
    </View>
  ) : null;

  if (trips.loading)
    return (
      <>
        {sessionCard}
        <Loading />
      </>
    );
  if (trips.error)
    return (
      <>
        {sessionCard}
        <ErrorBox message={trips.error} onRetry={trips.reload} />
      </>
    );

  const list = trips.data ?? [];
  if (list.length === 0)
    return (
      <>
        {sessionCard}
        <Empty text="还没有出行计划，先建一个行程吧" />
        <View style={{ marginBottom: 12 }}>
          <Link to="/trips/new" className="btn btn--block">
            新建行程
          </Link>
        </View>
        <WishBlock />
      </>
    );

  // 主卡：优先「进行中」，其次「已计划」，最后取第一条
  const primary =
    list.find((t) => t.status === 'ONGOING') ??
    list.find((t) => t.status === 'PLANNED') ??
    list[0]!;
  const others = list.filter((t) => t.id !== primary.id);

  const shared = checks.data ?? [];
  const todo = shared.filter((c) => !c.done);

  return (
    <PageLayout title="家庭出行" sub={me ? `你好，${me.nickname}` : '把想一起去的地方，一件件排上'}>
      {sessionCard}

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

      <WishBlock />

      <View style={{ marginTop: 4 }}>
        <Link to="/trips" className="btn btn--ghost btn--block">
          查看全部行程
        </Link>
      </View>
    </PageLayout>
  );
}

/**
 * 心愿池区块（首页内）—— 保留投票能力
 * 展示票数最高的若干心愿，点「想去」即投票（乐观更新 + 服务端确认）。
 */
function WishBlock() {
  const q = useAsync(
    useCallback(() => api.listWishes(), []),
    [],
  );
  /** 投票的本地覆盖（id → Wish），避免整块重拉 */
  const [local, setLocal] = useState<Record<string, Wish>>({});
  const [busyId, setBusyId] = useState('');

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).map((w) => local[w.id] ?? w);
  const open = list
    .filter((w) => w.status === 'OPEN')
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 3);

  if (open.length === 0) return null;

  const vote = async (id: string) => {
    setBusyId(id);
    try {
      const next = await api.voteWish(id);
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 忽略：保持服务端状态 */
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <SectionTitle icon="sparkles">家庭心愿池</SectionTitle>
      <View className="card card--flush">
        {open.map((w) => (
          <View className="wish" key={w.id}>
            <View className="wish__body">
              <Text className="wish__title">{w.title}</Text>
              {w.note ? <Text className="wish__note">{w.note}</Text> : null}
            </View>
            <View
              className={w.votedByMe ? 'vote vote--on' : 'vote'}
              onClick={busyId === w.id ? undefined : () => void vote(w.id)}
            >
              <Text className="vote__n">
                <Icon name="heart" size={14} />
                {w.votes}
              </Text>
              <Text className="vote__cap">{w.votedByMe ? '已投' : '想去'}</Text>
            </View>
          </View>
        ))}
      </View>
      <Link to="/wishes" className="btn btn--ghost btn--block">
        查看全部心愿
      </Link>
    </>
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
