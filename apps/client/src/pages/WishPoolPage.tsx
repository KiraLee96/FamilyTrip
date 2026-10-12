/**
 * 心愿池 —— 全家提想法 → 投票 → 票高的转成行程（Taro 同构版）
 * ============================================================================
 * 交互核心是「投票」：点右侧票数按钮即投票/取消，本地立即反馈，请求在后台完成。
 */

import { useCallback, useState } from 'react';
import { Text, View } from '@tarojs/components';

import { api } from '../api/index';
import type { Wish } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { SectionTitle } from '../components/shared';
import { useAsync } from '../hooks/useAsync';

export function WishPoolPage() {
  const [familyId, setFamilyId] = useState<string | undefined>(undefined);
  const q = useAsync(
    useCallback(() => api.listWishes(familyId), [familyId]),
    [familyId],
  );
  const [local, setLocal] = useState<Record<string, Wish>>({});

  // 初始化家庭 id（Mock 下只有一个家庭）
  const families = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  const onVote = useCallback(async (id: string) => {
    // 乐观更新：先改本地，再对齐服务端返回值
    try {
      const next = await api.voteWish(id);
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 失败时不改本地状态，保持与服务端一致 */
    }
  }, []);

  if (q.loading || families.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).map((w) => local[w.id] ?? w);
  const open = list.filter((w) => w.status === 'OPEN').sort((a, b) => b.votes - a.votes);
  const adopted = list.filter((w) => w.status === 'ADOPTED');

  return (
    <PageLayout title="心愿池" sub="全家投票，票高的先安排">
      <View className="card row-between">
        <View>
          <Text style={{ fontSize: 13.5, fontWeight: 600 }}>
            {families.data?.[0]?.name ?? '我的家庭'}
          </Text>
          <Text className="muted" style={{ marginTop: 2 }}>
            共 {list.length} 条心愿 · 待定 {open.length} 条
          </Text>
        </View>
        <View
          className="btn"
          onClick={() => {
            const id = families.data?.[0]?.id;
            setFamilyId(id);
          }}
        >
          <Icon name="plus" size={15} />
          提心愿
        </View>
      </View>

      {adopted.length > 0 && (
        <>
          <SectionTitle icon="check">已成行</SectionTitle>
          <View className="card card--flush">
            {adopted.map((w) => (
              <WishRow key={w.id} wish={w} onVote={(id) => void onVote(id)} />
            ))}
          </View>
        </>
      )}

      <SectionTitle icon="heart">待投票（按热度）</SectionTitle>
      {open.length === 0 ? (
        <Empty text="还没有待投票的心愿" />
      ) : (
        <View className="card card--flush">
          {open.map((w) => (
            <WishRow key={w.id} wish={w} onVote={(id) => void onVote(id)} />
          ))}
        </View>
      )}

      <Text className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
        票数最高的一条，可以直接转成行程草稿
      </Text>
    </PageLayout>
  );
}

function WishRow({ wish, onVote }: { wish: Wish; onVote: (id: string) => void }) {
  return (
    <View className="wish">
      <View className="wish__body">
        <View className="wish__title">
          <Text>{wish.title}</Text>
          {wish.status === 'ADOPTED' && (
            <Text className="tag" style={{ background: '#e5f7ef', color: '#16794f' }}>
              已成行
            </Text>
          )}
        </View>
        {wish.note && <Text className="wish__note">{wish.note}</Text>}
        {(wish.tags ?? []).length > 0 && (
          <View className="wish__tags">
            {(wish.tags ?? []).map((t) => (
              <Text key={t} className="tag">
                {t}
              </Text>
            ))}
          </View>
        )}
      </View>
      <View className={wish.votedByMe ? 'vote vote--on' : 'vote'} onClick={() => onVote(wish.id)}>
        <Icon name="heart" size={17} />
        <Text className="vote__n">{wish.votes}</Text>
        <Text className="vote__cap">{wish.votedByMe ? '已投' : '投票'}</Text>
      </View>
    </View>
  );
}

export default WishPoolPage;
