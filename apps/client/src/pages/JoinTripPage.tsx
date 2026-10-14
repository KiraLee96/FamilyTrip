/**
 * 加入行程页 —— 凭行程邀请码加入（GRP-02 外部成员邀请的落地页）
 * ============================================================================
 * 入口两条：
 *   1) 分享链接：/pages/JoinTripPage?invite=CODE（微信卡片 / H5 链接，
 *      由 TripCreatePage 的邀请卡 useShareAppMessage 与 TripDetailPage 的
 *      「邀请同行」按钮生成）
 *   2) 行程详情页「凭邀请码加入」手动输入
 * 加入成功 → showToast → 跳转行程详情（replace，避免返回又回到加入页）。
 *
 * 说明：加入后成为行程 MEMBER（isExternal=true，不属该家庭，PRD §2.6
 * 临时家庭模型）；后端对「已结束行程」拒绝加入（GRP-08）。
 */

import { useCallback, useState } from 'react';
import { Text, View, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import { navigate, back, useRouteParams } from '../nav';
import { Icon } from '../components/Icon';
import { PageLayout } from '../components/PageLayout';

export function JoinTripPage() {
  const params = useRouteParams<{ invite?: string }>();
  const [code, setCode] = useState((params.invite ?? '').toUpperCase());
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const join = useCallback(async () => {
    if (code.trim() === '') {
      setErr('请输入邀请码');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const result = await api.joinTrip({
        inviteCode: code.trim().toUpperCase(),
        ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
      });
      void Taro.showToast({
        title: result.alreadyMember ? '你已在这场行程中' : `已加入「${result.trip.title}」`,
        icon: 'none',
      });
      // 用 redirect 替换当前页：返回键不会再回到加入页
      setTimeout(() => navigate(`/trips/${result.trip.id}`), 800);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '加入失败');
    } finally {
      setBusy(false);
    }
  }, [code, displayName]);

  return (
    <PageLayout title="加入行程" sub="输入邀请码，和家人朋友结伴同行">
      <View className="card">
        <View className="field">
          <Text className="field__label">邀请码</Text>
          <Input
            className="input"
            value={code}
            onInput={(e) => setCode(e.detail.value.toUpperCase())}
            placeholder="8 位邀请码"
            maxlength={8}
          />
        </View>
        <View className="field">
          <Text className="field__label">我的称呼（可选）</Text>
          <Input
            className="input"
            value={displayName}
            onInput={(e) => setDisplayName(e.detail.value)}
            placeholder="加入后同行者看到的称呼"
          />
        </View>
        {err ? <Text className="form-error">{err}</Text> : null}
        <View
          className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
          onClick={busy ? undefined : () => void join()}
        >
          {busy ? '加入中…' : '加入行程'}
        </View>
      </View>

      <View className="card card--flush join-tip">
        <Text className="join-tip__title">
          <Icon name="link" size={14} /> 怎么拿邀请码？
        </Text>
        <Text className="join-tip__text">
          让行程组织者在行程详情页点「邀请同行」，把邀请码或分享链接发给你，
          点开即可加入。加入后你能查看行程安排、心愿池和花销分摊。
        </Text>
      </View>

      <View className="btn btn--ghost btn--block" onClick={back}>
        返回
      </View>
    </PageLayout>
  );
}

export default JoinTripPage;
