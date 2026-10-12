/**
 * 行程详情 —— 按天时间轴 + 准备清单 + 花销（Taro 同构版）
 * ============================================================================
 * 三个板块用标签页切换，避免长滚动。
 * 路由参数从 react-router 的 useParams 改为 nav 抽象层的 useRouteParams。
 */

import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Input, Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';
import { useRouteParams } from '../nav';

import { ApiError, api } from '../api/index';
import type { ChecklistItem, MemoryArchive, MemorySnapshot } from '../api/types';
import { Icon } from '../components/Icon';
import { MemoryCard } from '../components/MemoryCard';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { Progress, StatusChip, dateRange, shortDate, weekday } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { pickAndUploadPhotos } from '../utils/upload';

type Tab = 'itinerary' | 'checklist' | 'expense' | 'photo' | 'memory';

export function TripDetailPage() {
  // nav 层生成的 query 参数名是 id（见 src/nav/index.ts 的 toTaroUrl）
  const { id: tripId = '' } = useRouteParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('itinerary');

  const trip = useAsync(
    useCallback(() => api.getTrip(tripId), [tripId]),
    [tripId],
  );

  if (trip.loading) return <Loading />;
  if (trip.error) return <ErrorBox message={trip.error} onRetry={trip.reload} />;
  const t = trip.data!;

  return (
    <PageLayout title={t.title} sub={dateRange(t)}>
      <Link
        to="/trips"
        className="muted"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginBottom: 10 }}
      >
        <Icon name="chevron-right" size={14} className="rotate-180" />
        返回行程列表
      </Link>

      <View className="trip">
        <View className="trip__top">
          <View style={{ flex: 1 }}>
            <Text className="trip__title">{t.title}</Text>
            <View className="trip__meta">
              <Text>
                <Icon name="calendar" size={14} />
                {dateRange(t)}
              </Text>
              {t.timezone && (
                <Text>
                  <Icon name="clock" size={14} />
                  {t.timezone}
                </Text>
              )}
            </View>
          </View>
          <StatusChip status={t.status} />
        </View>
        {(t.destinations ?? []).length > 0 && (
          <View className="trip__dest">
            {(t.destinations ?? []).map((d) => (
              <Text key={d.name} className="chip">
                <Icon name="map-pin" size={12} />
                {d.name}
              </Text>
            ))}
          </View>
        )}
        <Text className="muted" style={{ marginTop: 10 }}>
          版本 v{t.version} · CAS 乐观锁，更新需回传该值
        </Text>
      </View>

      <View className="tabs">
        {(
          [
            ['itinerary', '行程'],
            ['checklist', '清单'],
            ['expense', '花销'],
            ['photo', '照片'],
            ['memory', '回忆'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <View
            key={k}
            className={tab === k ? 'tabs__btn tabs__btn--on' : 'tabs__btn'}
            onClick={() => setTab(k)}
          >
            {label}
          </View>
        ))}
      </View>

      {tab === 'itinerary' && <ItineraryTab tripId={tripId} />}
      {tab === 'checklist' && <ChecklistTab tripId={tripId} familyId={t.familyId} />}
      {tab === 'expense' && <ExpenseTab tripId={tripId} />}
      {tab === 'photo' && <PhotoTab tripId={tripId} />}
      {tab === 'memory' && <MemoryTab tripId={tripId} tripTitle={t.title} />}
    </PageLayout>
  );
}

