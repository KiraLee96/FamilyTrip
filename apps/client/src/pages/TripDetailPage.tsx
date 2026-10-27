/**
 * 行程详情 —— 只放「内容」：按天时间轴 + 清单 + 花销 + 照片 + 回忆
 * ============================================================================
 * 2026-10-26 信息架构调整：邀请码与参与人（「谁能来」）不再各占一张卡长在页首，
 * 统一收进 `pages/TripManagePage`（行程管理），页首信息卡只留一条入口。
 * 详情页的职责因此更单一：进来就是看内容，管理动作去管理页。
 *
 * 路由参数从 react-router 的 useParams 改为 nav 抽象层的 useRouteParams。
 */

import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Input, Map, Picker, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { navigate, useRouteParams } from '../nav';

import { ApiError, api } from '../api/index';
import type {
  ChecklistItem,
  ChecklistTemplate,
  Destination,
  Expense,
  ItineraryBlock,
  ItineraryItem,
  MemoryArchive,
  MemorySnapshot,
  TransportMode,
  Trip,
} from '../api/types';
import { DateRangeSheet } from '../components/Calendar';
import { BillImportSheet } from '../components/BillImportSheet';
import { Icon, TRANSPORT_ICON } from '../components/Icon';
import { ItineraryContent } from '../components/ItineraryContent';
import { MemoryCard } from '../components/MemoryCard';
import { TripPosterSheet } from '../components/TripPosterSheet';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { RegionSheet } from '../components/RegionPicker';
import { Progress, StatusChip, dateRange, shortDate, weekday } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { rangeText } from '../utils/calendar';
import {
  EXPENSE_CATEGORIES,
  TRANSPORT_LABEL,
  TRANSPORT_MODES,
  backendOutdatedHint,
  photoWriteHint,
  todayYmd,
  tripDisplayStatus,
  tripIsEnded,
} from '../utils/constants';
import { previewPhotos } from '../utils/preview';
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

/**
 * 安排正文块上限 —— 与派发单 D-2026-10-15-01 的后端校验口径一致（≤20）。
 * 前端先拦一次是为了给出即时反馈，服务端仍会独立校验（不信任客户端）。
 */
const MAX_BLOCKS = 20;

