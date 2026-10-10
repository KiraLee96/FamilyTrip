/**
 * 心愿池 —— 全家提想法 → 投票 → 票高的转成行程
 * ============================================================================
 * 交互核心是「投票」：点右侧票数按钮即投票/取消，本地立即反馈，请求在后台完成。
 * 这样在移动端点按手感干脆，不会因为等网络而卡顿。
 */

import { useCallback, useState } from 'react';

import { api } from '../api/index';
import type { Wish } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
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
    <>
      <div className="card row-between" style={{ padding: '12px 14px' }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>
            {families.data?.[0]?.name ?? '我的家庭'}
          </div>
          <div className="muted" style={{ marginTop: 2 }}>
            共 {list.length} 条心愿 · 待定 {open.length} 条
          </div>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const id = families.data?.[0]?.id;
            setFamilyId(id);
          }}
        >
          <Icon name="plus" size={15} />
          提心愿
        </button>
      </div>

      {adopted.length > 0 && (
        <>
          <SectionTitle icon="check">已成行</SectionTitle>
          <div className="card card--flush">
            {adopted.map((w) => (
              <WishRow key={w.id} wish={w} onVote={(id) => void onVote(id)} />
            ))}
          </div>
        </>
      )}

      <SectionTitle icon="heart">待投票（按热度）</SectionTitle>
      {open.length === 0 ? (
        <Empty text="还没有待投票的心愿" />
      ) : (
        <div className="card card--flush">
          {open.map((w) => (
            <WishRow key={w.id} wish={w} onVote={(id) => void onVote(id)} />
          ))}
        </div>
      )}

      <p className="muted" style={{ textAlign: 'center', marginTop: 14 }}>
        票数最高的一条，可以直接转成行程草稿
      </p>
    </>
  );
}

function WishRow({ wish, onVote }: { wish: Wish; onVote: (id: string) => void }) {
  return (
    <div className="wish">
      <div className="wish__body">
        <div className="wish__title">
          {wish.title}
          {wish.status === 'ADOPTED' && (
            <span className="tag" style={{ background: '#e5f7ef', color: '#16794f' }}>
              已成行
            </span>
          )}
        </div>
        {wish.note && <div className="wish__note">{wish.note}</div>}
        {(wish.tags ?? []).length > 0 && (
          <div className="wish__tags">
            {(wish.tags ?? []).map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className={wish.votedByMe ? 'vote vote--on' : 'vote'}
        onClick={() => onVote(wish.id)}
        aria-pressed={wish.votedByMe}
      >
        <Icon name="heart" size={17} />
        <span className="vote__n">{wish.votes}</span>
        <span className="vote__cap">{wish.votedByMe ? '已投' : '投票'}</span>
      </button>
    </div>
  );
}