function ItineraryTab({ tripId }: { tripId: string }) {
  const q = useAsync(
    useCallback(() => api.listItineraries(tripId), [tripId]),
    [tripId],
  );
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;
  const items = q.data ?? [];
  if (items.length === 0) return <Empty text="还没有安排，先加一条吧" />;

  const dates = [...new Set(items.map((i) => i.date))].sort();

  return (
    <>
      {dates.map((d) => {
        const dayItems = items.filter((i) => i.date === d);
        return (
          <View className="day" key={d}>
            <View className="day__head">
              {shortDate(d)} {weekday(d)}
              <Text className="day__date">{dayItems.length} 项安排</Text>
            </View>
            <View className="tl">
              {dayItems.map((it) => (
                <View className="tl__row" key={it.id}>
                  <View className="tl__rail">
                    <View className="tl__dot" />
                    <View className="tl__line" />
                  </View>
                  <View className="tl__card">
                    {it.startTime && (
                      <View className="tl__time">
                        <Icon name="clock" size={13} />
                        <Text>{it.startTime}</Text>
                      </View>
                    )}
                    <Text className="tl__title">{it.title}</Text>
                    {it.location && (
                      <View className="tl__loc">
                        <Icon name="map-pin" size={13} />
                        <Text>{it.location}</Text>
                      </View>
                    )}
                    {it.note && <Text className="tl__note">{it.note}</Text>}
                  </View>
                </View>
              ))}
            </View>
          </View>
        );
      })}
    </>
  );
}

function ChecklistTab({ tripId, familyId }: { tripId: string; familyId: string }) {
  const q = useAsync(
    useCallback(() => api.listChecklist(), []),
    [],
  );
  /** toggle 的本地覆盖（与既有模式一致） */
  const [local, setLocal] = useState<Record<string, ChecklistItem>>({});
  /** 本页新增的项（不在首屏列表里，需追加渲染） */
  const [extra, setExtra] = useState<ChecklistItem[]>([]);
  const [draft, setDraft] = useState('');

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = [
    ...(q.data ?? []).map((c) => local[c.id] ?? c),
    ...extra.map((c) => local[c.id] ?? c),
  ];
  const shared = list.filter((c) => c.scope === 'SHARED');
  const personal = list.filter((c) => c.scope === 'PERSONAL');
  const done = list.filter((c) => c.done).length;

  const toggle = async (id: string) => {
    try {
      const next = await api.toggleChecklistItem(id);
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 忽略：保持服务端状态 */
    }
  };

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    try {
      const item = await api.createChecklistItem({ tripId, familyId, name });
      setExtra((xs) => [...xs, item]);
      setDraft('');
    } catch {
      /* 忽略：保持服务端状态 */
    }
  };

  return (
    <>
      <Progress done={done} total={list.length} label="整体准备度" />

      {shared.length > 0 && (
        <View className="card card--flush" style={{ marginTop: 12 }}>
          <RowLabel>共享清单</RowLabel>
          {shared.map((c) => (
            <CheckRow key={c.id} item={c} onToggle={(id) => void toggle(id)} />
          ))}
        </View>
      )}

      {personal.length > 0 && (
        <View className="card card--flush">
          <RowLabel>我的清单</RowLabel>
          {personal.map((c) => (
            <CheckRow key={c.id} item={c} onToggle={(id) => void toggle(id)} />
          ))}
        </View>
      )}

      <View className="card card--flush">
        <View className="add-row">
          <Input
            className="add-row__input"
            placeholder="添加物品，如：防晒霜"
            value={draft}
            maxlength={64}
            onInput={(e) => setDraft(e.detail.value)}
          />
          <View
            className={draft.trim() ? 'add-row__btn' : 'add-row__btn add-row__btn--off'}
            onClick={() => void add()}
          >
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>添加</Text>
          </View>
        </View>
      </View>
    </>
  );
}

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Text className="muted" style={{ padding: '10px 14px 6px', fontSize: 11.5, fontWeight: 600 }}>
      {children}
    </Text>
  );
}

function CheckRow({ item, onToggle }: { item: ChecklistItem; onToggle: (id: string) => void }) {
  return (
    <View className={item.done ? 'check check--done' : 'check'} onClick={() => onToggle(item.id)}>
      <Text className="check__box">
        <Icon name={item.done ? 'check' : 'circle'} size={19} />
      </Text>
      <Text className="check__text">{item.title}</Text>
      {item.assigneeName && <Text className="check__who">{item.assigneeName}</Text>}
    </View>
  );
}

