/**
 * 行程管理 —— 邀请同行人 + 参与人（2026-10-26 信息架构调整）
 * ============================================================================
 * 用户反馈原文：
 *   「行程的邀请码不需要一个单独的区域……加一个按钮邀请通行人，点开后出现邀请码、
 *     重置邀请码和分享复制之类的这个标签页就可以了。行程的参与人也是，从行程的卡片
 *     进入行程的具体信息：邀请同行人、参与人，都属于行程的管理，点击信息的卡片进入
 *     详情页。行程的具体安排等 tab 还是放在首页的保持不变。」
 *
 * 所以职责这样切分：
 *   · 行程详情页 = 只放「内容」（行程时间轴 / 清单 / 花销 / 照片 / 回忆），一屏进内容；
 *   · 本页       = 只放「管理」（谁能来、怎么邀请），从行程信息卡进入。
 *
 * 🔴 不 fork 邀请逻辑：原来长在 TripDetailPage 里的邀请卡整体搬到这里，
 *    接口调用（getTripInvite / resetTripInvite）与 H5/小程序分享分流一字不改，
 *    避免出现两份邀请实现各自漂移。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { Button, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { TripInvite, TripMember, TripMemberRole } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { StatusChip, dateRange } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { Link } from '../nav/Link';
import { useRouteParams } from '../nav';
import { buildJoinLink, copyText } from '../utils/clipboard';
import { inviteUnavailableHint, tripDisplayStatus, tripIsEnded } from '../utils/constants';

/** 编译期常量：小程序有原生转发面板，H5 只能给链接 */
const IS_WEAPP = process.env.TARO_ENV === 'weapp';

export function TripManagePage() {
  const params = useRouteParams<{ id: string }>();
  const tripId = params.id ?? '';

  const detail = useAsync(
    useCallback(() => api.getTripDetail(tripId), [tripId]),
    [tripId],
  );

  // 分享卡片携带的邀请码（页面级 useShareAppMessage 必须在顶层、提前返回之前注册）
  const shareRef = useRef<{ code: string; title: string } | null>(null);
  Taro.useShareAppMessage(() => {
    const s = shareRef.current;
    return s
      ? { title: `加入「${s.title}」一起出行`, path: `/pages/JoinTripPage?invite=${s.code}` }
      : { title: '来看看这场家庭出行', path: '/pages/JoinTripPage' };
  });

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorBox message={detail.error} onRetry={detail.reload} />;

  const d = detail.data!;
  const trip = d.trip;
  const members = d.members;
  /** 归档（真 FINISHED/CANCELLED）与「到期未流转」都算结束：结束的行程不再让人加入 */
  const ended = tripIsEnded(trip);

  return (
    <PageLayout title="行程管理" sub={trip.title}>
      <Link
        to={`/trips/${tripId}`}
        className="muted"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginBottom: 10 }}
      >
        <Icon name="chevron-right" size={14} className="rotate-180" />
        返回行程详情
      </Link>

      <View className="card tm-summary">
        <View className="tm-summary__top">
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text className="tm-summary__title">{trip.title}</Text>
            <Text className="tm-summary__sub">
              {dateRange(trip)} · {members.length} 人
            </Text>
          </View>
          <StatusChip status={tripDisplayStatus(trip)} />
        </View>
      </View>

      <InviteSection
        tripId={tripId}
        tripTitle={trip.title}
        ended={ended}
        shareRef={shareRef}
        onApplied={detail.reload}
      />

      <MembersSection members={members} myRole={d.myRole} ended={ended} onChanged={detail.reload} />
    </PageLayout>
  );
}

/**
 * 邀请同行人 —— 邀请码 + 复制 / 分享 / 重置 + 凭码加入入口
 * ============================================================================
 * 接口未就绪时降级：码位显示「——」，操作键置灰，错误内联展示，不阻断参与人区块。
 */