/** 删除行程（二次确认后调用；服务端 DELETE /trips/:id 早已存在） */
function removeTrip(tripId: string, title: string, onDone: () => void): void {
  void Taro.showModal({
    title: '删除行程',
    content: `确定删除「${title}」？该行程的安排、清单、花销将一并移除，且不可恢复。`,
    confirmText: '删除',
    confirmColor: '#e5484d',
  }).then(async (res) => {
    if (!res.confirm) return;
    try {
      await api.deleteTrip(tripId);
      void Taro.showToast({ title: '行程已删除', icon: 'none' });
      onDone();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '删除失败', icon: 'none' });
    }
  });
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
  // tab 支持从 query 定位（如 /trips/101?tab=expense，总览页「查看账本」入口用）；
  // readonly=1 表示从回忆墙进入（2026-10-16 需求②：只读，不能改不能删）
  const params = useRouteParams<{ id: string; tab?: string; readonly?: string }>();
  const { id: tripId = '' } = params;
  const readonly = params.readonly === '1' || params.readonly === 'true';
  const [tab, setTab] = useState<Tab>(() => {
    const t = params.tab;
    return t === 'checklist' || t === 'expense' || t === 'photo' || t === 'memory'
      ? t
      : 'itinerary';
  });

  const trip = useAsync(
    useCallback(() => api.getTripDetail(tripId), [tripId]),
    [tripId],
  );

  /** 编辑行程（标题 / 起止日期 / 目的地）内联表单开关 */
  const [editingTrip, setEditingTrip] = useState(false);
  /** 行程长图弹层（已结束行程的分享入口，2026-10-26 反馈第 4 条） */
  const [posterOpen, setPosterOpen] = useState(false);
  /**
   * 本会话上传图片的本地临时路径（assetId → tempFilePath）。
   * 提出到页面级而非表单内：表单提交后会被卸载，页面重拉数据时图片块只剩
   * assetId，Mock/离线环境下 url 为空 → 靠这份映射让刚传的图立即显示，
   * 不必等真实对象存储下发 URL（见 components/ItineraryContent 的降级链）。
   */
  const [localImages, setLocalImages] = useState<Record<string, string>>({});
  const rememberImage = useCallback((assetId: string, localPath: string) => {
    setLocalImages((m) => ({ ...m, [assetId]: localPath }));
  }, []);

  // 2026-10-26：邀请码/参与人搬到独立的「行程管理」页（TripManagePage），
  // 详情页不再注册 useShareAppMessage —— 分享带码的入口统一在管理页，
  // 避免详情页出现一个"分享出去不带码"的转发卡片（上一轮反馈 4 的同类坑）。

  if (trip.loading) return <Loading />;
  if (trip.error) return <ErrorBox message={trip.error} onRetry={trip.reload} />;
  // 🆕 改用 getTripDetail：后端一直回 members，此前客户端只投影 trip，
  //    导致「加入行程后看不到参与人」（反馈 2）。
  const detail = trip.data!;
  const t = detail.trip;
  const tripMembers = detail.members;

  /**
   * 只读口径（2026-10-26 二次调整，反馈「已结束不能再新增安排」）。
   * ==========================================================================
   * 三个来源，分三档本应是两档，但「安排」被单独收紧：
   *   · closed  —— 服务端已归档（FINISHED/CANCELLED）：信息类全部锁定；
   *   · ended   —— **日期已过但服务端还没流转**（派生，见 tripIsEnded）：
   *               只锁「行程信息」，清单/花销仍可补录 —— 用户出行回来第一件事
   *               就是补记账，这一档不能锁死；
   *   · readonly —— 从回忆墙进入：信息只读（与 closed 同档展示）。
   *
   * 🔴 2026-10-26 变更：用户明确「行程已结束就不能再新增安排了」。
   *    此前安排只认 `closed`，于是「日期已过、自动完结任务还没扫到」的窗口期里
   *    仍能加安排 —— 用户看到的正是这个窗口。现在安排额外认 `ended`：
   *    只要日期过了就只读，不等服务端状态流转。
   *    清单/花销**不跟着收紧**（补勾打包项、补记最后一笔是刚需，用户未要求锁）。
   *
   * 🔴 照片是唯一例外：用户明确要求「已完成的行程……只能添加或删除回忆照片」，
   *    所以照片 tab **不再接 readonly**，任何状态下都保留上传/删除入口
   *    （后端归档后媒体写已放开，见派发单 D-2026-10-26-02 P0-2 / aabd435）。
   */
  const closed = t.status === 'FINISHED' || t.status === 'CANCELLED';
  const ended = tripIsEnded(t);
  /** 信息类写操作是否锁定（标题/日期/目的地/删除行程） */
  const ro = readonly || closed || ended;
  /** 内容类写操作（清单/花销）是否锁定 —— 只认服务端归档态 */
  const contentRo = readonly || closed;
  /** 安排类写操作是否锁定 —— 日期过了就锁，不等状态流转（本轮反馈） */
  const itineraryRo = readonly || closed || ended;

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

      {/* 只读提示：区分「回忆墙入口」「已归档」「日期已过」三种来源，明示原因 */}
      {ro && (
        <View className="readonly-banner">
          <Icon name="route" size={14} />
          <Text>
            {closed
              ? '行程已结束：信息锁定，仅可回看与补充回忆照片'
              : readonly
                ? '来自回忆墙的行程仅可查看，不能修改'
                : '行程日期已过：信息锁定，仍可在下方补记花销与照片'}
          </Text>
        </View>
      )}

      {/* 日期已过但服务端还没流转 → 给一个明确的落库动作（不替用户改库） */}
      {ended && !closed && (
        <FinishTripBar tripId={tripId} version={t.version} onDone={trip.reload} />
      )}

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
          <StatusChip status={tripDisplayStatus(t)} />
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

        {/*
          行程管理入口（2026-10-26 信息架构调整）：
          邀请码与参与人不再各占一张卡，统一收进「行程管理」页；
          这里只留一条可点的信息行，点整行进入管理页。
        */}
        <View className="trip__manage" onClick={() => navigate(`/trips/${tripId}/manage`)}>
          <View className="trip__manage-main">
            <Text className="trip__manage-count">
              <Icon name="users" size={14} /> {tripMembers.length} 人同行
            </Text>
            <Text className="trip__manage-names">
              {tripMembers
                .slice(0, 4)
                .map((m) => m.displayName)
                .join('、')}
              {tripMembers.length > 4 ? ' 等' : ''}
            </Text>
          </View>
          <Text className="trip__manage-go">行程管理 ›</Text>
        </View>

        {/*
          邀请同行人：直达管理页的邀请区块（她要求"最上面加一个按钮"）。
          🔴 已结束（closed 或 ended）时**不再给邀请入口**（2026-10-26 反馈第 4 条），
             改为「分享行程长图」—— 结束的行程只分享安排，不招募同行者。
        */}
        <View className="trip__ops">
          {closed || ended ? (
            <View className="btn btn--ghost trip__op" onClick={() => setPosterOpen(true)}>
              <Icon name="share" size={13} />
              分享行程长图
            </View>
          ) : (
            <View
              className="btn btn--ghost trip__op trip__op--accent"
              onClick={() => navigate(`/trips/${tripId}/manage`)}
            >
              <Icon name="link" size={13} />
              邀请同行人
            </View>
          )}
          {!ro && (
            <View className="btn btn--ghost trip__op" onClick={() => setEditingTrip((v) => !v)}>
              <Icon name="edit" size={13} />
              {editingTrip ? '收起编辑' : '编辑行程'}
            </View>
          )}
        </View>

        {!ro && (
          <View className="trip__ops" style={{ marginTop: 8 }}>
            <View
              className="btn btn--ghost trip__op trip__op--danger"
              onClick={() => removeTrip(tripId, t.title, () => navigate('/trips'))}
            >
              <Icon name="trash" size={13} />
              删除行程
            </View>
            <View className="btn btn--ghost trip__op" onClick={() => navigate('/trips/new')}>
              <Icon name="plus" size={13} />
              再建一场
            </View>
          </View>
        )}
      </View>

      {editingTrip && !ro && (
        <TripForm
          trip={t}
          onDone={() => {
            setEditingTrip(false);
            trip.reload();
          }}
          onCancel={() => setEditingTrip(false)}
        />
      )}

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
          localImages={localImages}
          onImageUploaded={rememberImage}
          readonly={itineraryRo}
        />
      )}
      {tab === 'checklist' && (
        <ChecklistTab tripId={tripId} familyId={t.familyId} readonly={contentRo} />
      )}
      {tab === 'expense' && (
        <ExpenseTab
          tripId={tripId}
          familyId={t.familyId}
          readonly={contentRo}
          trip={t}
          onTripChanged={trip.reload}
        />
      )}
      {/* 照片：任何状态都允许加/删（用户明确要求「已完成的行程只能添加或删除回忆照片」） */}
      {tab === 'photo' && <PhotoTab tripId={tripId} />}
      {tab === 'memory' && <MemoryTab tripId={tripId} tripTitle={t.title} readonly={ro} />}

      {posterOpen && (
        <TripPosterSheet tripId={tripId} tripTitle={t.title} onClose={() => setPosterOpen(false)} />
      )}
    </PageLayout>
  );
}

/**
 * 编辑行程表单 —— 改标题 / 起止日期 / 目的地（PATCH /trips/:id，E7 CAS）
 * ============================================================================
 * 服务端 updateTripSchema 早已支持这四个字段，此前只有服务端能力、没有界面入口
 * （用户反馈「行程本身改不了日期目的地」）。本表单只走一条写路径：
 *   · version 原样回传当前位置（详情页刚拉的 trip.version）；
 *   · 日期清空 → 传 null（后端 nullable 语义，非「不更新」）；
 *   · destinations 整体替换语义（与后端数组字段一致，不做增量合并）；
 *   · 409（版本冲突）由信封上抛，提示刷新后重试 —— 并发保护的正常出口。
 */
