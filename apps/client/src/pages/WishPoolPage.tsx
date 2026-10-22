/**
 * 心愿池 —— 全家提想法 → 投票 → 票高的转成行程（Taro 同构版）
 * ============================================================================
 * 交互核心是「投票」：点右侧票数按钮即投票/取消，本地立即反馈，请求在后台完成。
 *
 * 2026-10-22 修复（反馈「提心愿点不动」）：
 *   根因是该按钮的 onClick 只做了 `setFamilyId(首个家庭 id)` —— 值本来就等于默认
 *   值，setState 后 React 判定无变化不重渲染，也没打开任何表单，表现就是「点了没反应」。
 *   现在改为打开「提心愿」抽屉，提交走 api.createWish（服务端 POST /wishes 早就有，
 *   只是客户端一直没接）。
 */

import { useCallback, useState } from 'react';
import { Input, Text, Textarea, View } from '@tarojs/components';

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

  // ─── 提心愿抽屉的状态 ───
  const [wishOpen, setWishOpen] = useState(false);
  const [wishTitle, setWishTitle] = useState('');
  const [wishNote, setWishNote] = useState('');
  const [wishBusy, setWishBusy] = useState(false);
  const [wishErr, setWishErr] = useState('');

  const onVote = useCallback(async (id: string) => {
    // 乐观更新：先改本地，再对齐服务端返回值
    try {
      const next = await api.voteWish(id);
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 失败时不改本地状态，保持与服务端一致 */
    }
  }, []);

  const resetWishForm = (): void => {
    setWishTitle('');
    setWishNote('');
    setWishErr('');
  };

  const submitWish = async (): Promise<void> => {
    const name = wishTitle.trim();
    if (name === '') {
      setWishErr('先写一句心愿吧，比如「带孩子赶海捡贝壳」');
      return;
    }
    const target = familyId ?? families.data?.[0]?.id;
    if (target === undefined) {
      setWishErr('还没有家庭，先去「我的」页创建或加入一个');
      return;
    }
    setWishBusy(true);
    setWishErr('');
    try {
      await api.createWish({
        familyId: target,
        title: name,
        ...(wishNote.trim() !== '' ? { description: wishNote.trim() } : {}),
      });
      setWishOpen(false);
      resetWishForm();
      // 家庭 id 之前可能一直是 undefined（列表拉的全量），这里顺手收敛到当前家庭
      if (familyId === undefined) setFamilyId(target);
      else q.reload();
    } catch (e: unknown) {
      setWishErr(e instanceof Error ? e.message : '提交失败，请重试');
    } finally {
      setWishBusy(false);
    }
  };

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
            resetWishForm();
            setWishOpen(true);
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

      {wishOpen && (
        <View className="sheet-root">
          <View className="sheet-mask" onClick={() => setWishOpen(false)} />
          <View className="sheet">
            <View className="sheet__head">
              <Text className="sheet__title">提一个心愿</Text>
              <View className="sheet__close" onClick={() => setWishOpen(false)}>
                <Icon name="close" size={15} />
              </View>
            </View>

            <View className="field">
              <Text className="field__label">心愿</Text>
              <Input
                className="input"
                value={wishTitle}
                maxlength={128}
                placeholder="比如：带孩子赶海捡贝壳"
                onInput={(e) => setWishTitle(e.detail.value)}
              />
            </View>

            <View className="field">
              <Text className="field__label">补充说明（选填）</Text>
              <Textarea
                className="textarea"
                value={wishNote}
                maxlength={500}
                placeholder="想什么时候去、有什么讲究，都可以写在这里"
                onInput={(e) => setWishNote(e.detail.value)}
              />
            </View>

            {wishErr ? <Text className="form-error">{wishErr}</Text> : null}

            <View className="sheet__ops">
              <View className="btn btn--ghost sheet__op" onClick={() => setWishOpen(false)}>
                取消
              </View>
              <View
                className={`btn sheet__op ${wishBusy ? 'btn--busy' : ''}`}
                onClick={wishBusy ? undefined : () => void submitWish()}
              >
                {wishBusy ? '提交中…' : '放进心愿池'}
              </View>
            </View>
          </View>
        </View>
      )}
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