function InviteSection({
  tripId,
  tripTitle,
  ended,
  shareRef,
  onApplied,
}: {
  tripId: string;
  tripTitle: string;
  ended: boolean;
  shareRef: MutableRefObject<{ code: string; title: string } | null>;
  onApplied: () => void;
}) {
  const invite = useAsync(
    useCallback(() => api.getTripInvite(tripId), [tripId]),
    [tripId],
  );
  const [resetBusy, setResetBusy] = useState(false);
  const code = invite.data?.inviteCode ?? null;

  // 码就位后回填分享信息（useShareAppMessage 被调用时读取）
  useEffect(() => {
    shareRef.current = code ? { code, title: tripTitle } : null;
  }, [code, tripTitle, shareRef]);

  const onReset = (): void => {
    void Taro.showModal({
      title: '重置邀请码',
      content: '重置后旧邀请码立即作废，已经用旧码加入的人不受影响。确定重置？',
      confirmText: '重置',
      confirmColor: '#e5484d',
    }).then(async (res) => {
      if (!res.confirm) return;
      setResetBusy(true);
      try {
        const next: TripInvite = await api.resetTripInvite(tripId);
        invite.reload();
        onApplied();
        void Taro.showToast({ title: `新邀请码 ${next.inviteCode}`, icon: 'none' });
      } catch (e: unknown) {
        void Taro.showToast({ title: e instanceof Error ? e.message : '重置失败', icon: 'none' });
      } finally {
        setResetBusy(false);
      }
    });
  };

  return (
    <View className="card tm-block">
      <View className="tm-block__head">
        <Text className="tm-block__title">
          <Icon name="link" size={15} /> 邀请同行人
        </Text>
        <Text className="tm-block__hint">不占家庭名额</Text>
      </View>

      <View className="invite">
        <View className="invite__body">
          <Text className="invite__label">同行邀请码</Text>
          {/* selectable：复制通道全失败时还能长按选中 */}
          <Text className="invite__code" selectable>
            {code ?? '——'}
          </Text>
        </View>
        <View className="invite__ops">
          <View
            className={`btn btn--ghost invite__btn ${code ? '' : 'btn--busy'}`}
            onClick={code ? () => void copyText(code, '邀请码已复制') : undefined}
          >
            <Icon name="copy" size={14} />
            复制
          </View>
          {IS_WEAPP ? (
            <Button className="btn btn--ghost invite__btn invite__share" openType="share">
              <Icon name="share" size={14} />
              分享
            </Button>
          ) : (
            <View
              className={`btn btn--ghost invite__btn ${code ? '' : 'btn--busy'}`}
              onClick={
                code
                  ? () => void copyText(buildJoinLink(code, 'trip'), '加入链接已复制')
                  : undefined
              }
            >
              <Icon name="share" size={14} />
              复制链接
            </View>
          )}
        </View>
      </View>

      <View className="invite__ops" style={{ marginTop: 8 }}>
        <View
          className={`btn btn--ghost invite__btn ${resetBusy || !code || ended ? 'btn--busy' : ''}`}
          onClick={resetBusy || !code || ended ? undefined : onReset}
        >
          重置邀请码
        </View>
        <Link to="/trips/join" className="btn btn--ghost invite__btn">
          <Icon name="link" size={14} />
          凭码加入
        </Link>
      </View>

      <Text className="invite__hint">
        {ended
          ? '行程已结束：邀请码仍可展示，但新加入的人只会看到只读档案'
          : '把邀请码或链接发给朋友，对方点开即可加入这场行程'}
      </Text>

      {invite.error ? (
        <>
          <Text className="muted" style={{ marginTop: 6, fontSize: 12, lineHeight: 1.6 }}>
            {inviteUnavailableHint(invite.error)}
          </Text>
          <Text
            className="coord-line__clear"
            style={{ marginTop: 4 }}
            onClick={() => invite.reload()}
          >
            重新获取
          </Text>
        </>
      ) : null}
    </View>
  );
}

/**
 * 参与人 —— 这次行程有谁（人数 + 名单 + 角色）
 * ============================================================================
 * 数据来自 GET /trips/:id 的 members（后端一直返回，之前客户端把它丢了）。
 * 排序：主导者 → 家庭成员 → 代管虚拟成员 → 外部同行者 —— 一屏先看到「谁在管」。
 * 主导者可把非主导成员移出（DELETE /trips/members/:id），结束的行程不再允许调整。
 */
function MembersSection({
  members,
  myRole,
  ended,
  onChanged,
}: {
  members: TripMember[];
  myRole: TripMemberRole | null;
  ended: boolean;
  onChanged: () => void;
}) {
  const rank = (m: TripMember): number => {
    if (m.role === 'LEADER') return 0;
    if (m.isExternal) return 3;
    if (m.managedBy !== null) return 2;
    return 1;
  };
  const sorted = [...members].sort((a, b) => rank(a) - rank(b));
  const canManage = myRole === 'LEADER' && !ended;

  return (
    <View className="card tm-block">
      <View className="tm-block__head">
        <Text className="tm-block__title">
          <Icon name="users" size={15} /> 参与人
        </Text>
        <Text className="tm-block__count">共 {members.length} 人</Text>
      </View>

      {members.length === 0 ? (
        <Empty text="还没有参与人" />
      ) : (
        <View className="tm__list">
          {sorted.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              canRemove={canManage && m.role !== 'LEADER'}
              onRemoved={onChanged}
            />
          ))}
        </View>
      )}

      {myRole !== null && (
        <Text className="tm__me">
          你是{myRole === 'LEADER' ? '主导者，可邀请与移出参与人' : '参与者，可一起编辑行程与清单'}
        </Text>
      )}
      {ended && (
        <Text className="tm__me" style={{ borderTop: 'none', paddingTop: 4, marginTop: 4 }}>
          行程已结束，参与人名单锁定
        </Text>
      )}
    </View>
  );
}

function MemberRow({
  member,
  canRemove,
  onRemoved,
}: {
  member: TripMember;
  canRemove: boolean;
  onRemoved: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const remove = useCallback(async () => {
    const res = await Taro.showModal({
      title: '移出参与人',
      content: `确定把「${member.displayName}」移出这次行程？对方的既有安排与账目会保留。`,
      confirmText: '移出',
      confirmColor: '#e5484d',
    });
    if (!res.confirm) return;
    setBusy(true);
    try {
      await api.removeTripMember(member.id);
      onRemoved();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '移出失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }, [member.id, member.displayName, onRemoved]);

  return (
    <View className="tm__item">
      <View className="tm__avatar">
        <Text>{member.displayName.slice(0, 1)}</Text>
      </View>
      <View className="tm__body">
        <View className="tm__name-line">
          <Text className="tm__name">{member.displayName}</Text>
          {member.role === 'LEADER' && <Text className="tm__tag tm__tag--leader">主导</Text>}
          {member.isExternal && <Text className="tm__tag">外部</Text>}
          {member.managedBy !== null && <Text className="tm__tag">代管</Text>}
        </View>
        <Text className="tm__sub">
          {member.accessLevel === 'HISTORICAL_READONLY' ? '已归档 · 只读' : '一起出行'}
        </Text>
      </View>
      {canRemove && (
        <View
          className={`icon-btn icon-btn--danger ${busy ? 'icon-btn--busy' : ''}`}
          onClick={busy ? undefined : () => void remove()}
        >
          <Icon name="close" size={14} />
        </View>
      )}
    </View>
  );
}

export default TripManagePage;
