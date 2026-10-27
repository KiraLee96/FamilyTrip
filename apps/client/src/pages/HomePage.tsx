/**
 * 总览页 —— 下一站主卡 + 月份时间轴 + 预算概览 + 心愿便签 + 最近回忆
 * ============================================================================
 * 版式对齐 2026-10-13 设计稿（截图 1/2）：
 *   页头「旅行管家AllInOne」+ 虚线徽章「2026」+ 头像圆形按钮
 *   （2026-10-16 需求：头像旁不再放加号，新建行程只保留右下角 FAB；
 *     头像渲染真实头像（可更换，见 ProfilePage），无头像时 👤 占位）
 *   ① 深绿主卡「下一站」：目的地、出发—到达虚线、N 天后出发、
 *      出发日期 / 同行 / 查看行程 三格
 *   ② 月份时间轴：全年 12 月圆点，有行程的月深绿实心、当前月描绿环
 *   ③ 预算概览：已花费总额 + 分类占比 + 查看账本
 *   ④ 心愿便签：横排票据小卡（待规划/已安排胶囊 + 投票数）
 *   ⑤ 最近回忆：最新回忆快照摘要；空态引导上传
 *   右下角橙色 FAB → 新建行程
 *
 * 数据说明：契约无「同行人数 / 总预算」字段——
 *   · 同行取家庭成员数（Family.memberCount，数据真实存在）
 *   · 预算卡只呈现已花费与分类占比（ExpenseSummary），不虚构总预算
 */

import { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { navigate } from '../nav';

import { api, DATA_SOURCE } from '../api/index';
import type { Trip, Wish } from '../api/types';
import { retryLogin } from '../api/session';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { PhotoCover } from '../components/PhotoCover';
import { MONTH_LABELS, WISH_STATUS_TEXT, daysUntil, shortDate } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { useSession } from '../hooks/useSession';
import { backendOutdatedHint, isBackendOutdated } from '../utils/constants';
import { chooseTripForPhotos, pickAndUploadPhotos } from '../utils/upload';

export function HomePage() {
  const me = useSession();
  const [relogining, setRelogining] = useState(false);

  const tripsQ = useAsync(
    useCallback(() => api.listTrips(), []),
    [],
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

  if (tripsQ.loading)
    return (
      <>
        {sessionCard}
        <Loading />
      </>
    );
  if (tripsQ.error)
    return (
      <>
        {sessionCard}
        <ErrorBox message={tripsQ.error} onRetry={tripsQ.reload} />
      </>
    );

  const list = tripsQ.data ?? [];

  // 主行程：优先「进行中」，其次「已计划」，最后取第一条
  const primary =
    list.find((t) => t.status === 'ONGOING') ?? list.find((t) => t.status === 'PLANNED') ?? list[0];

  const year = new Date().getFullYear();

  return (
    <PageLayout
      title="旅行管家AllInOne"
      sub="全家的下一站，从这里翻开"
      badge={String(year)}
      actions={
        <Link to="/profile" className="head-btn head-btn--avatar">
          <Avatar user={me} size={28} />
        </Link>
      }
    >
      {sessionCard}

      {primary ? <NextStopCard trip={primary} /> : <NextStopEmpty />}

      <MonthRail trips={list} />

      {primary ? <BudgetCard trip={primary} /> : null}

      <WishSlips />

      <RecentMemory />

      <Link to="/trips/new" className="fab">
        <Text>＋</Text>
      </Link>
    </PageLayout>
  );
}

/* ------------------------------------------------------------------ */

/** 深绿主卡「下一站」：目的地 + 出发—到达虚线 + N 天后出发 + 三格信息 */
function NextStopCard({ trip }: { trip: Trip }) {
  const families = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );
  const checks = useAsync(
    useCallback(() => api.listTripChecklist(trip.id, 'SHARED'), [trip.id]),
    [trip.id],
  );

  const dest = trip.destinations?.[0]?.name ?? trip.title;
  const memberCount = families.data?.[0]?.memberCount ?? 0;
  const days = daysUntil(trip.startDate);
  const shared = checks.data ?? [];
  const todo = shared.filter((c) => !c.done).length;

  return (
    <Link to={`/trips/${trip.id}`} className="hero">
      <Text className="hero__label">下一站</Text>
      <Text className="hero__title">{dest}</Text>

      <View className="hero__path">
        <View className="hero__path-dot" />
        <Text style={{ fontSize: 12, opacity: 0.85 }}>出发</Text>
        <View className="hero__path-line" />
        <Text style={{ fontSize: 12, opacity: 0.85 }}>{dest}</Text>
        <View className="hero__path-dot" />
      </View>

      <View className="hero__count">
        <Text className="hero__count-n">
          {days === null ? '—' : days <= 0 ? Math.abs(days) : days}
        </Text>
        <Text className="hero__count-cap">
          {days === null
            ? '日期待定'
            : days > 0
              ? '天后出发'
              : days === 0
                ? '今天出发'
                : '天前出发'}
        </Text>
      </View>

      <View className="hero__cells">
        <View className="hero__cell">
          <Text className="hero__cell-v">{shortDate(trip.startDate)}</Text>
          <Text className="hero__cell-cap">出发日期</Text>
        </View>
        <View className="hero__cell">
          <Text className="hero__cell-v">{memberCount} 人</Text>
          <Text className="hero__cell-cap">同行</Text>
        </View>
        <View className="hero__go">
          <Text>查看行程</Text>
          <Icon name="chevron-right" size={15} />
        </View>
      </View>

      {shared.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <View className="progress__bar">
            <View
              className="progress__fill"
              style={{ width: `${Math.round(((shared.length - todo) / shared.length) * 100)}%` }}
            />
          </View>
          <View className="progress__label">
            <Text>
              行前准备 {shared.length - todo}/{shared.length}
            </Text>
            <Text>{todo > 0 ? `待办 ${todo} 项` : '已就绪'}</Text>
          </View>
        </View>
      )}
    </Link>
  );
}

