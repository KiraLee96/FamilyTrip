/**
 * 行程详情 —— 按天时间轴 + 准备清单 + 花销（Taro 同构版）
 * ============================================================================
 * 三个板块用标签页切换，避免长滚动。
 * 路由参数从 react-router 的 useParams 改为 nav 抽象层的 useRouteParams。
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Input, Map, Picker, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { useRouteParams } from '../nav';

import { ApiError, api } from '../api/index';
import type {
  ChecklistItem,
  Expense,
  ItineraryItem,
  MemoryArchive,
  MemorySnapshot,
  TransportMode,
} from '../api/types';
import { Icon, TRANSPORT_ICON } from '../components/Icon';
import { MemoryCard } from '../components/MemoryCard';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { Progress, StatusChip, dateRange, shortDate, weekday } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { EXPENSE_CATEGORIES, TRANSPORT_LABEL, TRANSPORT_MODES, todayYmd } from '../utils/constants';
import { pickAndUploadPhotos } from '../utils/upload';

type Tab = 'itinerary' | 'checklist' | 'expense' | 'photo' | 'memory';

/** Taro 编译期内联；用于地图控件的多端分支（小程序原生 Map / H5 降级为路线列表） */
const IS_WEAPP = process.env.TARO_ENV === 'weapp';

/**
 * 地图标记图标（包内绝对路径）。
 * 由 config/index.ts 的 copy.patterns 静态拷贝到 `<outputRoot>/assets/marker.png`，
 * 不能用 import —— webpack 会把 182B 的小图内联成 base64，而小程序地图不认 data URI。
 */
const MARKER_ICON = '/assets/marker.png';

/** 今日 YYYY-MM-DD（新增安排的默认日期兜底） */
function todayStr(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 删除安排：二次确认后调用（反馈 #3 要求可删） */
function removeItinerary(id: string, title: string, onDone: () => void): void {
  void Taro.showModal({
    title: '删除安排',
    content: `确定删除「${title}」？`,
    confirmText: '删除',
    confirmColor: '#e5484d',
  }).then(async (res) => {
    if (!res.confirm) return;
    try {
      await api.deleteItineraryItem(id);
      onDone();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '删除失败', icon: 'none' });
    }
  });
}

export function TripDetailPage() {
  // nav 层生成的 query 参数名是 id（见 src/nav/index.ts 的 toTaroUrl）；
  // tab 支持从 query 定位（如 /trips/101?tab=expense，总览页「查看账本」入口用）
  const params = useRouteParams<{ id: string; tab?: string }>();
  const { id: tripId = '' } = params;
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.tab;
    return t === 'checklist' || t === 'expense' || t === 'photo' || t === 'memory'
      ? t
      : 'itinerary';
  });

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

      {tab === 'itinerary' && (
        <ItineraryTab
          tripId={tripId}
          familyId={t.familyId}
          defaultDate={t.startDate ?? undefined}
        />
      )}
      {tab === 'checklist' && <ChecklistTab tripId={tripId} familyId={t.familyId} />}
      {tab === 'expense' && <ExpenseTab tripId={tripId} familyId={t.familyId} />}
      {tab === 'photo' && <PhotoTab tripId={tripId} />}
      {tab === 'memory' && <MemoryTab tripId={tripId} tripTitle={t.title} />}
    </PageLayout>
  );
}

/**
 * 行程 tab —— 按天时间轴 + 增删改 + 地图标记/连线（反馈 #3/#4）
 * ============================================================================
 * 反馈根因：此前只有只读列表，没有任何写入入口 →「安排无法添加 / 不能修改」。
 * 现在每条安排可编辑、可删除；新增/编辑表单支持地图选点（chooseLocation）、
 * 交通方式，地图控件按时间顺序把带坐标的安排连成路线。
 *
 * 多端：小程序用原生 Map 控件；H5 无地图 JS SDK 依赖，降级为「坐标路线列表」，
 * 渲染同一份 markers/polyline 数据，不 fork 逻辑。
 */