function ExpenseTab({ tripId }: { tripId: string }) {
  const list = useAsync(
    useCallback(() => api.listExpenses(tripId), [tripId]),
    [tripId],
  );
  const sum = useAsync(
    useCallback(() => api.expenseSummary(tripId), [tripId]),
    [tripId],
  );

  if (list.loading || sum.loading) return <Loading />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;

  const items = list.data ?? [];
  const s = sum.data;

  const maxMember = Math.max(...(s?.byMember ?? []).map((m) => Number(m.amountCny)), 1);
  const maxCat = Math.max(...(s?.byCategory ?? []).map((m) => Number(m.amountCny)), 1);

  return (
    <>
      <View className="card">
        <View className="money__total">
          <View className="money__num">
            <Text style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-3)', marginRight: 5 }}>
              ¥
            </Text>
            <Text>{s?.totalCny ?? '0.00'}</Text>
          </View>
          <Text className="money__cap">本次出行合计（人民币折算）</Text>
        </View>

        <Text className="section-title" style={{ margin: '0 0 9px' }}>
          按人
        </Text>
        <View className="bars">
          {(s?.byMember ?? []).map((m) => (
            <View className="bar__row" key={m.memberName}>
              <Text className="bar__name">{m.memberName}</Text>
              <View className="bar__track">
                <View
                  className="bar__fill"
                  style={{ width: `${(Number(m.amountCny) / maxMember) * 100}%` }}
                />
              </View>
              <Text className="bar__val">¥{m.amountCny}</Text>
            </View>
          ))}
        </View>

        <Text className="section-title" style={{ margin: '16px 0 9px' }}>
          按类目
        </Text>
        <View className="bars">
          {(s?.byCategory ?? []).map((m) => (
            <View className="bar__row" key={m.category}>
              <Text className="bar__name">{m.category}</Text>
              <View className="bar__track">
                <View
                  className="bar__fill"
                  style={{ width: `${(Number(m.amountCny) / maxCat) * 100}%` }}
                />
              </View>
              <Text className="bar__val">¥{m.amountCny}</Text>
            </View>
          ))}
        </View>
      </View>

      <Text className="section-title">明细（{items.length} 笔）</Text>
      <View className="card card--flush">
        {items.map((e) => (
          <View className="exp" key={e.id}>
            <View className="exp__icon">
              <Icon name="wallet" size={17} />
            </View>
            <View className="exp__body">
              <Text className="exp__title">{e.title}</Text>
              <Text className="exp__sub">
                {e.payerName} · {shortDate(e.spentAt)}
                {e.category ? ` · ${e.category}` : ''}
              </Text>
            </View>
            <Text className="exp__amt">¥{e.amount}</Text>
          </View>
        ))}
      </View>
    </>
  );
}

/**
 * 照片 tab —— 照片墙 + 上传（media 域两段式）
 * Mock 模式下预置照片渲染占位卡（无真实图片字节），
 * 本会话上传的照片用本地临时路径即时渲染（刷新失效，已知局限）。
 */