/** 无行程时的深绿引导卡（同主卡外观，保持版面不断裂） */
function NextStopEmpty() {
  return (
    <View className="hero">
      <Text className="hero__label">下一站</Text>
      <Text className="hero__title">还没有安排</Text>
      <Text className="hero__empty-cap">
        点右下角的加号，把全家的第一个行程排上日程。想去的地方，从这张卡开始。
      </Text>
      <View style={{ marginTop: 14 }}>
        <Link to="/trips/new" className="head-btn head-btn--accent">
          <Icon name="plus" size={16} />
        </Link>
      </View>
    </View>
  );
}

/** 月份时间轴：全年 12 月，有行程实心、当前月描环 */
function MonthRail({ trips }: { trips: Trip[] }) {
  const nowMonth = new Date().getMonth() + 1;
  const onMonths = useMemo(() => {
    const set = new Set<number>();
    for (const t of trips) {
      if (t.startDate) set.add(Number(t.startDate.slice(5, 7)));
    }
    return set;
  }, [trips]);

  return (
    <View className="month-rail">
      {MONTH_LABELS.map((label, i) => {
        const m = i + 1;
        const on = onMonths.has(m);
        const now = m === nowMonth;
        return (
          <View className="month-rail__item" key={label}>
            <View
              className={`month-rail__dot${now ? ' month-rail__dot--now' : on ? ' month-rail__dot--on' : ''}`}
            />
            <Text className={`month-rail__label${on || now ? ' month-rail__label--on' : ''}`}>
              {label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/** 预算概览：已花费总额 + 分类占比（契约无「总预算」字段，不虚构分母） */
function BudgetCard({ trip }: { trip: Trip }) {
  const q = useAsync(
    useCallback(() => api.expenseSummary(trip.id), [trip.id]),
    [trip.id],
  );

  if (q.loading || q.error || !q.data) return null;
  const s = q.data;
  const cats = s.byCategory.slice(0, 3);
  const max = Math.max(1, ...cats.map((c) => Number(c.amountCny)));
  const count = cats.length;

  return (
    <>
      <View className="section-title">
        <Text className="section-title__icon">
          <Icon name="wallet" size={16} />
        </Text>
        预算概览
        <Text className="section-title__side">{trip.title}</Text>
      </View>
      <View className="card">
        <View className="budget__row">
          <Text className="budget__cap">
            <Icon name="wallet" size={15} /> 已花费 / 总预算
          </Text>
          <Text className="budget__num">
            ¥{fmtMoney(s.totalCny)}
            <Text className="budget__den">/ 待定</Text>
          </Text>
        </View>
        <View className="progress" style={{ marginTop: 10 }}>
          <View className="progress__bar">
            <View className="progress__fill" style={{ width: '100%' }} />
          </View>
        </View>
        {cats.length > 0 && (
          <View className="bars" style={{ marginTop: 12 }}>
            {cats.map((c) => (
              <View className="bar__row" key={c.category}>
                <Text className="bar__name">{c.category}</Text>
                <View className="bar__track">
                  <View
                    className="bar__fill"
                    style={{ width: `${Math.round((Number(c.amountCny) / max) * 100)}%` }}
                  />
                </View>
                <Text className="bar__val">¥{fmtMoney(c.amountCny)}</Text>
              </View>
            ))}
          </View>
        )}
        <View className="budget__foot">
          <Text>{count > 0 ? `共 ${cats.length} 类已记账` : '还没有记账'}</Text>
          <Link to={`/trips/${trip.id}?tab=expense`} className="budget__link">
            查看账本
            <Icon name="chevron-right" size={13} />
          </Link>
        </View>
      </View>
    </>
  );
}

/** 心愿便签：横排票据小卡，投票即「想去」 */
function WishSlips() {
  const q = useAsync(
    useCallback(() => api.listWishes(), []),
    [],
  );
  /** 投票的本地覆盖（id → Wish），避免整块重拉 */
  const [local, setLocal] = useState<Record<string, Wish>>({});
  const [busyId, setBusyId] = useState('');

  if (q.loading || q.error) return null;
  const list = (q.data ?? []).map((w) => local[w.id] ?? w);
  const open = list
    .filter((w) => w.status !== 'ARCHIVED')
    .sort((a, b) => b.votes - a.votes)
    .slice(0, 4);

  /**
   * 投票（2026-10-27 修复）：服务端只回 `{ voteCount, votedByMe }`，
   * 不是整条 wish —— 以前把返回值当 wish 写进本地，界面纹丝不动。
   * 基准取「本地覆盖过的」优先，否则用列表里那条（首次投票没有本地缓存）。
   */
  const vote = async (wish: Wish) => {
    setBusyId(wish.id);
    try {
      const r = await api.voteWish(wish.id);
      setLocal((m) => {
        const base = m[wish.id] ?? wish;
        return { ...m, [wish.id]: { ...base, votes: r.votes, votedByMe: r.votedByMe } };
      });
    } catch (e: unknown) {
      // 以前是空 catch —— 失败毫无反馈，用户只会说"投不了"
      void Taro.showToast({ title: e instanceof Error ? e.message : '投票失败', icon: 'none' });
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <View className="section-title">
        心愿便签
        <Text className="section-title__side" style={{ marginLeft: 8 }}>
          全家想去的地方
        </Text>
        <Link to="/wishes" className="section-title__side" style={{ marginLeft: 'auto' }}>
          全部心愿
          <Icon name="chevron-right" size={13} />
        </Link>
      </View>
      {open.length === 0 ? (
        <View className="card">
          <Text className="muted">还没有心愿，去心愿池添加一个吧</Text>
        </View>
      ) : (
        <View className="slip-rail">
          {open.map((w) => (
            <View
              className="note-slip"
              key={w.id}
              onClick={busyId === w.id ? undefined : () => void vote(w)}
            >
              <Text className="note-slip__title">{w.title}</Text>
              <View className="note-slip__row">
                <Text className={`note-slip__st note-slip__st--${w.status.toLowerCase()}`}>
                  {WISH_STATUS_TEXT[w.status]}
                </Text>
                <Text className="note-slip__meta">
                  <Icon name="heart" size={11} />
                  {w.votes}
                </Text>
              </View>
              {w.note ? (
                <Text className="note-slip__meta" style={{ lineHeight: 1.5 }}>
                  {w.note}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      )}
    </>
  );
}

/**
 * 最近回忆：**照片回忆组横向卡片**（2026-10-27 需求）
 * ============================================================================
 * 用户口径：「行程中的照片自动生成回忆墙。最近回忆显示之前所有旅行的照片，
 * 类似苹果手机相册的回忆功能」。
 *
 * 与旧实现的区别（为什么整段重写）：
 *   · 旧：`listMemories()` 取**最新一条** memoryArchive 快照 → 只显示一场旅行，
 *     而且必须先手动「生成回忆」才有数据；
 *   · 新：`listPhotoMemories()` 由服务端现算分组（有 tripId 按行程、无则按月份），
 *     **照片一上传就自动出现**，横向滑过去就是历次旅行。
 *
 * 头像池已在服务端按 `fileKey` 前缀排除，不会混进来。
 */
function RecentMemory() {
  const q = useAsync(
    useCallback(() => api.listPhotoMemories({ limit: 8 }), []),
    [],
  );
  const [busy, setBusy] = useState(false);

  const groups = q.data ?? [];

  const upload = async () => {
    // 与回忆墙同一条路径：先问归属行程，否则照片永远进不了行程的照片 tab
    const tripId = await chooseTripForPhotos();
    if (tripId === null) return;
    setBusy(true);
    try {
      await pickAndUploadPhotos(tripId);
      q.reload();
    } catch {
      /* 用户取消或失败：静默 */
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <View className="section-title">
        <Text className="section-title__icon">
          <Icon name="camera" size={16} />
        </Text>
        最近回忆
        <Link to="/memory" className="section-title__side" style={{ marginLeft: 'auto' }}>
          回忆墙
          <Icon name="chevron-right" size={13} />
        </Link>
      </View>

      {isBackendOutdated(q.error) ? (
        /**
         * 4040 = 后端没有 `/media/memories`（生产 10-22 版）。
         * 不能落到下面的「回忆墙还空着」—— 那是在撒谎，用户会以为照片没了。
         */
        <View className="card">
          <Text style={{ fontSize: 12.5, fontWeight: 600 }}>最近回忆暂不可用</Text>
          <Text className="muted" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 4 }}>
            {backendOutdatedHint('缺少 /media/memories 接口')}。照片本身没丢，
            进「回忆墙」或行程的「照片」tab 仍能查看。
          </Text>
        </View>
      ) : groups.length === 0 ? (
        <View className="card">
          <View className="blank" style={{ padding: '26px 12px 6px' }}>
            <View className="blank__art" style={{ width: 92, height: 92, fontSize: 44 }}>
              🖼️
            </View>
            <Text className="blank__title" style={{ fontSize: 14.5 }}>
              回忆墙还空着
            </Text>
            <Text className="blank__cap">在行程里传几张照片，这里会自动长出回忆</Text>
            <View
              className={`btn btn--accent ${busy ? 'btn--busy' : ''}`}
              style={{ marginTop: 6, padding: '0 18px' }}
              onClick={busy ? undefined : () => void upload()}
            >
              <Icon name="camera" size={14} />
              <Text style={{ color: '#fff' }}>{busy ? '上传中…' : '上传照片'}</Text>
            </View>
          </View>
        </View>
      ) : (
        // 横向滑动：一屏能瞥见下一张，暗示「还有更多旅行」
        <ScrollView scrollX className="memo-strip" enhanced showScrollbar={false}>
          <View className="memo-strip__track">
            {groups.map((g) => (
              <View
                key={`${g.kind}-${g.tripId ?? g.month ?? ''}`}
                className="memo-card"
                onClick={() =>
                  navigate(
                    g.kind === 'TRIP' && g.tripId !== null
                      ? // 🔴 必须落 tab=photo：tab=memory 是「回忆快照」（要手动生成、不含照片），
                        //    点进去只会看到「这场出行还没有生成回忆」，等于照片没了
                        `/trips/${g.tripId}?tab=photo&readonly=1`
                      : '/memory',
                  )
                }
              >
                <PhotoCover url={g.cover} />
                <View className="memo-card__veil" />
                <View className="memo-card__meta">
                  <Text className="memo-card__title">{g.title}</Text>
                  <Text className="memo-card__sub">
                    {[g.subtitle, `${g.photoCount} 张`].filter((s) => s !== '').join(' · ')}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        </ScrollView>
      )}
    </>
  );
}

/** 金额格式化：2160 → 2,160.00 去掉无谓小数（.00 时取整） */
function fmtMoney(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  return Number.isInteger(n)
    ? n.toLocaleString('zh-CN')
    : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default HomePage;