function TripForm({
  trip,
  onDone,
  onCancel,
}: {
  trip: Trip;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(trip.title);
  const [startDate, setStartDate] = useState(trip.startDate ?? '');
  const [endDate, setEndDate] = useState(trip.endDate ?? '');
  const [dests, setDests] = useState<Destination[]>(trip.destinations ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 区间日历抽屉开关（替换原生的两个 date picker） */
  const [rangeOpen, setRangeOpen] = useState(false);
  /** 地区选择抽屉：regionOpen 控制显隐，regionIdx 记录「改哪一行」（null = 新增） */
  const [regionOpen, setRegionOpen] = useState(false);
  const [regionIdx, setRegionIdx] = useState<number | null>(null);

  const openRegionFor = (idx: number | null): void => {
    setRegionIdx(idx);
    setRegionOpen(true);
  };

  const setDest = (idx: number, patch: Partial<Destination>): void => {
    setDests((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const submit = useCallback(async () => {
    const name = title.trim();
    if (name === '') {
      setErr('行程标题不能为空');
      return;
    }
    // 起止倒置是最常见的误操作，本地先拦一次（服务端不做顺序校验，避免误伤单边日期）
    if (startDate !== '' && endDate !== '' && endDate < startDate) {
      setErr('结束日期不能早于开始日期');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.updateTrip(trip.id, {
        version: trip.version,
        title: name,
        startDate: startDate === '' ? null : startDate,
        endDate: endDate === '' ? null : endDate,
        destinations: dests
          .map((d) => {
            const dn = d.name.trim();
            const note = (d.note ?? '').trim();
            return {
              name: dn,
              ...(note !== '' ? { note } : {}),
            };
          })
          .filter((d) => d.name !== ''),
      });
      onDone();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [title, startDate, endDate, dests, trip, onDone]);

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">编辑行程</Text>
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
          placeholder="如：2026 春节·马来西亚"
        />
      </View>

      <View className="field">
        <Text className="field__label">出行日期</Text>
        <View className="picker-row" onClick={() => setRangeOpen(true)}>
          <Text
            className={
              startDate === '' && endDate === ''
                ? 'picker-row__val picker-row__val--empty'
                : 'picker-row__val'
            }
          >
            {rangeText(startDate, endDate) || '点选出发与返程日期'}
          </Text>
          <Icon name="chevron-right" size={16} className="rotate-90 muted" />
        </View>
      </View>
      {(startDate !== '' || endDate !== '') && (
        <Text
          className="coord-line__clear"
          style={{ marginTop: 4 }}
          onClick={() => {
            setStartDate('');
            setEndDate('');
          }}
        >
          清除起止日期
        </Text>
      )}

      <View className="field">
        <Text className="field__label">目的地</Text>
        {dests.map((d, idx) => (
          <View className="dest-row" key={`d-${idx}`}>
            <View className="dest-row__main">
              <View className="dest-row__pick" onClick={() => openRegionFor(idx)}>
                <Icon name="map-pin" size={12} className="muted" />
                <Text
                  className={
                    d.name === '' ? 'dest-row__name dest-row__name--empty' : 'dest-row__name'
                  }
                >
                  {d.name === '' ? '点选地区' : d.name}
                </Text>
                <Icon name="chevron-right" size={13} className="rotate-90 muted" />
              </View>
              <Input
                className="add-row__input"
                value={d.note ?? ''}
                onInput={(e) => setDest(idx, { note: e.detail.value })}
                placeholder="备注（选填），如：住在老城区"
              />
            </View>
            <View
              className="icon-btn icon-btn--danger"
              onClick={() => setDests((prev) => prev.filter((_, i) => i !== idx))}
            >
              <Icon name="close" size={13} />
            </View>
          </View>
        ))}
        <View className="add-bar" onClick={() => openRegionFor(null)}>
          <Icon name="plus" size={15} />
          <Text className="add-bar__text">添加目的地地区</Text>
        </View>
      </View>

      {err ? <Text className="form-error">{err}</Text> : null}
      <View
        className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : () => void submit()}
      >
        {busy ? '保存中…' : '保存行程信息'}
      </View>
      <Text className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
        保存会带上当前版本号 v{trip.version}；若期间有人改过这场行程，会提示刷新后重试。
      </Text>

      {rangeOpen && (
        <DateRangeSheet
          title="出行日期"
          initialStart={startDate}
          initialEnd={endDate}
          onCancel={() => setRangeOpen(false)}
          onConfirm={(s, e) => {
            setStartDate(s);
            setEndDate(e);
            setRangeOpen(false);
          }}
        />
      )}

      {regionOpen && (
        <RegionSheet
          title={regionIdx === null ? '添加目的地地区' : '修改目的地地区'}
          initialCity={regionIdx === null ? '' : (dests[regionIdx]?.name ?? '')}
          onCancel={() => setRegionOpen(false)}
          onConfirm={(city) => {
            setDests((prev) =>
              regionIdx === null
                ? [...prev, { name: city }]
                : prev.map((d, i) => (i === regionIdx ? { ...d, name: city } : d)),
            );
            setRegionOpen(false);
          }}
        />
      )}
    </View>
  );
}

/**
 * 「行程日期已过、但服务端状态还停在计划中」的落库入口（2026-10-26）。
 * ============================================================================
 * 背景：用户要求「行程的时间结束后要自动变成已完成」。真正的自动流转属于服务端
 * 职责（定时/惰性），客户端不能替用户改库 —— 见派发单 D-2026-10-26-02 P0-1。
 * 但在这之前，界面不能只是"假装已完成"：那会让列表徽章与真实状态长期背离。
 * 因此这里给一个明确的动作：告诉用户「日期已过」，并提供一键落库（POST /trips/:id/finish）。
 * 服务端补上自动流转后，本提示条自然不再出现（ended && !closed 恒为 false）。
 */
function FinishTripBar({
  tripId,
  version,
  onDone,
}: {
  tripId: string;
  version: number;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const finish = useCallback(() => {
    void Taro.showModal({
      title: '标记为已完成',
      content:
        '行程日期已经结束。标记后这场行程转只读归档，仍可补记花销与上传回忆照片，但不能再改行程信息。',
      confirmText: '标记完成',
    }).then(async (res) => {
      if (!res.confirm) return;
      setBusy(true);
      try {
        await api.finishTrip(tripId, version);
        void Taro.showToast({ title: '已标记为完成', icon: 'none' });
        onDone();
      } catch (e: unknown) {
        // 带上后端错误码：500 只回「服务内部错误」时，没码就完全无法定位
        const msg = e instanceof Error ? e.message : '标记失败';
        const code = e instanceof ApiError ? `（code ${e.code}）` : '';
        void Taro.showToast({ title: `${msg}${code}`, icon: 'none' });
      } finally {
        setBusy(false);
      }
    });
  }, [tripId, version, onDone]);

  return (
    <View className="finish-bar">
      <View className="finish-bar__body">
        <Text className="finish-bar__title">这场行程的日期已经结束</Text>
        <Text className="finish-bar__sub">标记完成会归档为只读档案（照片仍可补传）</Text>
      </View>
      <View
        className={`btn btn--ghost finish-bar__btn ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : finish}
      >
        {busy ? '处理中…' : '标记完成'}
      </View>
    </View>
  );
}

/**
 * 安排时间段文案：有结束时间显示「HH:mm-HH:mm」，否则单时间（参考截图样式）。
 * 都没有（用户清掉了时间）时返回空串，卡片不渲染时间位。
 */
function timeText(it: ItineraryItem): string {
  if (it.startTime && it.endTime) return `${it.startTime}-${it.endTime}`;
  return it.startTime ?? it.endTime ?? '';
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
  localImages,
  onImageUploaded,
  readonly = false,
}: {
  tripId: string;
  familyId: string;
  defaultDate?: string;
  /** 本会话上传图片的本地路径（assetId → tempFilePath），透传给卡片渲染 */
  localImages: Record<string, string>;
  onImageUploaded: (assetId: string, localPath: string) => void;
  /** 回忆墙只读入口：隐藏单条编辑/删除与「添加安排」，仅可查看 */
  readonly?: boolean;
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
        title: `${timeText(i)} ${i.title}`.trim(),
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
        <Empty text={readonly ? '这场行程还没有安排' : '还没有安排，点下面按钮加第一条'} />
      ) : (
        dates.map((d, dayIdx) => {
          const dayItems = items.filter((i) => i.date === d);
          return (
            <View className="day" key={d}>
              <View className="day__head">
                <Text className="day__no">第{dayIdx + 1}天</Text>
                <Text className="day__date">
                  （{shortDate(d)}）{weekday(d)} · {dayItems.length} 项安排
                </Text>
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
                      localImages={localImages}
                      onImageUploaded={onImageUploaded}
                      onDone={() => {
                        setEditingId(null);
                        q.reload();
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <View className="tl__card" key={it.id}>
                      <View className="tl__card-head">
                        {timeText(it) !== '' && <Text className="tl__time">{timeText(it)}</Text>}
                        <Text className="tl__title">{it.title}</Text>
                        {!readonly && (
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
                        )}
                      </View>
                      {it.transport && (
                        <View className="tl__meta">
                          <Text className="tl__transport">
                            <Icon name={TRANSPORT_ICON[it.transport]} size={13} />
                            {TRANSPORT_LABEL[it.transport]}
                          </Text>
                        </View>
                      )}
                      {it.location && (
                        <View className="tl__loc">
                          <Icon name="map-pin" size={12} />
                          <Text className="tl__loc-text">{it.location}</Text>
                          {it.lat !== undefined && it.lng !== undefined ? (
                            <Text className="tl__coord">已标记</Text>
                          ) : null}
                        </View>
                      )}
                      {/* 老数据（只有 note、无 blocks）沿用旧样式；有 blocks 时由组件统一渲染 */}
                      {it.note !== undefined && it.note !== '' && it.blocks === undefined && (
                        <Text className="tl__note">{it.note}</Text>
                      )}
                      {/* 正文块（富文本/图片混排）；老数据只有 note 时由组件内部兜底为单段 */}
                      <ItineraryContent
                        blocks={it.blocks}
                        fallbackText={it.note}
                        localImagePaths={localImages}
                      />
                    </View>
                  ),
                )}
              </View>
            </View>
          );
        })
      )}

      {readonly ? null : mode === 'add' ? (
        <ItineraryForm
          tripId={tripId}
          familyId={familyId}
          defaultDate={dates[dates.length - 1] ?? defaultDate ?? todayStr()}
          localImages={localImages}
          onImageUploaded={onImageUploaded}
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

/**
 * 图片块缩略图（编辑态）—— 与卡片渲染同一条降级链：
 * 本会话本地路径 > 服务端 url > 占位图（Mock 无对象存储时走占位，不破图）。
 */
function BlockThumb({
  assetId,
  url,
  paths,
}: {
  assetId?: string;
  url?: string;
  paths: Record<string, string>;
}) {
  const src = (assetId !== undefined ? paths[assetId] : undefined) ?? url ?? '';
  return src !== '' ? (
    <Image className="blk-edit__thumb" src={src} mode="aspectFill" />
  ) : (
    <View className="blk-edit__thumb blk-edit__thumb--ph">
      <Icon name="camera" size={18} />
    </View>
  );
}

/** 新增 / 编辑安排表单（同一份表单，编辑态传入 item 预填） */
function ItineraryForm({
  tripId,
  familyId,
  defaultDate,
  item,
  localImages,
  onImageUploaded,
  onDone,
  onCancel,
}: {
  tripId: string;
  familyId: string;
  defaultDate: string;
  item?: ItineraryItem;
  /** 本会话已上传图片的本地路径（assetId → tempFilePath），用于缩略图即时预览 */
  localImages: Record<string, string>;
  onImageUploaded: (assetId: string, localPath: string) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [date, setDate] = useState(item?.date ?? defaultDate);
  const [time, setTime] = useState(item?.startTime ?? '09:00');
  const [endTime, setEndTime] = useState(item?.endTime ?? '');
  const [location, setLocation] = useState(item?.location ?? '');
  const [note, setNote] = useState(item?.note ?? '');
  const [transport, setTransport] = useState<TransportMode | ''>(item?.transport ?? '');
  const [lat, setLat] = useState<number | undefined>(item?.lat);
  const [lng, setLng] = useState<number | undefined>(item?.lng);
  /**
   * 正文块（富文本/图片）—— 整体替换语义：提交时全量下发，传空数组即清空。
   * 编辑态从 item.blocks 预填；图片块的本地预览路径由页面级 localImages 承载，
   * 这里只维护结构（assetId + 图注），避免表单卸载后丢失渲染能力。
   */
  const [blocks, setBlocks] = useState<ItineraryBlock[]>(item?.blocks ?? []);
  const [uploading, setUploading] = useState(false);
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

  // ---- 正文块编辑（增 / 删 / 改 / 上下移）----

  const addTextBlock = (type: 'text' | 'quote' | 'code'): void => {
    if (blocks.length >= MAX_BLOCKS) {
      void Taro.showToast({ title: `正文块最多 ${MAX_BLOCKS} 个`, icon: 'none' });
      return;
    }
    setBlocks((prev) => [...prev, { type, text: '' }]);
  };

  const addLinkBlock = (): void => {
    if (blocks.length >= MAX_BLOCKS) {
      void Taro.showToast({ title: `正文块最多 ${MAX_BLOCKS} 个`, icon: 'none' });
      return;
    }
    setBlocks((prev) => [...prev, { type: 'link', text: '', url: '' }]);
  };

  /** 选图并上传 → 追加图片块（资产登记走 media 域两段式，与照片 tab 同一条链路） */
  const addImageBlock = useCallback(async () => {
    if (blocks.length >= MAX_BLOCKS) {
      void Taro.showToast({ title: `正文块最多 ${MAX_BLOCKS} 个`, icon: 'none' });
      return;
    }
    setUploading(true);
    try {
      const added = await pickAndUploadPhotos(tripId);
      for (const p of added) {
        onImageUploaded(p.asset.id, p.localPath);
      }
      setBlocks((prev) => [
        ...prev,
        ...added.map((p): ItineraryBlock => ({ type: 'image', assetId: p.asset.id })),
      ]);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '图片上传失败，请重试');
    } finally {
      setUploading(false);
    }
  }, [blocks.length, tripId, onImageUploaded]);

  const setBlockText = (idx: number, text: string): void => {
    setBlocks((prev) => prev.map((b, i) => (i === idx && b.type !== 'image' ? { ...b, text } : b)));
  };

  const setBlockUrl = (idx: number, url: string): void => {
    setBlocks((prev) => prev.map((b, i) => (i === idx && b.type === 'link' ? { ...b, url } : b)));
  };

  const setBlockCaption = (idx: number, caption: string): void => {
    setBlocks((prev) =>
      prev.map((b, i) => (i === idx && b.type === 'image' ? { ...b, caption } : b)),
    );
  };

  const removeBlock = (idx: number): void => {
    setBlocks((prev) => prev.filter((_, i) => i !== idx));
  };

  /** 上下移：块顺序就是卡片上的阅读顺序，用户需要能把「注意事项」提到图片前面 */
  const moveBlock = (idx: number, dir: -1 | 1): void => {
    setBlocks((prev) => {
      const to = idx + dir;
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const a = next[idx];
      const b = next[to];
      if (a === undefined || b === undefined) return prev;
      next[idx] = b;
      next[to] = a;
      return next;
    });
  };

  /** 提交前的清洗：丢空块、裁首尾空白（服务端仍会独立校验，不信任客户端） */
  const cleanBlocks = useCallback((): ItineraryBlock[] => {
    const out: ItineraryBlock[] = [];
    for (const b of blocks) {
      if (b.type === 'image') {
        if (b.assetId === undefined) continue;
        const caption = (b.caption ?? '').trim();
        out.push({
          type: 'image',
          assetId: b.assetId,
          ...(caption !== '' ? { caption } : {}),
        });
      } else if (b.type === 'link') {
        const text = b.text.trim();
        const url = b.url.trim();
        if (text === '' || url === '') continue;
        out.push({ type: 'link', text, url });
      } else {
        const text = b.text.trim();
        if (text === '') continue;
        out.push({ type: b.type, text });
      }
    }
    return out;
  }, [blocks]);

  const submit = useCallback(async () => {
    if (title.trim() === '') {
      setErr('安排标题不能为空');
      return;
    }
    const startAt = `${date}T${time}`;
    // endAt 与服务端 endAt 对齐（纯加法字段）；空串 = 清除结束时间
    const endAt = endTime === '' ? '' : `${date}T${endTime}`;
    const finalBlocks = cleanBlocks();
    setBusy(true);
    setErr('');
    try {
      if (item) {
        await api.updateItineraryItem(item.id, {
          version: item.version,
          title: title.trim(),
          startAt,
          endAt: endAt === '' ? null : endAt,
          location: location.trim() === '' ? null : location.trim(),
          note: note.trim() === '' ? null : note.trim(),
          // 有正文块时以块为准；全部删空则显式传 [] 清除（老后端忽略未知键，安全）
          blocks: finalBlocks,
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
          ...(endAt !== '' ? { endAt } : {}),
          ...(location.trim() !== '' ? { location: location.trim() } : {}),
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
          ...(finalBlocks.length > 0 ? { blocks: finalBlocks } : {}),
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
  }, [
    title,
    date,
    time,
    endTime,
    location,
    note,
    transport,
    lat,
    lng,
    item,
    tripId,
    familyId,
    cleanBlocks,
    onDone,
  ]);

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

      <View className="row-between" style={{ gap: 8 }}>
        <View className="field" style={{ flex: 1.15 }}>
          <Text className="field__label">日期</Text>
          <Picker mode="date" value={date} onChange={(e) => setDate(String(e.detail.value))}>
            <View className="picker-row">
              <Text className="picker-row__val">{date}</Text>
            </View>
          </Picker>
        </View>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">开始</Text>
          <Picker mode="time" value={time} onChange={(e) => setTime(String(e.detail.value))}>
            <View className="picker-row">
              <Text className="picker-row__val">{time}</Text>
            </View>
          </Picker>
        </View>
        <View className="field" style={{ flex: 1 }}>
          <Text className="field__label">结束（选填）</Text>
          <Picker
            mode="time"
            value={endTime === '' ? time : endTime}
            onChange={(e) => setEndTime(String(e.detail.value))}
          >
            <View className="picker-row">
              <Text
                className={
                  endTime === '' ? 'picker-row__val picker-row__val--empty' : 'picker-row__val'
                }
              >
                {endTime === '' ? '未设置' : endTime}
              </Text>
            </View>
          </Picker>
        </View>
      </View>
      {endTime !== '' && (
        <Text className="coord-line__clear" style={{ marginTop: 2 }} onClick={() => setEndTime('')}>
          清除结束时间
        </Text>
      )}

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

      {/* 正文块编辑器：卡片正文从「一行备注」升级为可混排的块列表（参考截图形态） */}
      <View className="field">
        <Text className="field__label">
          卡片正文（{blocks.length}/{MAX_BLOCKS}）
        </Text>
        {blocks.length === 0 && (
          <Text className="muted" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
            可加段落、灰底引用、等宽代码（车次/地址）、外链与图片，按添加顺序显示在卡片里。
          </Text>
        )}
        {blocks.map((b, idx) => (
          <View className="blk-edit" key={`bk-${idx}`}>
            <View className="blk-edit__bar">
              <Text className="blk-edit__kind">
                {b.type === 'text'
                  ? '段落'
                  : b.type === 'quote'
                    ? '引用'
                    : b.type === 'code'
                      ? '代码'
                      : b.type === 'link'
                        ? '链接'
                        : '图片'}
              </Text>
              <View className="blk-edit__ops">
                <View className="icon-btn" onClick={() => moveBlock(idx, -1)}>
                  <Text className="blk-edit__arrow">↑</Text>
                </View>
                <View className="icon-btn" onClick={() => moveBlock(idx, 1)}>
                  <Text className="blk-edit__arrow">↓</Text>
                </View>
                <View className="icon-btn icon-btn--danger" onClick={() => removeBlock(idx)}>
                  <Icon name="close" size={13} />
                </View>
              </View>
            </View>

            {b.type === 'image' ? (
              <View className="blk-edit__img-row">
                <BlockThumb assetId={b.assetId} url={b.url} paths={localImages} />
                <Input
                  className="add-row__input"
                  value={b.caption ?? ''}
                  onInput={(e) => setBlockCaption(idx, e.detail.value)}
                  placeholder="图注（选填）"
                />
              </View>
            ) : (
              <Textarea
                className="textarea"
                value={b.text}
                maxlength={b.type === 'code' ? 500 : 2000}
                autoHeight
                onInput={(e) => setBlockText(idx, e.detail.value)}
                placeholder={
                  b.type === 'quote'
                    ? '引用内容，如注意事项'
                    : b.type === 'code'
                      ? '逐字核对的内容，如航班号 / 地址'
                      : '段落内容'
                }
              />
            )}

            {b.type === 'link' && (
              <Input
                className="input"
                value={b.url}
                onInput={(e) => setBlockUrl(idx, e.detail.value)}
                placeholder="https:// 开头的链接"
              />
            )}
          </View>
        ))}
        <View className="block-adder">
          {(
            [
              ['text', '段落'],
              ['quote', '引用'],
              ['code', '代码'],
            ] as Array<['text' | 'quote' | 'code', string]>
          ).map(([k, label]) => (
            <Text key={k} className="chip chip--plain" onClick={() => addTextBlock(k)}>
              ＋{label}
            </Text>
          ))}
          <Text className="chip chip--plain" onClick={addLinkBlock}>
            ＋链接
          </Text>
          <Text
            className={uploading ? 'chip chip--plain chip--busy' : 'chip chip--plain'}
            onClick={uploading ? undefined : () => void addImageBlock()}
          >
            {uploading ? '上传中…' : '＋图片'}
          </Text>
        </View>
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
function ChecklistTab({
  tripId,
  familyId,
  readonly = false,
}: {
  tripId: string;
  familyId: string;
  /** 回忆墙只读入口：不可勾选/增删，仅查看 */
  readonly?: boolean;
}) {
  const q = useAsync(
    useCallback(() => api.listTripChecklist(tripId), [tripId]),
    [tripId],
  );
  /** toggle 的本地覆盖（与既有模式一致，避免整表重拉闪烁） */
  const [local, setLocal] = useState<Record<string, ChecklistItem>>({});
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'SHARED' | 'PERSONAL'>('SHARED');
  /** 新增项归属哪一类（2026-10-27 需求③：待办 / 打包） */
  const [kind, setKind] = useState<'PACK' | 'TODO'>('PACK');
  const [busy, setBusy] = useState(false);
  /** 「引用长期清单」弹层开关 */
  const [picking, setPicking] = useState(false);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).map((c) => local[c.id] ?? c);
  /**
   * 两类清单分开算（2026-10-27 需求③「需要做的事项」与「需要带的东西」是两回事）：
   *   TODO → 行前动作（订门票 / 办签证 / 给猫找寄养）
   *   PACK → 打包物品（身份证 / 充电宝 x2）
   * 混成一个列表时，"勾了几项"这个进度没有意义 —— 订完门票不等于收拾好行李。
   * 老后端 / 历史行没有 kind → 归 PACK（历史清单装的全是打包物品）。
   */
  const todo = list.filter((c) => c.kind === 'TODO');
  const pack = list.filter((c) => c.kind !== 'TODO');
  const doneOf = (arr: ChecklistItem[]): number => arr.filter((c) => c.done).length;

  const toggle = async (id: string) => {
    const cur = list.find((c) => c.id === id);
    try {
      // 目标态由客户端算好再投递（显式传 checked）：连点时「取反」会把两次点击抵销
      const next = await api.toggleChecklistItem(id, !(cur?.done ?? false));
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 忽略：保持服务端状态（409 时界面仍是服务端的真相） */
    }
  };

  const add = async () => {
    const name = draft.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await api.createChecklistItem({ tripId, familyId, name, scope, kind });
      setDraft('');
      q.reload();
      /**
       * 旧后端 `createChecklistItemSchema` 没有 `kind` → Zod strip → 200 OK，
       * 但条目落库时用的是默认值 PACK。用户明明选了「要做的事」，结果出现在
       * 「要带的东西」里 —— 不解释清楚就是一次"功能坏了"的投诉。
       *
       * 🔴 这里**不抛错**：条目已经在服务端建好了，抛错会让用户以为没成功而重复提交，
       *    真正该做的是「照实显示 + 明确告知」。列表已 reload，用户能看到它落在哪。
       */
      if (created.kind !== kind) {
        void Taro.showToast({
          title: backendOutdatedHint('后端不认识清单分类 kind，这条已落到「要带的东西」'),
          icon: 'none',
          duration: 3200,
        });
      }
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '添加失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {/* 两条独立进度：待办做完 ≠ 行李收好，合成一条会让两边都不准 */}
      <Progress done={doneOf(todo)} total={todo.length} label="要做的事" />
      <Progress done={doneOf(pack)} total={pack.length} label="要带的东西" />

      {/* 引用长期清单：把「家庭常用 / 我的常用」一次性拉进来，不用重敲一遍 */}
      {!readonly && (
        <View className="cl-quick" onClick={() => setPicking(true)}>
          <Icon name="package" size={15} />
          <Text className="cl-quick__text">从长期清单引用</Text>
          <Text className="cl-quick__hint">家庭清单 / 我的清单</Text>
        </View>
      )}

      {list.length === 0 && (
        <Empty
          text={
            readonly
              ? '还没有清单项'
              : '还没有清单项。可以从长期清单引用，或新建行程自动带的往返票/住宿/证件/充电'
          }
        />
      )}

      {todo.length > 0 && (
        <View className="card card--flush" style={{ marginTop: 12 }}>
          <RowLabel>要做的事（{todo.length}）</RowLabel>
          {todo.map((c) => (
            <CheckRow
              key={c.id}
              item={c}
              readonly={readonly}
              onToggle={(id) => void toggle(id)}
              onDelete={() => removeChecklist(c.id, c.title, q.reload)}
            />
          ))}
        </View>
      )}

      {pack.length > 0 && (
        <View className="card card--flush" style={{ marginTop: todo.length > 0 ? 10 : 12 }}>
          <RowLabel>要带的东西（{pack.length}）</RowLabel>
          {pack.map((c) => (
            <CheckRow
              key={c.id}
              item={c}
              readonly={readonly}
              onToggle={(id) => void toggle(id)}
              onDelete={() => removeChecklist(c.id, c.title, q.reload)}
            />
          ))}
        </View>
      )}

      {!readonly && (
        <View className="card card--flush">
          {/* ① 先选「这是要办的事还是带的东西」—— 两类混着加，清单就没法用了 */}
          <View className="filter-bar filter-bar--compact" style={{ padding: '0 14px 4px' }}>
            <Text
              className={`chip ${kind === 'TODO' ? 'chip--on' : 'chip--plain'}`}
              onClick={() => setKind('TODO')}
            >
              要做的事
            </Text>
            <Text
              className={`chip ${kind === 'PACK' ? 'chip--on' : 'chip--plain'}`}
              onClick={() => setKind('PACK')}
            >
              要带的东西
            </Text>
          </View>
          {/* ② 再选可见范围 */}
          <View className="filter-bar filter-bar--compact" style={{ padding: '0 14px 8px' }}>
            <Text
              className={`chip ${scope === 'SHARED' ? 'chip--on' : 'chip--plain'}`}
              onClick={() => setScope('SHARED')}
            >
              全家可见
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
              placeholder="添加这次专属的物品，如：防晒霜"
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
      )}

      {picking && (
        <TemplatePickerSheet
          tripId={tripId}
          familyId={familyId}
          onClose={() => setPicking(false)}
          onApplied={q.reload}
        />
      )}
    </>
  );
}

/**
 * 长期清单选择器 —— 把「家庭清单 / 我的清单」引用进当前行程
 * ============================================================================
 * 只列可见模板（后端 listTemplates 已按 scope 收口：共享的按家庭过滤，
 * 私有的只回本人的），前端不做二次权限判断 —— 越权拦截是服务端的事。
 * 引用是幂等的：同一套清单在同一行程里重复引用不会翻倍，界面提示「已引用过」。
 */
function TemplatePickerSheet({
  tripId,
  familyId,
  onClose,
  onApplied,
}: {
  tripId: string;
  familyId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const q = useAsync(
    useCallback(
      () => api.listChecklistTemplates(familyId === '' ? undefined : familyId),
      [familyId],
    ),
    [familyId],
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const apply = useCallback(
    async (tpl: ChecklistTemplate) => {
      setBusyId(tpl.id);
      try {
        const r = await api.applyChecklistTemplate({ templateId: tpl.id, tripId, familyId });
        void Taro.showToast({
          title: r.alreadyApplied ? '这套清单已经引用过了' : `已加入 ${r.created} 项`,
          icon: 'none',
        });
        onApplied();
        onClose();
      } catch (e: unknown) {
        void Taro.showToast({ title: e instanceof Error ? e.message : '引用失败', icon: 'none' });
      } finally {
        setBusyId(null);
      }
    },
    [tripId, familyId, onApplied, onClose],
  );

  const list = q.data ?? [];

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={onClose} />
      <View className="sheet">
        <View className="sheet__head">
          <Text className="sheet__title">从长期清单引用</Text>
          <View className="sheet__close" onClick={onClose}>
            <Icon name="close" size={15} />
          </View>
        </View>

        {q.loading ? (
          <Loading text="读取清单…" />
        ) : q.error ? (
          <ErrorBox message={q.error} onRetry={q.reload} />
        ) : list.length === 0 ? (
          <Empty text="还没有长期清单。去「我的 → 物品清单」建一套，下次出行一键引用" />
        ) : (
          <View className="sheet__scroll">
            {list.map((tpl) => (
              <View
                key={tpl.id}
                className="pick-row"
                onClick={busyId === null ? () => void apply(tpl) : undefined}
              >
                <View className="pick-row__body">
                  <Text className="pick-row__title">{tpl.name}</Text>
                  <Text className="pick-row__sub">
                    {tpl.scope === 'SHARED' ? '家庭共享' : '仅自己'} · {tpl.items.length} 项
                  </Text>
                </View>
                <Text className="pick-row__go">{busyId === tpl.id ? '引用中…' : '引用'}</Text>
              </View>
            ))}
          </View>
        )}
        <Text className="sheet__hint">引用后这些物品会变成可勾选的打包项，勾上就是装好了</Text>
      </View>
    </View>
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
  readonly = false,
  onToggle,
  onDelete,
}: {
  item: ChecklistItem;
  /** 只读态：不勾选、不删除（勾选即 PATCH，属修改） */
  readonly?: boolean;
  onToggle: (id: string) => void;
  onDelete: () => void;
}) {
  return (
    <View
      className={item.done ? 'check check--done' : 'check'}
      onClick={readonly ? undefined : () => onToggle(item.id)}
    >
      <Text className="check__box">
        <Icon name={item.done ? 'check' : 'circle'} size={19} />
      </Text>
      <Text className="check__text">{item.title}</Text>
      {item.assigneeName && <Text className="check__who">{item.assigneeName}</Text>}
      {!readonly && (
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
      )}
    </View>
  );
}

/**
 * 预算卡（2026-10-27 需求③「花销里面没有记录预算的地方」）
 * ============================================================================
 * 为什么预算挂在行程上（`trip.budget_minor`）而不是新建一张预算表：
 *   预算天然是「这一趟打算花多少」，一次行程一个数，没有多预算维度的需求；
 *   挂在 trip 上还能复用已有的 CAS（version）与权限门，不必新开一个域。
 *
 * 口径：
 *   `spentYuan` 来自花销汇总的 `totalCny`（人民币折算、字符串元），
 *   与预算统一换算成「分」再比较 —— 一边元一边分是最常见的差 100 倍 bug。
 *
 * 预算为空（null）= 未设预算 → **不显示 0%、不显示"还剩 0 元"**，
 *   只显示一个「设置预算」入口，避免把"没填"误读成"没预算可用"。
 */
function BudgetCard({
  tripId,
  budgetMinor,
  spentYuan,
  endDate,
  version,
  readonly,
  onSaved,
}: {
  tripId: string;
  budgetMinor: string | null;
  /** 已花（人民币，元，字符串） */
  spentYuan: string;
  endDate: string | null;
  version: number;
  readonly: boolean;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const budgetFen = budgetMinor === null || budgetMinor === '' ? null : Number(budgetMinor);
  const spentFen = Math.round(Number(spentYuan || '0') * 100);
  const remainFen = budgetFen === null ? null : budgetFen - spentFen;
  const over = remainFen !== null && remainFen < 0;
  const pct = budgetFen !== null && budgetFen > 0 ? Math.min(100, (spentFen / budgetFen) * 100) : 0;

  /** 剩余天数（含今天）；已过结束日则为 0 → 不显示日均 */
  const daysLeft = ((): number => {
    if (endDate === null) return 0;
    const end = Date.parse(`${endDate}T00:00:00`);
    const now = Date.parse(`${todayYmd()}T00:00:00`);
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, Math.round((end - now) / 86_400_000) + 1);
  })();

  const openEdit = (): void => {
    setDraft(budgetFen === null ? '' : String(budgetFen / 100));
    setErr('');
    setEditing(true);
  };

  const save = async (): Promise<void> => {
    const text = draft.trim();
    // 空串 = 取消预算（显式传 null），不是"存 0"
    if (text !== '' && (!Number.isFinite(Number(text)) || Number(text) < 0)) {
      setErr('请输入正确的金额');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.updateTrip(tripId, {
        version,
        budgetMinor: text === '' ? null : String(Math.round(Number(text) * 100)),
      });
      setEditing(false);
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof ApiError ? `${e.message}（code ${e.code}）` : '保存失败，请重试');
    } finally {
      setSaving(false);
    }
  };

  const yuan = (fen: number): string => {
    const v = fen / 100;
    return Number.isInteger(v)
      ? v.toLocaleString('zh-CN')
      : v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  return (
    <View className="card">
      <View className="row-between">
        <Text className="card__title">预算</Text>
        {!readonly && !editing && (
          <Text className="card__more" onClick={openEdit}>
            {budgetFen === null ? '设置预算' : '修改'}
          </Text>
        )}
      </View>

      {editing ? (
        <>
          <View className="field" style={{ marginTop: 8 }}>
            <Text className="field__label">这趟打算花多少（元）</Text>
            <Input
              className="input"
              type="digit"
              value={draft}
              onInput={(e) => setDraft(e.detail.value)}
              placeholder="如：5000（留空表示不设预算）"
            />
          </View>
          {err !== '' ? <Text className="form-error">{err}</Text> : null}
          <View className="btn-row">
            <View className="btn btn--ghost" onClick={() => setEditing(false)}>
              取消
            </View>
            <View
              className={`btn ${saving ? 'btn--busy' : ''}`}
              onClick={saving ? undefined : () => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </View>
          </View>
        </>
      ) : budgetFen === null ? (
        <Text className="muted" style={{ fontSize: 12, lineHeight: 1.7, marginTop: 6 }}>
          还没设预算。设一个总额，花超了这里会立刻变红。
        </Text>
      ) : (
        <>
          <View className="row-between" style={{ marginTop: 8, alignItems: 'baseline' }}>
            <Text style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
              ¥{yuan(budgetFen)}
            </Text>
            <Text
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: over ? '#c0392b' : 'var(--text-2)',
              }}
            >
              {over ? `超支 ¥${yuan(-(remainFen ?? 0))}` : `还剩 ¥${yuan(remainFen ?? 0)}`}
            </Text>
          </View>

          <View className="budget-bar">
            <View
              className={over ? 'budget-bar__fill budget-bar__fill--over' : 'budget-bar__fill'}
              style={{ width: `${pct}%` }}
            />
          </View>

          <View className="row-between" style={{ marginTop: 5 }}>
            <Text className="muted" style={{ fontSize: 11 }}>
              已花 ¥{Number(spentYuan).toLocaleString('zh-CN')} · {Math.round(pct)}%
            </Text>
            {!over && daysLeft > 0 && remainFen !== null ? (
              <Text className="muted" style={{ fontSize: 11 }}>
                剩 {daysLeft} 天，日均可用 ¥{yuan(Math.floor(remainFen / daysLeft))}
              </Text>
            ) : null}
          </View>
        </>
      )}
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
function ExpenseTab({
  tripId,
  familyId,
  readonly = false,
  trip,
  onTripChanged,
}: {
  tripId: string;
  familyId: string;
  /** 回忆墙只读入口：隐藏记账/编辑/删除，仅查看汇总与明细 */
  readonly?: boolean;
  /** 行程本体（取 budgetMinor 与 version —— 预算走 PATCH /trips/:id 的 CAS） */
  trip: Trip;
  /** 预算保存成功后让外层重拉行程（version 会变，不重拉下次一定 409） */
  onTripChanged: () => void;
}) {
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
  /** 账单导入弹层开关（反馈 3：一笔一笔记太麻烦） */
  const [importing, setImporting] = useState(false);

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
      {/* 预算卡（2026-10-27 需求③：花销里没有记录预算的地方）*/}
      <BudgetCard
        tripId={tripId}
        budgetMinor={trip.budgetMinor ?? null}
        spentYuan={s?.totalCny ?? '0'}
        endDate={trip.endDate ?? null}
        version={trip.version}
        readonly={readonly}
        onSaved={onTripChanged}
      />

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
          <Empty text={readonly ? '这场行程还没有记账' : '还没有记账，点下面按钮记一笔'} />
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
                {!readonly && (
                  <>
                    <View className="icon-btn" onClick={() => setEditingId(e.id)}>
                      <Icon name="edit" size={14} />
                    </View>
                    <View
                      className="icon-btn icon-btn--danger"
                      onClick={() => removeExpense(e.id, e.title, reloadAll)}
                    >
                      <Icon name="trash" size={14} />
                    </View>
                  </>
                )}
              </View>
            ),
          )
        )}
      </View>

      {!readonly && (
        <>
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
            <>
              <View className="add-bar" onClick={() => setMode('add')}>
                <Icon name="plus" size={16} />
                <Text className="add-bar__text">记一笔花销</Text>
              </View>
              {/*
                账单导入（反馈 3）：微信/支付宝导出 CSV 或直接粘贴，
                解析后逐行确认再批量写入 —— 出行回来几十笔一次性录完。
              */}
              <View className="add-bar add-bar--ghost" onClick={() => setImporting(true)}>
                <Icon name="package" size={16} />
                <Text className="add-bar__text">导入账单（微信 / 支付宝）</Text>
              </View>
            </>
          )}
          {importing && (
            <BillImportSheet
              tripId={tripId}
              familyId={familyId}
              onClose={() => setImporting(false)}
              onDone={reloadAll}
            />
          )}
        </>
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
/**
 * 照片 tab —— 行程相册（2026-10-26 放开归档写入口）
 * ============================================================================
 * 用户反馈：「回忆墙无法上传照片」「已完成的行程……只能添加或删除回忆照片」。
 *
 * 根因：本组件原来接 `readonly`，而 readonly = 回忆墙入口 || 已结束，于是
 * **行程一旦结束（或从回忆墙点进来），上传格子与删除角标全被收起** ——
 * 看起来就是"回忆墙传不了照片"。
 *
 * 现在的口径：照片是「回忆」的载体，不属于「信息编辑」，任何状态都允许加/删。
 * 🔴 服务端目前对归档行程的媒体写仍会 403（media.service 的
 *    assertTripActiveWritable / assertTripMemberWritable 都认 HISTORICAL_READONLY），
 *    所以这里保留入口 + 把 403 翻成人话，而不是把按钮藏起来假装不支持。
 *    后端放开归属见派发单 D-2026-10-26-02 P0-2。
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
      setErr(photoWriteHint(e instanceof Error ? e.message : '上传失败，请重试', 'upload'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    const res = await Taro.showModal({
      title: '删除这张照片',
      content: '删除后不可恢复，确定删除？',
      confirmText: '删除',
      confirmColor: '#e5484d',
    });
    if (!res.confirm) return;
    try {
      await api.deleteMediaAsset(id);
      q.reload();
    } catch (e: unknown) {
      setErr(photoWriteHint(e instanceof Error ? e.message : '删除失败', 'delete'));
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
                  // 点图看大图（与回忆墙同一套预览，可左右滑过本次行程的所有照片）
                  onClick={() =>
                    previewPhotos(
                      photos.map((x) => localPaths[x.id] ?? (brokenUrls[x.id] ? '' : x.url)),
                      src,
                    )
                  }
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
function MemoryTab({
  tripId,
  tripTitle,
  readonly = false,
}: {
  tripId: string;
  tripTitle: string;
  /** 回忆墙只读入口：不生成回忆（写操作），仅查看已有快照 */
  readonly?: boolean;
}) {
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
            {readonly
              ? '这场出行还没有生成回忆。'
              : '出行结束后生成回忆，把成员、安排、花销汇总和照片数定格成一篇不可变的家庭档案。'}
          </Text>
          {!readonly && (
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
          )}
          {genErr !== '' && <ErrorBox message={genErr} onRetry={() => void generate()} />}
        </View>
      )}
    </>
  );
}

export default TripDetailPage;
