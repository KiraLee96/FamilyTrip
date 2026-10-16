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
import { Text, View } from '@tarojs/components';
import { Link } from '../nav/Link';

import { api } from '../api/index';
import type { MediaAsset, MemoryArchive } from '../api/types';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { shortDate } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { pickAndUploadPhotos } from '../utils/upload';

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

  const reloadAll = useCallback(() => {
    memoriesQ.reload();
    mediaQ.reload();
  }, [memoriesQ, mediaQ]);

  const upload = async () => {
    setBusy(true);
    try {
      await pickAndUploadPhotos();
      reloadAll();
    } catch {
      /* 用户取消或失败：静默，保持原状 */
    } finally {
      setBusy(false);
    }
  };

  if (memoriesQ.loading || mediaQ.loading) return <Loading />;
  if (memoriesQ.error) return <ErrorBox message={memoriesQ.error} onRetry={memoriesQ.reload} />;

  const memories = memoriesQ.data ?? [];
  const media = mediaQ.data ?? [];
  const photoCount = media.length + memories.reduce((n, m) => n + m.summary.mediaCount, 0);

  return (
    <PageLayout title="回忆墙" sub="旅途里的每个瞬间，都值得好好收藏" badge={`${photoCount} 张`}>
      <View className="seg">
        <Text className="seg__btn seg__btn--on">全部</Text>
      </View>

      {memories.length === 0 && media.length === 0 ? (
        /* ② 空态：设计稿插画位（emoji 大图 + 圆形浅绿底） */
        <View className="blank">
          <View className="blank__art">🗺️</View>
          <Text className="blank__title">回忆墙还空着</Text>
          <Text className="blank__cap">旅行结束后，把照片和故事留在这里</Text>
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
          {/* ③ 回忆档案卡 */}
          {memories.map((m) => (
            <MemoryArchiveCard key={m.id} archive={m} />
          ))}

          {/* 照片网格 */}
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
              <PhotoCell key={p.id} asset={p} onDeleted={reloadAll} />
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

/** 照片格：Mock 无真实图片字节时渲染占位；长按删除角标 */
function PhotoCell({ asset, onDeleted }: { asset: MediaAsset; onDeleted: () => void }) {
  const remove = async () => {
    try {
      await api.deleteMediaAsset(asset.id);
      onDeleted();
    } catch {
      /* 删除失败：保持原状 */
    }
  };

  return (
    <View className="photo-cell" onClick={() => void remove()}>
      {asset.url !== '' ? (
        <View
          className="photo-cell__img"
          style={{
            backgroundImage: `url(${asset.url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          }}
        />
      ) : (
        <View className="photo-cell__ph">
          <Text style={{ fontSize: 20 }}>📷</Text>
          <Text className="photo-cell__ph-date">{asset.createdAt.slice(0, 10)}</Text>
        </View>
      )}
      <View className="photo-cell__del">
        <Text className="photo-cell__del-x">✕</Text>
      </View>
    </View>
  );
}

export default MemoryPage;