function PhotoTab({ tripId }: { tripId: string }) {
  const q = useAsync(
    useCallback(() => api.listMedia({ tripId }), [tripId]),
    [tripId],
  );
  /** 本会话上传的本地路径：assetId → tempFilePath */
  const [localPaths, setLocalPaths] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const photos = q.data ?? [];

  const upload = async () => {
    setErr('');
    setBusy(true);
    try {
      const added = await pickAndUploadPhotos(tripId);
      setLocalPaths((m) => {
        const next = { ...m };
        for (const p of added) next[p.asset.id] = p.localPath;
        return next;
      });
      q.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '上传失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteMediaAsset(id);
      q.reload();
    } catch {
      /* 忽略：仅上传者或户主可删，失败时保持原状 */
    }
  };

  return (
    <>
      <View className="photo-grid">
        <View
          className={
            busy ? 'photo-cell photo-cell--add photo-cell--busy' : 'photo-cell photo-cell--add'
          }
          onClick={() => {
            if (!busy) void upload();
          }}
        >
          <Text className="photo-cell__plus">＋</Text>
          <Text className="photo-cell__add-text">{busy ? '上传中…' : '上传照片'}</Text>
        </View>
        {photos.map((p) => {
          const local = localPaths[p.id];
          return (
            <View className="photo-cell" key={p.id}>
              {local ? (
                <Image className="photo-cell__img" src={local} mode="aspectFill" />
              ) : (
                <View className="photo-cell__ph">
                  <Icon name="camera" size={26} />
                  <Text className="photo-cell__ph-date">{shortDate(p.createdAt.slice(0, 10))}</Text>
                </View>
              )}
              <View className="photo-cell__del" onClick={() => void remove(p.id)}>
                <Text className="photo-cell__del-x">×</Text>
              </View>
            </View>
          );
        })}
      </View>
      {err !== '' && <ErrorBox message={err} onRetry={() => void upload()} />}
      <Text className="muted" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        照片归档后仅家庭成员可见；原图位置信息（EXIF GPS）按隐私策略剥离。
      </Text>
    </>
  );
}

/**
 * 回忆 tab —— 出行回忆快照（memory 域，只读 + 生成）
 * 幂等语义：同年 TRIP 回忆已存在则返回既有快照（created=false），不覆盖。
 */
function MemoryTab({ tripId, tripTitle }: { tripId: string; tripTitle: string }) {
  const [gen, setGen] = useState<{
    memory: MemoryArchive;
    snapshot: MemorySnapshot;
    created: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [genErr, setGenErr] = useState('');

  const list = useAsync(
    useCallback(() => api.listMemories({ type: 'TRIP' }), []),
    [],
  );

  // 本页生成的快照优先；否则从列表按标题匹配（列表项只有摘要），再拉完整快照
  const detail = useAsync(
    useCallback(async (): Promise<MemorySnapshot | null> => {
      if (gen) return gen.snapshot;
      const hit = (list.data ?? []).find((m) => m.summary.tripTitle === tripTitle);
      if (!hit) return null;
      const d = await api.getMemory(hit.id);
      return d.snapshot;
    }, [list.data, gen, tripTitle]),
    [list.data, gen, tripTitle],
  );

  const generate = async () => {
    setBusy(true);
    setGenErr('');
    try {
      const r = await api.generateTripMemory(tripId);
      setGen(r);
    } catch (e) {
      setGenErr(e instanceof ApiError ? `${e.message}（code ${e.code}）` : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (list.loading || detail.loading) return <Loading />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;

  const snap = detail.data ?? null;

  return (
    <>
      {snap ? (
        <>
          <MemoryCard
            snapshot={snap}
            note={
              gen !== null && !gen.created && snap.trip !== undefined && snap.trip.id !== tripId
                ? `本年度的出行回忆已存在（来自「${snap.trip.title}」），快照不可覆盖。`
                : undefined
            }
          />
          {gen !== null && gen.created && (
            <Text className="muted" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.6 }}>
              回忆已生成。之后的改动不会影响这篇快照 —— 它定格在生成时刻。
            </Text>
          )}
        </>
      ) : (
        <View className="card memory__empty">
          <Text className="memory__empty-title">还没有回忆</Text>
          <Text className="muted" style={{ fontSize: 12, lineHeight: 1.6, margin: '6px 0 12px' }}>
            出行结束后生成回忆，把成员、安排、花销汇总和照片数定格成一篇不可变的家庭档案。
          </Text>
          <View
            className={busy ? 'add-row__btn add-row__btn--off' : 'add-row__btn'}
            onClick={() => {
              if (!busy) void generate();
            }}
          >
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>
              {busy ? '生成中…' : '生成本次出行回忆'}
            </Text>
          </View>
          {genErr !== '' && <ErrorBox message={genErr} onRetry={() => void generate()} />}
        </View>
      )}
    </>
  );
}

export default TripDetailPage;
