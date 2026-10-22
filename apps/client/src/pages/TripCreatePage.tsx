/**
 * 新建行程 —— 表单页（Taro 同构版）
 * ============================================================================
 * 契约：ApiClient.createTrip / addTripMember / getTripInvite 与 Mock 均已就绪
 *       （对齐后端 POST /trips、POST /trips/:id/members），本页只补 UI 层，
 *       不改任何接口签名。
 * PRD GRP-02：创建行程时应支持邀请任意用户（家庭成员或外部用户）作为参与者：
 *   ① 同行成员多选 —— 家庭成员（含无账号的虚拟成员）默认全选，可逐个取消；
 *      创建后经 addTripMember 批量入队（创建者由后端自动设为 LEADER，不重复加）。
 *   ② 外部成员邀请 —— 创建成功进入邀请步骤：展示行程邀请码（复制/分享/重置），
 *      对方点开分享链接落入 JoinTripPage 凭码加入（isExternal 外部同行者）。
 * 家庭选择：多家庭时用 Picker 切换（原型期曾写死取第一个家庭）。
 * 日期与地区都是**自绘组件**（不 fork、双端同一套）：
 *   · 出行日期 —— components/Calendar 的区间日历，一次点出出发/返程，替代原来两个
 *     原生 date picker（用户反馈：原生控件选不准、要弹两次、看不到总共几天）；
 *   · 目的地 —— components/RegionPicker 的两级地区选择（内置常用目的地 + 关键词搜索
 *     + 任意文本兜底），对应反馈「允许用户选择地区」。
 *
 * 邀请码取不到时的降级见 utils/constants 的 inviteUnavailableHint：后端端点
 * `/trips/:id/invite` 尚未落地（dispatcher 回 4040），界面不许把「资源不存在」原样抛给用户。
 */