function ItineraryTab({
  tripId,
  familyId,
  defaultDate,
}: {
  tripId: string;
  familyId: string;
  defaultDate?: string;
}) {
  const q = useAsync(
    useCallback(() => api.listItineraries(tripId), [tripId]),
    [tripId],
  );
  const [mode, setMode] = useState<'idle' | 'add'>('idle');
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 地图控件加载失败时降级为坐标列表（H5 / 异常环境） */
  const [mapFailed, setMapFailed] = useState(false);

  const items = q.data ?? [];

  // 带坐标的安排（按时间顺序）→ 地图标记 + 连线
  const pinned = useMemo(
    () =>
      items
        .filter((i) => i.lat !== undefined && i.lng !== undefined)
        .sort((a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder),
    [items],
  );
  const center = useMemo(() => {
    if (pinned.length === 0) return { lat: 39.9042, lng: 116.4074 };
    const sumLat = pinned.reduce((s, i) => s + (i.lat ?? 0), 0);
    const sumLng = pinned.reduce((s, i) => s + (i.lng ?? 0), 0);
    return { lat: sumLat / pinned.length, lng: sumLng / pinned.length };
  }, [pinned]);
  const markers = useMemo(
    () =>
      pinned.map((i, idx) => ({
        id: idx,
        latitude: i.lat ?? 0,
        longitude: i.lng ?? 0,
        title: `${i.startTime ?? ''} ${i.title}`.trim(),
        // 小程序 Map 要求真实文件路径（不支持 data URI / 网络图做标记）
        iconPath: MARKER_ICON,
        width: 26,
        height: 26,
      })),
    [pinned],
  );
  const polyline = useMemo(() => {
    if (pinned.length < 2) return [];
    return [
      {
        points: pinned.map((i) => ({ latitude: i.lat ?? 0, longitude: i.lng ?? 0 })),
        color: '#3b7cff',
        width: 4,
        arrowLine: true,
      },
    ];
  }, [pinned]);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const dates = [...new Set(items.map((i) => i.date))].sort();

  return (
    <>
      {pinned.length >= 1 && (
        <View className="map-card">
          {IS_WEAPP && !mapFailed ? (
            <Map
              className="map-card__canvas"
              latitude={center.lat}
              longitude={center.lng}
              scale={pinned.length > 1 ? 10 : 13}
              markers={markers}
              polyline={polyline}
              // 地图加载失败（无定位权限/组件异常）→ 降级为坐标列表，不空屏
              onError={() => setMapFailed(true)}
            />
          ) : (
            <View className="map-card__canvas map-card__canvas--fallback">
              <Text className="map-card__fb-title">
                <Icon name="map" size={14} /> 路线预览（{pinned.length} 个标记）
              </Text>
              {pinned.map((i, idx) => (
                <View className="map-card__fb-row" key={i.id}>
                  <Text className="map-card__fb-idx">{idx + 1}</Text>
                  <Text className="map-card__fb-name">{i.location ?? i.title}</Text>
                  <Text className="map-card__fb-coord">
                    {(i.lat ?? 0).toFixed(3)}, {(i.lng ?? 0).toFixed(3)}
                  </Text>
                </View>
              ))}
            </View>
          )}
          <View className="map-card__legend">
            {TRANSPORT_MODES.filter((m) => pinned.some((i) => i.transport === m)).map((m) => (
              <Text className="map-card__legend-item" key={m}>
                <Icon name={TRANSPORT_ICON[m]} size={13} />
                {TRANSPORT_LABEL[m]}
              </Text>
            ))}
          </View>
        </View>
      )}

      {items.length === 0 ? (
        <Empty text="还没有安排，点下面按钮加第一条" />
      ) : (
        dates.map((d) => {
          const dayItems = items.filter((i) => i.date === d);
          return (
            <View className="day" key={d}>
              <View className="day__head">
                {shortDate(d)} {weekday(d)}
                <Text className="day__date">{dayItems.length} 项安排</Text>
              </View>
              <View className="tl">
                {dayItems.map((it) =>
                  editingId === it.id ? (
                    <ItineraryForm
                      key={it.id}
                      tripId={tripId}
                      familyId={familyId}
                      defaultDate={d}
                      item={it}
                      onDone={() => {
                        setEditingId(null);
                        q.reload();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <View className="tl__row" key={it.id}>
                      <View className="tl__rail">
                        <View className="tl__dot" />
                        <View className="tl__line" />
                      </View>
                      <View className="tl__card">
                        <View className="tl__card-head">
                          {it.startTime && (
                            <View className="tl__time">
                              <Icon name="clock" size={13} />
                              <Text>{it.startTime}</Text>
                            </View>
                          )}
                          {it.transport && (
                            <Text className="tl__transport">
                              <Icon name={TRANSPORT_ICON[it.transport]} size={13} />
                              {TRANSPORT_LABEL[it.transport]}
                            </Text>
                          )}
                          <View className="tl__ops">
                            <View className="icon-btn" onClick={() => setEditingId(it.id)}>
                              <Icon name="edit" size={14} />
                            </View>
                            <View
                              className="icon-btn icon-btn--danger"
                              onClick={() => removeItinerary(it.id, it.title, q.reload)}
                            >
                              <Icon name="trash" size={14} />
                            </View>
                          </View>
                        </View>
                        <Text className="tl__title">{it.title}</Text>
                        {it.location && (
                          <View className="tl__loc">
                            <Icon name="map-pin" size={13} />
                            <Text>{it.location}</Text>
                            {it.lat !== undefined && it.lng !== undefined ? (
                              <Text className="tl__coord">已标记</Text>
                            ) : null}
                          </View>
                        )}
                        {it.note && <Text className="tl__note">{it.note}</Text>}
                      </View>
                    </View>
                  ),
                )}
              </View>
            </View>
          );
        })
      )}

      {mode === 'add' ? (
        <ItineraryForm
          tripId={tripId}
          familyId={familyId}
          defaultDate={dates[dates.length - 1] ?? defaultDate ?? todayStr()}
          onDone={() => {
            setMode('idle');
            q.reload();
          }}
          onCancel={() => setMode('idle')}
        />
      ) : (
        <View className="add-bar" onClick={() => setMode('add')}>
          <Icon name="plus" size={16} />
          <Text className="add-bar__text">添加安排</Text>
        </View>
      )}
    </>
  );
}

/** 新增 / 编辑安排表单（同一份表单，编辑态传入 item 预填） */
function ItineraryForm({
  tripId,
  familyId,
  defaultDate,
  item,
  onDone,
  onCancel,
}: {
  tripId: string;
  familyId: string;
  defaultDate: string;
  item?: ItineraryItem;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [date, setDate] = useState(item?.date ?? defaultDate);
  const [time, setTime] = useState(item?.startTime ?? '09:00');
  const [location, setLocation] = useState(item?.location ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [transport, setTransport] = useState<TransportMode | ''>(item?.transport ?? '');
  const [lat, setLat] = useState<number | undefined>(item?.lat);
  const [lng, setLng] = useState<number | undefined>(item?.lng);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pickLocation = useCallback(async () => {
    try {
      // 小程序原生选点；H5 端 chooseLocation 不可用，降级为手动填地点
      const res = await Taro.chooseLocation({});
      if (res.name) setLocation(res.name);
      setLat(res.latitude);
      setLng(res.longitude);
    } catch {
      void Taro.showToast({ title: '当前环境不支持地图选点，请手动填写地点', icon: 'none' });
    }
  }, []);

  const submit = useCallback(async () => {
    if (title.trim() === '') {
      setErr('安排标题不能为空');
      return;
    }
    const startAt = `${date}T${time}`;
    setBusy(true);
    setErr('');
    try {
      if (item) {
        await api.updateItineraryItem(item.id, {
          version: item.version,
          title: title.trim(),
          startAt,
          location: location.trim() === '' ? null : location.trim(),
          note: note.trim() === '' ? null : note.trim(),
          lat: lat ?? null,
          lng: lng ?? null,
          transport: transport === '' ? null : transport,
        });
      } else {
        await api.createItineraryItem({
          tripId,
          familyId,
          title: title.trim(),
          startAt,
          ...(location.trim() !== '' ? { location: location.trim() } : {}),
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
          ...(lat !== undefined ? { lat } : {}),
          ...(lng !== undefined ? { lng } : {}),
          ...(transport !== '' ? { transport } : {}),
        });
      }
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [title, date, time, location, note, transport, lat, lng, item, tripId, familyId, onDone]);

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">{item ? '编辑安排' : '添加安排'}</Text>
        <Text className="card__more" onClick={onCancel}>
          取消
        </Text>
      </View>

      <View className="field">
        <Text className="field__label">标题</Text>
        <Input
          className="input"
          value={title}
          onInput={(e) => setTitle(e.detail.value)}
          placeholder="如：崂山一日游"
        />
      </View>

      <View className="row-between" style={{ gap: 10 }}>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">日期</Text>
          <Picker mode="date" value={date} onChange={(e) => setDate(String(e.detail.value))}>
            <View className="picker-row">
              <Text className="picker-row__val">{date}</Text>
            </View>
          </Picker>
        </View>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">时间</Text>
          <Picker mode="time" value={time} onChange={(e) => setTime(String(e.detail.value))}>
            <View className="picker-row">
              <Text className="picker-row__val">{time}</Text>
            </View>
          </Picker>
        </View>
      </View>

      <View className="field">
        <Text className="field__label">地点</Text>
        <View className="add-row" style={{ marginTop: 0 }}>
          <Input
            className="add-row__input"
            value={location}
            onInput={(e) => setLocation(e.detail.value)}
            placeholder="地点名称"
          />
          <View className="add-row__btn" onClick={() => void pickLocation()}>
            <Icon name="map-pin" size={14} />
          </View>
        </View>
        {lat !== undefined && lng !== undefined ? (
          <View className="coord-line">
            <Text className="coord-line__text">
              已标记 {lat.toFixed(4)}, {lng.toFixed(4)}
            </Text>
            <Text
              className="coord-line__clear"
              onClick={() => {
                setLat(undefined);
                setLng(undefined);
              }}
            >
              清除标记
            </Text>
          </View>
        ) : null}
      </View>

      <View className="field">
        <Text className="field__label">交通方式</Text>
        <View className="filter-bar filter-bar--compact">
          {TRANSPORT_MODES.map((m) => (
            <Text
              key={m}
              className={`chip ${transport === m ? 'chip--on' : 'chip--plain'}`}
              onClick={() => setTransport(transport === m ? '' : m)}
            >
              <Icon name={TRANSPORT_ICON[m]} size={13} />
              {TRANSPORT_LABEL[m]}
            </Text>
          ))}
        </View>
      </View>

      <View className="field">
        <Text className="field__label">备注</Text>
        <Input
          className="input"
          value={note}
          onInput={(e) => setNote(e.detail.value)}
          placeholder="如：带足水和防晒"
        />
      </View>

      {err ? <Text className="form-error">{err}</Text> : null}
      <View
        className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : () => void submit()}
      >
        {busy ? '保存中…' : item ? '保存修改' : '添加'}
      </View>
    </View>
  );
}

/**
 * 清单 tab —— 按本次出行隔离（反馈 #5）
 * ============================================================================
 * 反馈根因：此前调用 api.listChecklist()（不带 tripId），跨行程全量返回，
 * 于是「清单默认是之前一个」。改用 listTripChecklist(tripId) 后各行程互不串数据；
 * 新增时显式带上 tripId/scope，并支持删除。
 * 默认几项（往返票 / 住宿 / 证件 / 充电）在新建行程时由 TripCreatePage 播种。
 */
function ChecklistTab({ tripId, familyId }: { tripId: string; familyId: string }) {
  const q = useAsync(
    useCallback(() => api.listTripChecklist(tripId), [tripId]),
    [tripId],
  );
  /** toggle 的本地覆盖（与既有模式一致，避免整表重拉闪烁） */
  const [local, setLocal] = useState<Record<string, ChecklistItem>>({});
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'SHARED' | 'PERSONAL'>('SHARED');
  const [busy, setBusy] = useState(false);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).map((c) => local[c.id] ?? c);
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
    setBusy(true);
    try {
      await api.createChecklistItem({ tripId, familyId, name, scope });
      setDraft('');
      q.reload();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '添加失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Progress done={done} total={list.length} label="整体准备度" />

      {list.length === 0 && <Empty text="还没有清单项。新建行程会自动带上往返票/住宿/证件/充电" />}

      {shared.length > 0 && (
        <View className="card card--flush" style={{ marginTop: 12 }}>
          <RowLabel>共享清单（{shared.length}）</RowLabel>
          {shared.map((c) => (
            <CheckRow
              key={c.id}
              item={c}
              onToggle={(id) => void toggle(id)}
              onDelete={() => removeChecklist(c.id, c.title, q.reload)}
            />
          ))}
        </View>
      )}

      {personal.length > 0 && (
        <View className="card card--flush">
          <RowLabel>我的清单（{personal.length}）</RowLabel>
          {personal.map((c) => (
            <CheckRow
              key={c.id}
              item={c}
              onToggle={(id) => void toggle(id)}
              onDelete={() => removeChecklist(c.id, c.title, q.reload)}
            />
          ))}
        </View>
      )}

      <View className="card card--flush">
        <View className="filter-bar filter-bar--compact" style={{ padding: '0 14px 8px' }}>
          <Text
            className={`chip ${scope === 'SHARED' ? 'chip--on' : 'chip--plain'}`}
            onClick={() => setScope('SHARED')}
          >
            共享
          </Text>
          <Text
            className={`chip ${scope === 'PERSONAL' ? 'chip--on' : 'chip--plain'}`}
            onClick={() => setScope('PERSONAL')}
          >
            仅我自己
          </Text>
        </View>
        <View className="add-row">
          <Input
            className="add-row__input"
            placeholder="添加物品，如：防晒霜"
            value={draft}
            maxlength={64}
            onInput={(e) => setDraft(e.detail.value)}
          />
          <View
            className={draft.trim() && !busy ? 'add-row__btn' : 'add-row__btn add-row__btn--off'}
            onClick={busy ? undefined : () => void add()}
          >
            <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>
              {busy ? '…' : '添加'}
            </Text>
          </View>
        </View>
      </View>
    </>
  );
}

/** 删除清单项（二次确认） */
function removeChecklist(id: string, title: string, onDone: () => void): void {
  void Taro.showModal({
    title: '删除清单项',
    content: `确定删除「${title}」？`,
    confirmText: '删除',
    confirmColor: '#e5484d',
  }).then(async (res) => {
    if (!res.confirm) return;
    try {
      await api.deleteChecklistItem(id);
      onDone();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '删除失败', icon: 'none' });
    }
  });
}

function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Text className="muted" style={{ padding: '10px 14px 6px', fontSize: 11.5, fontWeight: 600 }}>
      {children}
    </Text>
  );
}

