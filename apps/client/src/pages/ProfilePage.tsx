/**
 * 我的页 —— 账号态 + 我的家庭（反馈 #1）
 * ============================================================================
 * 能力：
 *   · 登录状态：展示当前用户；未登录可「重新登录」（微信生态无显式登出，重回无感态）
 *   · 我的家庭：增（新建）/ 删（解散）/ 改（改名）/ 查（成员列表）
 *   · 成员管理：无角色概念、无人数上限；邀请制 —— 展示邀请码 / 复制 / 分享，
 *     对方点开分享链接即落到 JoinFamilyPage 凭码加入
 *
 * 数据源：api.listFamilies / getFamily / createFamily / updateFamily / dissolveFamily
 *         / addFamilyMember / removeFamilyMember（Mock 与真后端同形）
 */

import { useCallback, useRef, useState } from 'react';
import { Text, View, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { Family, FamilyDetail, FamilyMember, User } from '../api/types';
import { navigate } from '../nav';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { SectionTitle } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { retryLogin } from '../api/session';
import { useSession } from '../hooks/useSession';

export function ProfilePage() {
  const user = useSession();
  // 分享卡片携带的邀请信息（由展开的家庭卡片回填）
  const shareRef = useRef<{ code: string; name: string } | null>(null);

  Taro.useShareAppMessage(() => {
    const s = shareRef.current;
    return s
      ? { title: `加入「${s.name}」一起出行`, path: `/pages/JoinFamilyPage?invite=${s.code}` }
      : { title: '来加入我的家庭出行计划', path: '/pages/JoinFamilyPage' };
  });

  const q = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  Taro.useDidShow(() => {
    q.reload();
  });

  return (
    <PageLayout title="我的" sub="账号与家庭成员">
      <AccountCard user={user} />

      <SectionTitle icon="users">我的家庭</SectionTitle>
      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox message={q.error} onRetry={q.reload} />
      ) : (
        <>
          {(q.data ?? []).length === 0 ? (
            <Empty text="还没有家庭，下面新建一个或凭邀请码加入" />
          ) : (
            (q.data ?? []).map((f) => (
              <FamilyCard
                key={f.id}
                family={f}
                onChanged={q.reload}
                onShareInfo={(info) => (shareRef.current = info)}
              />
            ))
          )}
        </>
      )}

      <CreateFamilyForm onCreated={q.reload} />

      <View className="add-bar" onClick={() => navigate('/join')}>
        <Icon name="link" size={16} />
        <Text className="add-bar__text">凭邀请码加入家庭</Text>
      </View>
    </PageLayout>
  );
}