import { useCallback, useMemo, useState } from 'react';
import { Button, Input, Picker, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { Destination, FamilyDetail, TripInvite } from '../api/types';
import { DateRangeSheet } from '../components/Calendar';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { RegionSheet } from '../components/RegionPicker';
import { navigate } from '../nav';
import { useAsync, type AsyncState } from '../hooks/useAsync';
import { useSession } from '../hooks/useSession';
import { rangeText } from '../utils/calendar';
import { copyText } from '../utils/clipboard';
import { defaultChecklistFor, inviteUnavailableHint } from '../utils/constants';

export function TripCreatePage() {
  const me = useSession();

  const familiesQ = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  // 多家庭时用户可切换；未选过则默认第一个（派生式，无需 effect 同步）
  const [pickedFamilyId, setPickedFamilyId] = useState<string | null>(null);
  const familyId = pickedFamilyId ?? familiesQ.data?.[0]?.id ?? '';

  const familyQ = useAsync(
    useCallback(
      () => (familyId ? api.getFamily(familyId) : Promise.resolve<FamilyDetail | null>(null)),
      [familyId],
    ),
    [familyId],
  );

  const members = familyQ.data?.members ?? [];
  const ownerMember = members.find((m) => m.role === 'OWNER');

  // 默认全选「除我以外」的家庭成员（创建者后端自动设 LEADER，无需手动勾选）
  const defaultSel = useMemo(
    () => new Set(members.filter((m) => m.userId !== me?.id).map((m) => m.id)),
    [members, me?.id],
  );
  // 用户手动勾选后的覆盖（按家庭 id 记忆，切家庭时恢复默认全选）
  const [override, setOverride] = useState<{ familyId: string; ids: Set<string> } | null>(null);
  const selectedIds = override?.familyId === familyId ? override.ids : defaultSel;

  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  /** 目的地（地区）：支持多个，整体随 createTrip 一起提交 */
  const [dests, setDests] = useState<Destination[]>([]);
  /** 区间日历 / 地区选择抽屉的开关（关掉即卸载，组件内部状态自然复位） */
  const [rangeOpen, setRangeOpen] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  // 创建成功 → 进入邀请步骤（邀请码查询 + 重置）
  const [created, setCreated] = useState<{ tripId: string; title: string } | null>(null);
  const inviteQ = useAsync(
    useCallback(
      () =>
        created ? api.getTripInvite(created.tripId) : Promise.resolve<TripInvite | null>(null),
      [created],
    ),
    [created],
  );
  const [resetBusy, setResetBusy] = useState(false);

  // 分享卡片：携带行程邀请码，对方点开落入 JoinTripPage 凭码加入
  Taro.useShareAppMessage(() => {
    const code = inviteQ.data?.inviteCode;
    return code
      ? {
          title: `一起来「${created?.title ?? '这次出行'}」`,
          path: `/pages/JoinTripPage?invite=${code}`,
        }
      : { title: '旅行管家AllInOne', path: '/pages/HomePage' };
  });

  // ─── 以下才允许早退（hooks 已全部声明） ───
  if (familiesQ.loading) return <Loading />;
  if (familiesQ.error) return <ErrorBox message={familiesQ.error} onRetry={familiesQ.reload} />;

  if (created) {
    return (
      <InviteStep
        tripTitle={created.title}
        memberCount={selectedIds.size + 1}
        invite={inviteQ}
        resetBusy={resetBusy}
        onReset={() => void resetInvite(created.tripId)}
        onEnter={() => navigate(`/trips/${created.tripId}`)}
      />
    );
  }

  const toggle = (id: string): void => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOverride({ familyId, ids: next });
  };

  const submit = async (): Promise<void> => {
    const name = title.trim();
    if (!name) {
      setFormError('先给这次出行起个名字吧');
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setFormError('结束日期不能早于出发日期');
      return;
    }
    if (familyId === '') {
      setFormError('还没有家庭，请先到「我的」页创建或加入一个');
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const trip = await api.createTrip({
        familyId,
        title: name,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
        ...(dests.length > 0 ? { destinations: dests } : {}),
      });
      // 勾选的同行成员批量入队（失败不阻塞创建，与默认清单播种同策略）
      const picks = members.filter((m) => selectedIds.has(m.id));
      if (picks.length > 0) {
        try {
          await Promise.all(
            picks.map((m) =>
              api.addTripMember(trip.id, {
                ...(m.userId !== null ? { userId: m.userId } : {}),
                ...(m.userId === null
                  ? {
                      displayName: m.displayName,
                      isVirtual: true,
                      ...(ownerMember ? { managedBy: ownerMember.id } : {}),
                    }
                  : {}),
              }),
            ),
          );
        } catch (e) {
          console.warn('[trip-create] 同行成员入队失败（不影响行程创建）：', e);
        }
      }
      // 播种默认清单（反馈 #5：新行程不该沿用上一个清单）
      // 往返票 / 住宿（按天算晚数）/ 证件 / 充电 —— 失败不阻塞跳转
      try {
        await Promise.all(
          defaultChecklistFor(startDate || null, endDate || null).map((seed) =>
            api.createChecklistItem({
              tripId: trip.id,
              familyId,
              name: seed.title,
              scope: seed.scope,
            }),
          ),
        );
      } catch (e) {
        console.warn('[trip-create] 默认清单播种失败（不影响行程创建）：', e);
      }
      setCreated({ tripId: trip.id, title: trip.title });
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  const resetInvite = async (tripId: string): Promise<void> => {
    const res = await Taro.showModal({
      title: '重置邀请码',
      content: '重置后旧邀请码立即作废，需要重新发给对方。确定重置？',
      confirmText: '重置',
    });
    if (!res.confirm) return;
    setResetBusy(true);
    try {
      await api.resetTripInvite(tripId);
      inviteQ.reload();
      void Taro.showToast({ title: '已重置', icon: 'success' });
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '重置失败', icon: 'none' });
    } finally {
      setResetBusy(false);
    }
  };

  const families = familiesQ.data ?? [];

  return (
    <PageLayout title="新建行程" sub="起个草，慢慢安排">
      <View className="card">
        <View className="field">
          <Text className="field__label">行程名称</Text>
          <Input
            className="input"
            placeholder="比如：国庆 · 青岛看海"
            value={title}
            maxlength={40}
            onInput={(e) => setTitle(e.detail.value)}
          />
        </View>

        {families.length > 1 ? (
          <View className="field">
            <Text className="field__label">所属家庭</Text>
            <Picker
              mode="selector"
              range={families.map((f) => f.name)}
              value={Math.max(
                0,
                families.findIndex((f) => f.id === familyId),
              )}
              onChange={(e) => {
                const f = families[Number(e.detail.value)];
                if (f) setPickedFamilyId(f.id);
              }}
            >
              <View className="picker-row">
                <Text className="picker-row__val">
                  {families.find((f) => f.id === familyId)?.name ?? '选择家庭'}
                </Text>
                <Icon name="chevron-right" size={16} className="rotate-90 muted" />
              </View>
            </Picker>
          </View>
        ) : null}

        <View className="field">
          <Text className="field__label">出行日期</Text>
          <View className="picker-row" onClick={() => setRangeOpen(true)}>
            <Text
              className={
                startDate || endDate ? 'picker-row__val' : 'picker-row__val picker-row__val--empty'
              }
            >
              {rangeText(startDate, endDate) || '点选出发与返程日期'}
            </Text>
            <Icon name="chevron-right" size={16} className="rotate-90 muted" />
          </View>
        </View>

        <View className="field">
          <Text className="field__label">目的地地区</Text>
          {dests.length > 0 && (
            <View className="dest-chips">
              {dests.map((d) => (
                <View key={d.name} className="chip">
                  <Icon name="map-pin" size={12} />
                  <Text className="dest-chips__name">{d.name}</Text>
                  <View
                    className="dest-chips__x"
                    onClick={() => setDests((prev) => prev.filter((x) => x.name !== d.name))}
                  >
                    <Icon name="close" size={10} />
                  </View>
                </View>
              ))}
            </View>
          )}
          <View className="add-bar" onClick={() => setRegionOpen(true)}>
            <Icon name="plus" size={15} />
            <Text className="add-bar__text">选择地区</Text>
          </View>
        </View>

        {formError ? <Text className="form-error">{formError}</Text> : null}

        <Button className="btn btn--block" disabled={submitting} onClick={() => void submit()}>
          {submitting ? '创建中…' : '创建行程'}
        </Button>
        <Text className="muted" style={{ marginTop: 10, textAlign: 'center' }}>
          创建后会带上往返票 / 住宿 / 证件等默认清单，可再补充日程与花销
        </Text>
      </View>

      {/* ── 同行成员多选（PRD GRP-02：家庭成员作为本次出行参与者） ── */}
      <View className="card">
        <View className="card__head">
          <Text className="card__title">同行成员</Text>
          <Text className="card__more">{selectedIds.size + 1} 人</Text>
        </View>
        {familyQ.loading ? (
          <Loading text="读取家庭成员…" />
        ) : familyQ.error ? (
          <ErrorBox message={familyQ.error} onRetry={familyQ.reload} />
        ) : members.length === 0 ? (
          <Text className="muted">这个家庭还没有成员，创建后可在「我的」页邀请家人</Text>
        ) : (
          members.map((m) => {
            const isMe = m.userId === me?.id;
            const on = isMe || selectedIds.has(m.id);
            return (
              <View
                key={m.id}
                className={`member member--pick ${on ? 'member--on' : ''}`}
                onClick={isMe ? undefined : () => toggle(m.id)}
              >
                <View className="member__avatar">
                  <Icon name="user" size={16} />
                </View>
                <View className="member__body">
                  <Text className="member__name">
                    {m.displayName}
                    {isMe ? '（我）' : ''}
                  </Text>
                  <Text className="member__sub">
                    {isMe ? '主导者' : m.isVirtual ? '代管成员' : '家庭成员'}
                  </Text>
                </View>
                <View className="pick-box">
                  <Icon name="check" size={13} />
                </View>
              </View>
            );
          })
        )}
        <Text className="muted" style={{ marginTop: 10 }}>
          默认带上全家；点按可取消。家庭外的朋友结伴，创建后生成邀请码发给对方即可加入
        </Text>
      </View>

      {/* 抽屉放在页面末尾：只在打开时挂载，内部临时选择状态随卸载自动复位 */}
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
          title="选择目的地地区"
          onCancel={() => setRegionOpen(false)}
          onConfirm={(city) => {
            setRegionOpen(false);
            setDests((prev) =>
              prev.some((d) => d.name === city) ? prev : [...prev, { name: city }],
            );
          }}
        />
      )}
    </PageLayout>
  );
}