function CheckRow({
  item,
  onToggle,
  onDelete,
}: {
  item: ChecklistItem;
  onToggle: (id: string) => void;
  onDelete: () => void;
}) {
  return (
    <View className={item.done ? 'check check--done' : 'check'} onClick={() => onToggle(item.id)}>
      <Text className="check__box">
        <Icon name={item.done ? 'check' : 'circle'} size={19} />
      </Text>
      <Text className="check__text">{item.title}</Text>
      {item.assigneeName && <Text className="check__who">{item.assigneeName}</Text>}
      <View
        className="icon-btn icon-btn--danger"
        onClick={(e) => {
          // 阻止冒泡，避免误触发整行勾选
          e.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="close" size={13} />
      </View>
    </View>
  );
}

/**
 * 花销 tab —— 汇总 + 明细 + 记账（反馈 #6）
 * ============================================================================
 * 反馈根因：只有汇总和明细，没有「记一笔」入口 → 用户找不到录花销的地方。
 * 现在支持新增 / 编辑 / 删除，金额以「主单位字符串」提交（后端按币种精度折算落库），
 * 每次写操作后同时刷新明细与汇总，合计即时跟随。
 */
function ExpenseTab({ tripId, familyId }: { tripId: string; familyId: string }) {
  const list = useAsync(
    useCallback(() => api.listExpenses(tripId), [tripId]),
    [tripId],
  );
  const sum = useAsync(
    useCallback(() => api.expenseSummary(tripId), [tripId]),
    [tripId],
  );
  const [mode, setMode] = useState<'idle' | 'add'>('idle');
  const [editingId, setEditingId] = useState<string | null>(null);

  if (list.loading || sum.loading) return <Loading />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;

  const items = list.data ?? [];
  const s = sum.data;
  const reloadAll = (): void => {
    list.reload();
    sum.reload();
  };

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

        {(s?.byMember ?? []).length > 0 && (
          <>
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
          </>
        )}

        {(s?.byCategory ?? []).length > 0 && (
          <>
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
          </>
        )}
      </View>

      <Text className="section-title">明细（{items.length} 笔）</Text>
      <View className="card card--flush">
        {items.length === 0 ? (
          <Empty text="还没有记账，点下面按钮记一笔" />
        ) : (
          items.map((e) =>
            editingId === e.id ? (
              <ExpenseForm
                key={e.id}
                tripId={tripId}
                familyId={familyId}
                expense={e}
                onDone={() => {
                  setEditingId(null);
                  reloadAll();
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <View className="exp" key={e.id}>
                <View className="exp__icon">
                  <Icon name="wallet" size={17} />
                </View>
                <View className="exp__body">
                  <Text className="exp__title">{e.title}</Text>
                  <Text className="exp__sub">
                    {e.payerName} · {shortDate(e.spentAt)}
                    {e.category ? ` · ${e.category}` : ''}
                    {e.note ? ` · ${e.note}` : ''}
                  </Text>
                </View>
                <Text className="exp__amt">¥{e.amount}</Text>
                <View className="icon-btn" onClick={() => setEditingId(e.id)}>
                  <Icon name="edit" size={14} />
                </View>
                <View
                  className="icon-btn icon-btn--danger"
                  onClick={() => removeExpense(e.id, e.title, reloadAll)}
                >
                  <Icon name="trash" size={14} />
                </View>
              </View>
            ),
          )
        )}
      </View>

      {mode === 'add' ? (
        <ExpenseForm
          tripId={tripId}
          familyId={familyId}
          onDone={() => {
            setMode('idle');
            reloadAll();
          }}
          onCancel={() => setMode('idle')}
        />
      ) : (
        <View className="add-bar" onClick={() => setMode('add')}>
          <Icon name="plus" size={16} />
          <Text className="add-bar__text">记一笔花销</Text>
        </View>
      )}
    </>
  );
}

/** 新增 / 编辑花销表单（编辑态传入 expense 预填） */
function ExpenseForm({
  tripId,
  familyId,
  expense,
  onDone,
  onCancel,
}: {
  tripId: string;
  familyId: string;
  expense?: Expense;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(expense?.title ?? '');
  const [amount, setAmount] = useState(expense?.amount ?? '');
  const [category, setCategory] = useState(expense?.category ?? '');
  const [spentAt, setSpentAt] = useState(expense?.spentAt.slice(0, 10) ?? todayYmd());
  const [note, setNote] = useState(expense?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = useCallback(async () => {
    const amt = amount.trim();
    if (title.trim() === '') {
      setErr('花费名称不能为空');
      return;
    }
    if (!/^\d+(\.\d+)?$/.test(amt)) {
      setErr('金额须为非负数字，如 368.00');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      if (expense) {
        await api.updateExpense(expense.id, {
          title: title.trim(),
          amount: amt,
          category: category === '' ? null : category,
          spentAt,
          note: note.trim() === '' ? null : note.trim(),
        });
      } else {
        await api.createExpense({
          tripId,
          familyId,
          title: title.trim(),
          amount: amt,
          ...(category !== '' ? { category } : {}),
          spentAt,
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
        });
      }
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [title, amount, category, spentAt, note, expense, tripId, familyId, onDone]);

  return (
    <View className={expense ? 'card expense-edit' : 'card'}>
      <View className="card__head">
        <Text className="card__title">{expense ? '编辑花销' : '记一笔花销'}</Text>
        <Text className="card__more" onClick={onCancel}>
          取消
        </Text>
      </View>

      <View className="field">
        <Text className="field__label">花费名称</Text>
        <Input
          className="input"
          value={title}
          onInput={(e) => setTitle(e.detail.value)}
          placeholder="如：海鲜晚餐"
        />
      </View>

      <View className="row-between" style={{ gap: 10 }}>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">金额（元）</Text>
          <Input
            className="input"
            type="digit"
            value={amount}
            onInput={(e) => setAmount(e.detail.value)}
            placeholder="0.00"
          />
        </View>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">日期</Text>
          <Picker mode="date" value={spentAt} onChange={(e) => setSpentAt(String(e.detail.value))}>
            <View className="picker-row">
              <Text className="picker-row__val">{spentAt}</Text>
            </View>
          </Picker>
        </View>
      </View>

      <View className="field">
        <Text className="field__label">类目</Text>
        <View className="filter-bar filter-bar--compact">
          {EXPENSE_CATEGORIES.map((c) => (
            <Text
              key={c}
              className={`chip ${category === c ? 'chip--on' : 'chip--plain'}`}
              onClick={() => setCategory(category === c ? '' : c)}
            >
              {c}
            </Text>
          ))}
        </View>
      </View>

      <View className="field">
        <Text className="field__label">备注</Text>
        <Input
          className="input"
          value={note}
          onInput={(e) => setNote(e.detail.value)}
          placeholder="可选"
        />
      </View>

      {err ? <Text className="form-error">{err}</Text> : null}
      <View
        className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : () => void submit()}
      >
        {busy ? '保存中…' : expense ? '保存修改' : '记下这笔'}
      </View>
    </View>
  );
}

/** 删除花销（二次确认；汇总会在 reload 后自动重算） */
function removeExpense(id: string, title: string, onDone: () => void): void {
  void Taro.showModal({
    title: '删除花销',
    content: `确定删除「${title}」？`,
    confirmText: '删除',
    confirmColor: '#e5484d',
  }).then(async (res) => {
    if (!res.confirm) return;
    try {
      await api.deleteExpense(id);
      onDone();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '删除失败', icon: 'none' });
    }
  });
}

/**
 * 照片 tab —— 照片墙 + 上传（media 域两段式）
 * 图片地址三级降级链（优先可用者）：
 *   1. localPaths  —— 本会话刚上传的本地临时路径，零延迟立即可见；
 *   2. asset.url   —— 真后端拼接的持久 URL（方案 A，MEDIA_PUBLIC_BASE_URL+fileKey）；
 *   3. 占位卡       —— Mock 模式 url 为空，或远程图加载失败（onError 降级，不破图）。
 */
function PhotoTab({ tripId }: { tripId: string }) {
  const q = useAsync(
    useCallback(() => api.listMedia({ tripId }), [tripId]),
    [tripId],
  );
  /** 本会话上传的本地路径：assetId → tempFilePath */
  const [localPaths, setLocalPaths] = useState<Record<string, string>>({});
  /** 远程图加载失败的 assetId 集合（域名不可达等）→ 降级占位，不破图 */
  const [brokenUrls, setBrokenUrls] = useState<Record<string, boolean>>({});
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
          // 三级降级：本会话本地路径 > 真后端持久 URL（未加载失败时）> 占位卡
          const src = localPaths[p.id] ?? (brokenUrls[p.id] ? '' : p.url);
          return (
            <View className="photo-cell" key={p.id}>
              {src !== '' ? (
                <Image
                  className="photo-cell__img"
                  src={src}
                  mode="aspectFill"
                  onError={() => setBrokenUrls((m) => (m[p.id] ? m : { ...m, [p.id]: true }))}
                />
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