function AccountCard({ user }: { user: User | undefined }) {
  const [busy, setBusy] = useState(false);

  const relogin = useCallback(async () => {
    setBusy(true);
    try {
      await retryLogin();
      void Taro.showToast({ title: '已重新登录', icon: 'none' });
    } catch {
      void Taro.showToast({ title: '登录失败，请重试', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }, []);

  if (!user) {
    return (
      <View className="card profile-card">
        <View className="profile-card__avatar">
          <Icon name="user" size={26} />
        </View>
        <View className="profile-card__body">
          <Text className="profile-card__name">未登录</Text>
          <Text className="profile-card__sub">登录后可创建/加入家庭</Text>
        </View>
        <View
          className={`btn btn--ghost ${busy ? 'btn--busy' : ''}`}
          onClick={busy ? undefined : () => void relogin()}
        >
          {busy ? '登录中…' : '重新登录'}
        </View>
      </View>
    );
  }

  return (
    <View className="card profile-card">
      <View className="profile-card__avatar">
        <Icon name="user" size={26} />
      </View>
      <View className="profile-card__body">
        <Text className="profile-card__name">{user.nickname}</Text>
        <Text className="profile-card__sub">{user.homeTimezone ?? 'Asia/Shanghai'}</Text>
      </View>
      <View
        className={`icon-btn ${busy ? 'icon-btn--busy' : ''}`}
        onClick={busy ? undefined : () => void relogin()}
      >
        <Icon name="link" size={16} />
      </View>
    </View>
  );
}

/** 单个家庭卡片：折叠态只显示概要；展开后拉取成员/邀请码，提供改名/解散/成员增删 */
function FamilyCard({
  family,
  onChanged,
  onShareInfo,
}: {
  family: Family;
  onChanged: () => void;
  onShareInfo: (info: { code: string; name: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = useAsync(
    useCallback(
      () => (open ? api.getFamily(family.id) : Promise.resolve<FamilyDetail | null>(null)),
      [open, family.id],
    ),
    [open, family.id],
  );

  const rerun = useCallback(() => {
    detail.reload();
    onChanged();
  }, [detail, onChanged]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next && family.inviteCode) onShareInfo({ code: family.inviteCode, name: family.name });
      return next;
    });
  }, [family.inviteCode, family.name, onShareInfo]);

  const live = detail.data?.family;
  const inviteCode = live?.inviteCode ?? family.inviteCode;
  const members = detail.data?.members ?? [];

  return (
    <View className="card family-card">
      <View className="family-card__head" onClick={toggle}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text className="family-card__name">{family.name}</Text>
          <Text className="family-card__sub">{family.memberCount} 位成员</Text>
        </View>
        <Text className={`chev ${open ? 'rotate-180' : ''}`}>
          <Icon name="chevron-right" size={18} />
        </Text>
      </View>

      {open ? (
        <View className="family-card__detail">
          {detail.loading ? (
            <Loading text="读取成员…" />
          ) : detail.error ? (
            <ErrorBox message={detail.error} onRetry={detail.reload} />
          ) : (
            <>
              <View className="invite">
                <View className="invite__body">
                  <Text className="invite__label">邀请码</Text>
                  <Text className="invite__code">{inviteCode ?? '——'}</Text>
                </View>
                <View className="invite__ops">
                  <View
                    className={`btn btn--ghost invite__btn ${inviteCode ? '' : 'btn--busy'}`}
                    onClick={inviteCode ? () => copyCode(inviteCode) : undefined}
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
              {inviteCode ? (
                <Text className="invite__hint">把邀请码或分享链接发给家人，对方点开即可加入</Text>
              ) : null}

              <Text className="family-card__label">成员（{members.length}）</Text>
              {members.map((m) => (
                <MemberRow key={m.id} member={m} onRemoved={rerun} />
              ))}

              <AddMemberRow familyId={family.id} onAdded={rerun} />

              <RenameRow family={live ?? family} onRenamed={rerun} />

              <View
                className="btn btn--danger btn--block"
                onClick={() => dissolve(family.id, family.name, onChanged)}
              >
                解散家庭
              </View>
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function MemberRow({ member, onRemoved }: { member: FamilyMember; onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);

  const remove = useCallback(async () => {
    const res = await Taro.showModal({
      title: '移除成员',
      content: `确定把「${member.displayName}」移出家庭？`,
      confirmText: '移除',
      confirmColor: '#e5484d',
    });
    if (!res.confirm) return;
    setBusy(true);
    try {
      await api.removeFamilyMember(member.id);
      onRemoved();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '移除失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }, [member.id, member.displayName, onRemoved]);

  return (
    <View className="member">
      <View className="member__avatar">
        <Icon name="user" size={16} />
      </View>
      <View className="member__body">
        <Text className="member__name">{member.displayName}</Text>
        <Text className="member__sub">
          {member.role === 'OWNER' ? '户主' : '成员'}
          {member.isVirtual ? ' · 代管' : ''}
        </Text>
      </View>
      {member.role !== 'OWNER' ? (
        <View
          className={`icon-btn icon-btn--danger ${busy ? 'icon-btn--busy' : ''}`}
          onClick={busy ? undefined : () => void remove()}
        >
          <Icon name="close" size={14} />
        </View>
      ) : null}
    </View>
  );
}

function AddMemberRow({ familyId, onAdded }: { familyId: string; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const add = useCallback(async () => {
    if (name.trim() === '') {
      setErr('请输入成员称呼');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      // 无微信账号的家人按「虚拟成员」登记（与后端 isVirtual 语义一致）
      await api.addFamilyMember(familyId, { displayName: name.trim(), isVirtual: true });
      setName('');
      onAdded();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '添加失败');
    } finally {
      setBusy(false);
    }
  }, [name, familyId, onAdded]);

  return (
    <View className="add-row">
      <Input
        className="add-row__input"
        value={name}
        onInput={(e) => setName(e.detail.value)}
        placeholder="添加家人称呼（如：奶奶）"
      />
      <View
        className={`add-row__btn ${busy || name.trim() === '' ? 'add-row__btn--off' : ''}`}
        onClick={busy ? undefined : () => void add()}
      >
        {busy ? '…' : '添加'}
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
    </View>
  );
}

function RenameRow({ family, onRenamed }: { family: Family; onRenamed: () => void }) {
  const [name, setName] = useState(family.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // 家庭详情刷新后同步输入框（仅当用户未改动时）
  const dirty = name !== family.name;

  const save = useCallback(async () => {
    if (name.trim() === '' || !dirty) return;
    setBusy(true);
    setErr('');
    try {
      await api.updateFamily(family.id, { name: name.trim() });
      onRenamed();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '改名失败');
    } finally {
      setBusy(false);
    }
  }, [name, dirty, family.id, onRenamed]);

  return (
    <View className="field">
      <Text className="field__label">家庭名称</Text>
      <View className="add-row" style={{ marginTop: 0 }}>
        <Input
          className="add-row__input"
          value={name}
          onInput={(e) => setName(e.detail.value)}
          placeholder="家庭名称"
        />
        <View
          className={`add-row__btn ${busy || !dirty ? 'add-row__btn--off' : ''}`}
          onClick={busy ? undefined : () => void save()}
        >
          {busy ? '…' : '保存'}
        </View>
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
    </View>
  );
}

function CreateFamilyForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = useCallback(async () => {
    if (name.trim() === '') {
      setErr('请输入家庭名称');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.createFamily({ name: name.trim() });
      setName('');
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }, [name, onCreated]);

  if (!open) {
    return (
      <View className="add-bar" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        <Text className="add-bar__text">新建家庭</Text>
      </View>
    );
  }

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">新建家庭</Text>
        <Text className="card__more" onClick={() => setOpen(false)}>
          取消
        </Text>
      </View>
      <View className="field">
        <Text className="field__label">家庭名称</Text>
        <Input
          className="input"
          value={name}
          onInput={(e) => setName(e.detail.value)}
          placeholder="如：我们一家"
        />
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
      <View
        className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : () => void create()}
      >
        {busy ? '创建中…' : '创建'}
      </View>
    </View>
  );
}

/** 复制邀请码到剪贴板（H5 / 小程序共用 Taro API） */
function copyCode(code: string): void {
  void Taro.setClipboardData({ data: code })
    .then(() => {
      void Taro.showToast({ title: '邀请码已复制', icon: 'none' });
    })
    .catch(() => {
      void Taro.showToast({ title: '复制失败，请手动记录', icon: 'none' });
    });
}

/** 解散家庭：二次确认后调用（仅户主可操作，后端校验） */
function dissolve(familyId: string, name: string, onDone: () => void): void {
  void Taro.showModal({
    title: '解散家庭',
    content: `确定解散「${name}」？该操作不可撤销，所有成员将离开。`,
    confirmText: '解散',
    confirmColor: '#e5484d',
  }).then(async (res) => {
    if (!res.confirm) return;
    try {
      await api.dissolveFamily(familyId);
      onDone();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '解散失败', icon: 'none' });
    }
  });
}

export default ProfilePage;