/**
 * 邀请步骤 —— 创建成功后的外部成员邀请卡
 * ============================================================================
 * 展示行程邀请码（复制 / 分享 / 重置），分享链接落入 JoinTripPage。
 * 邀请接口（GET /trips/:id/invite）属新增后端契约：未就绪时降级提示，
 * 不阻塞「进入行程」—— Mock 模式下完整可用。
 */
function InviteStep({
  tripTitle,
  memberCount,
  invite,
  resetBusy,
  onReset,
  onEnter,
}: {
  tripTitle: string;
  memberCount: number;
  invite: AsyncState<TripInvite | null>;
  resetBusy: boolean;
  onReset: () => void;
  onEnter: () => void;
}) {
  const code = invite.data?.inviteCode ?? null;

  return (
    <PageLayout title="行程已创建" sub={tripTitle}>
      <View className="invite-step__done">
        <View className="invite-step__done-icon">
          <Icon name="check" size={22} />
        </View>
        <Text className="invite-step__done-title">「{tripTitle}」安排上了</Text>
        <Text className="invite-step__done-sub">{memberCount} 位家庭成员已加入</Text>
      </View>

      <View className="card">
        <View className="card__head">
          <Text className="card__title">邀请外部成员</Text>
          {code ? <Text className="card__more">结伴出行</Text> : null}
        </View>

        {invite.loading ? (
          <Loading text="生成邀请码…" />
        ) : invite.error ? (
          <>
            <Text className="form-error" style={{ marginTop: 4 }}>
              {inviteUnavailableHint(invite.error)}
            </Text>
            <View
              className="btn btn--ghost btn--block"
              style={{ marginTop: 10 }}
              onClick={() => invite.reload()}
            >
              重新获取邀请码
            </View>
          </>
        ) : code ? (
          <>
            <View className="invite">
              <View className="invite__body">
                <Text className="invite__label">行程邀请码</Text>
                <Text className="invite__code">{code}</Text>
              </View>
              <View className="invite__ops">
                <View
                  className="btn btn--ghost invite__btn"
                  onClick={() => copyText(code, '邀请码已复制')}
                >
                  <Icon name="copy" size={14} />
                  复制
                </View>
                <Button className="btn btn--ghost invite__btn invite__share" openType="share">
                  <Icon name="share" size={14} />
                  分享
                </Button>
              </View>
            </View>
            <Text className="invite__hint">
              把邀请码或分享链接发给家庭外的朋友，对方点开即可加入这次出行；出行结束后权限自动失效
            </Text>
            <View
              className={`btn btn--ghost btn--block ${resetBusy ? 'btn--busy' : ''}`}
              style={{ marginTop: 10 }}
              onClick={resetBusy ? undefined : onReset}
            >
              重置邀请码
            </View>
          </>
        ) : null}
      </View>

      <View className="btn btn--block" onClick={onEnter}>
        进入行程
      </View>
      <Text className="muted" style={{ marginTop: 10, textAlign: 'center' }}>
        之后也可以随时在行程详情页重新找到邀请码
      </Text>
    </PageLayout>
  );
}

export default TripCreatePage;
