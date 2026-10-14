/**
 * 加入家庭页 —— 凭邀请码加入（反馈 #1 邀请制的落地页）
 * ============================================================================
 * 入口两条：
 *   1) 分享链接：/pages/JoinFamilyPage?invite=CODE（微信卡片 / H5 链接）
 *   2) 我的页「凭邀请码加入家庭」手动输入
 * 加入成功 → Taro.showToast → 切回「我的」tab 查看新家庭。
 */

import { useCallback, useState } from 'react';
import { Text, View, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import { navigate, back, useRouteParams } from '../nav';
import { Icon } from '../components/Icon';
import { PageLayout } from '../components/PageLayout';

export function JoinFamilyPage() {
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
      const result = await api.joinFamily({
        inviteCode: code.trim().toUpperCase(),
        ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
      });
      void Taro.showToast({
        title: result.alreadyMember
          ? `已是「${result.family.name}」成员`
          : `已加入「${result.family.name}」`,
        icon: 'none',
      });
      // 切回「我的」tab（switchTab，非压栈）
      setTimeout(() => navigate('/profile'), 800);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '加入失败');
    } finally {
      setBusy(false);
    }
  }, [code, displayName]);

  return (
    <PageLayout title="加入家庭" sub="输入邀请码，和家人的行程同步在一起">
      <View className="card">
        <View className="field">
          <Text className="field__label">邀请码</Text>
          <Input
            className="input"
            value={code}
            onInput={(e) => setCode(e.detail.value.toUpperCase())}
            placeholder="8 位邀请码，如 QM2K7X9W"
            maxlength={8}
          />
        </View>
        <View className="field">
          <Text className="field__label">我的称呼（可选）</Text>
          <Input
            className="input"
            value={displayName}
            onInput={(e) => setDisplayName(e.detail.value)}
            placeholder="加入后家人看到的称呼"
          />
        </View>
        {err ? <Text className="form-error">{err}</Text> : null}
        <View
          className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
          onClick={busy ? undefined : () => void join()}
        >
          {busy ? '加入中…' : '加入家庭'}
        </View>
      </View>

      <View className="card card--flush join-tip">
        <Text className="join-tip__title">
          <Icon name="link" size={14} /> 怎么拿邀请码？
        </Text>
        <Text className="join-tip__text">
          让已加入的家人在「我的 →
          我的家庭」里展开家庭卡片，把邀请码或分享链接发给你，点开即可加入。
        </Text>
      </View>

      <View className="btn btn--ghost btn--block" onClick={back}>
        返回
      </View>
    </PageLayout>
  );
}

export default JoinFamilyPage;
