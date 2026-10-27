/**
 * 回忆墙 —— 全家的旅行照片与回忆档案（Taro 同构版）
 * ============================================================================
 * 版式对齐 2026-10-13 设计稿（截图 5）：
 *   页头「回忆墙」+ 虚线徽章「N 张」
 *   ① 「全部」筛选胶囊
 *   ② 空态：插画 + 「回忆墙还空着」+ 橙色「上传第一张照片」按钮
 *   ③ 有回忆时：回忆档案卡列表（MemoryArchive 摘要）+ 照片网格
 *
 * 数据：api.listMemories（档案摘要）/ api.listMedia（照片网格），
 *   上传走 utils/upload 的两段式链路（presign → confirm），不绑定具体行程。
 */

import { useCallback, useState } from 'react';
import { Image, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { Link } from '../nav/Link';
import { navigate } from '../nav';

import { api } from '../api/index';
import type { MediaAsset, MemoryArchive } from '../api/types';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { PhotoCover } from '../components/PhotoCover';
import { shortDate } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { photoWriteHint, backendOutdatedHint, isBackendOutdated } from '../utils/constants';
import { previewPhotos } from '../utils/preview';
import { chooseTripForPhotos, pickAndUploadPhotos } from '../utils/upload';

export function MemoryPage() {
  const [busy, setBusy] = useState(false);

  const memoriesQ = useAsync(
    useCallback(() => api.listMemories(), []),
    [],
  );
  const mediaQ = useAsync(
    useCallback(() => api.listMedia(), []),
    [],
  );
  /**
   * 照片回忆组（2026-10-27）：按行程/月份自动聚合。
   * 这是本页的主体 —— 用户要的是「像苹果相册的回忆」，
   * 而不是一份需要手动生成的年度档案。
   */
  const groupsQ = useAsync(
    useCallback(() => api.listPhotoMemories({ limit: 30 }), []),
    [],
  );

  const reloadAll = useCallback(() => {
    memoriesQ.reload();
    mediaQ.reload();
    groupsQ.reload();
  }, [memoriesQ, mediaQ, groupsQ]);

  /**
   * 上传：先问「归到哪次旅行」（见 `chooseTripForPhotos` 的返回语义）。
   * 取消归属选择 → 整个上传中止，不当成一次失败去弹 toast。
   */
  const upload = async () => {
    const tripId = await chooseTripForPhotos();
    if (tripId === null) return;
    setBusy(true);
    try {
      await pickAndUploadPhotos(tripId);
      reloadAll();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '上传失败，请重试';
      // 用户主动取消不提示（chooseImage 的 fail 也是这个文案）
      if (!/cancel|取消/i.test(msg)) {
        void Taro.showToast({ title: photoWriteHint(msg, 'upload'), icon: 'none' });
      }
    } finally {
      setBusy(false);
    }
  };

  if (memoriesQ.loading || mediaQ.loading) return <Loading />;
  if (memoriesQ.error) return <ErrorBox message={memoriesQ.error} onRetry={memoriesQ.reload} />;

  const memories = memoriesQ.data ?? [];
  const media = mediaQ.data ?? [];
  const groups = groupsQ.data ?? [];
  const photoCount = media.length + memories.reduce((n, m) => n + m.summary.mediaCount, 0);

  return (
    <PageLayout title="回忆墙" sub="旅途里的每个瞬间，都值得好好收藏" badge={`${photoCount} 张`}>
      <View className="seg">
        <Text className="seg__btn seg__btn--on">全部</Text>
      </View>

      {/**
       * 后端缺 `/media/memories` 时**不要装成「回忆墙还空着」**。
       * 旧后端（10-22 版）没有这个路由，返回 4040；如果不提示，用户会以为
       * 照片丢了 —— 这正是本轮反馈①的体验。照片网格走的是 `/media`（老接口，
       * 存在），所以下面那一区照常可见，必须说清楚"哪部分能用、哪部分不能"。
       */}
      {isBackendOutdated(groupsQ.error) && (
        <View className="card card--flush" style={{ marginBottom: 10 }}>
          <Text style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
            分组回忆暂不可用
          </Text>
          <Text className="muted" style={{ fontSize: 11.5, lineHeight: 1.7, marginTop: 4 }}>
            {backendOutdatedHint('缺少 /media/memories 接口')}。
            下方的「照片」区仍可正常查看与上传，分组视图要等后端部署后才出现。
          </Text>
        </View>
      )}

      {memories.length === 0 && media.length === 0 && groups.length === 0 ? (
        /* ② 空态：设计稿插画位（emoji 大图 + 圆形浅绿底） */
        <View className="blank">
          <View className="blank__art">🗺️</View>
          <Text className="blank__title">回忆墙还空着</Text>
          <Text className="blank__cap">在行程里传几张照片，这里会自动长出回忆</Text>
          <View
            className={`btn btn--accent ${busy ? 'btn--busy' : ''}`}
            style={{ marginTop: 10, padding: '0 22px', height: 40 }}
            onClick={busy ? undefined : () => void upload()}
          >
            <Icon name="camera" size={15} />
            <Text style={{ color: '#fff' }}>{busy ? '上传中…' : '上传第一张照片'}</Text>
          </View>
        </View>
      ) : (
        <>
          {/*
            ③ 照片回忆组（主体）—— 每次旅行一张大卡，封面 + 标题 + 张数。
            点开必须落到**照片** tab：`tab=memory` 是「回忆快照」（memory_archive，
            要手动生成、且不含任何照片），落错地方就等于"照片没了"。
          */}
          {groups.length > 0 ? (
            <>
              <View className="section-title">
                <Text className="section-title__icon">
                  <Icon name="sparkles" size={15} />
                </Text>
                旅行回忆
                <Text className="section-title__side" style={{ marginLeft: 8 }}>
                  {groups.length} 组
                </Text>
              </View>
              <View className="memo-list">
                {groups.map((g) => {
                  const key = `${g.kind}-${g.tripId ?? g.month ?? ''}`;
                  const open = (): void => {
                    if (g.kind === 'TRIP' && g.tripId !== null) {
                      navigate(`/trips/${g.tripId}?tab=photo&readonly=1`);
                      return;
                    }
                    // 月份组（未绑定行程的照片）没有行程页可跳 → 直接全屏预览这一组
                    previewPhotos(g.photos, g.cover !== '' ? g.cover : (g.photos[0] ?? ''));
                  };
                  return (
                    <View key={key} className="memo-card memo-card--wide" onClick={open}>
                      <PhotoCover url={g.cover} />
                      <View className="memo-card__veil" />
                      <View className="memo-card__meta">
                        <Text className="memo-card__title">{g.title}</Text>
                        <Text className="memo-card__sub">
                          {[g.subtitle, `${g.photoCount} 张`].filter((s) => s !== '').join(' · ')}
                        </Text>
                      </View>
                    </View>
                  );
                })}
              </View>
            </>
          ) : null}

          {/* ④ 年度档案（保留：年度回顾是另一类产物，不等于照片流） */}
          {memories.map((m) => (
            <MemoryArchiveCard key={m.id} archive={m} />
          ))}

          {/* ⑤ 全部照片网格 */}
          <View className="section-title">
            照片
            <Text className="section-title__side" style={{ marginLeft: 8 }}>
              {media.length} 张
            </Text>
          </View>
          <View className="photo-grid">
            <View
              className={`photo-cell photo-cell--add ${busy ? 'photo-cell--busy' : ''}`}
              onClick={busy ? undefined : () => void upload()}
            >
              <Text className="photo-cell__plus">＋</Text>
              <Text className="photo-cell__add-text">上传照片</Text>
            </View>
            {media.map((p) => (
              <PhotoCell
                key={p.id}
                asset={p}
                allUrls={media.map((m) => m.url).filter((u) => u !== '')}
                onDeleted={reloadAll}
              />
            ))}
          </View>
        </>
      )}
    </PageLayout>
  );
}

/** 回忆档案摘要卡：TRIP 回忆跳行程详情回忆 tab（只读）；ANNUAL 跳年度规划 */
function MemoryArchiveCard({ archive }: { archive: MemoryArchive }) {
  const s = archive.summary;
  const isTrip = archive.type === 'TRIP';
  // 2026-10-16 需求②：从回忆点进的行程只能查看 —— readonly=1 让 TripDetailPage
  // 进入只读态（隐藏一切写入口）；tab=memory 定位到回忆 tab
  const to = isTrip && archive.refId ? `/trips/${archive.refId}?tab=memory&readonly=1` : '/plan';

  return (
    <Link to={to} className="card">
      <View className="memory__head" style={{ marginBottom: 8 }}>
        <Text className="memory__badge">
          <Icon name={isTrip ? 'route' : 'calendar'} size={12} />
          {isTrip ? '出行回忆' : '年度回忆'} · {archive.year}
        </Text>
        <Text className="muted" style={{ fontSize: 10.5 }}>
          {shortDate(archive.createdAt.slice(0, 10))}
        </Text>
      </View>
      <Text className="memory__trip-title">{s.tripTitle ?? `${archive.year} 年度全家回忆`}</Text>
      <View className="memory__cats">
        <Text className="tag">{s.itineraryCount} 个安排</Text>
        <Text className="tag">{s.mediaCount} 张照片</Text>
        {s.memberCount !== null && <Text className="tag">{s.memberCount} 人同行</Text>}
        {s.totalMinor !== null && (
          <Text className="tag">花销 ¥{(Number(s.totalMinor) / 100).toFixed(0)}</Text>
        )}
      </View>
    </Link>
  );
}

/**
 * 照片格 —— 点开看大图、点 ✕ 删除。
 * ============================================================================
 * 2026-10-26：此前整格 `onClick` 直接调删除接口 —— 用户想看大图、手一滑
 * 就把照片删了（回忆墙是"照片归档"的地方，误删代价最高）。改为点 ✕ 才删除。
 *
 * 2026-10-27：上一轮把删除挪走了，却**没补上「看大图」**，格子变成点了没反应 ——
 * 用户的原话就是「打开看不到」。现在整格点击 = 原生全屏预览（可左右滑），
 * 删除仍走 ✕。
 *
 * 另：改用 `<Image>` + `onError` 而不是 CSS `background-image`。
 * background-image 加载失败**没有任何回调**，格子就是一块空白，看起来像
 * "照片不存在"；`<Image>` 能拿到失败事件，至少能告诉用户是"加载失败"。
 */
function PhotoCell({
  asset,
  allUrls,
  onDeleted,
}: {
  asset: MediaAsset;
  /** 同屏所有可预览地址（点开后左右滑） */
  allUrls: string[];
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);

  const remove = useCallback(async () => {
    const res = await Taro.showModal({
      title: '删除这张照片',
      content: '删除后不可恢复，确定删除？',
      confirmText: '删除',
      confirmColor: '#e5484d',
    });
    if (!res.confirm) return;
    setBusy(true);
    try {
      await api.deleteMediaAsset(asset.id);
      onDeleted();
    } catch (e: unknown) {
      void Taro.showToast({
        title: photoWriteHint(e instanceof Error ? e.message : '删除失败', 'delete'),
        icon: 'none',
      });
    } finally {
      setBusy(false);
    }
  }, [asset.id, onDeleted]);

  const url = asset.url ?? '';
  const canShow = url !== '' && !broken;

  return (
    <View className="photo-cell">
      {canShow ? (
        <Image
          className="photo-cell__img"
          src={url}
          mode="aspectFill"
          onClick={() => previewPhotos(allUrls, url)}
          onError={() => setBroken(true)}
        />
      ) : (
        <View className="photo-cell__ph">
          <Text style={{ fontSize: 20 }}>{broken ? '⚠️' : '📷'}</Text>
          <Text className="photo-cell__ph-date">
            {broken ? '图片加载失败' : asset.createdAt.slice(0, 10)}
          </Text>
        </View>
      )}
      <View
        className={`photo-cell__del ${busy ? 'photo-cell__del--busy' : ''}`}
        onClick={busy ? undefined : () => void remove()}
      >
        <Text className="photo-cell__del-x">✕</Text>
      </View>
    </View>
  );
}

export default MemoryPage;
