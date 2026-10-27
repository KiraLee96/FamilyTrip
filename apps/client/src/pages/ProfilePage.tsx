/**
 * 我的页 —— 账号态 + 我的家庭（tab：2026-10-14 账号管理回归）
 * ============================================================================
 * 能力：
 *   · 登录状态：展示当前用户；未登录可「重新登录」（微信生态无显式登出，重回无感态）
 *   · 头像更换：2026-10-16 需求① —— 点击头像更换，小程序端支持「微信头像」
 *     （Button openType=chooseAvatar），H5 端走相册；落库 PATCH /auth/me
 *   · 昵称编辑：2026-10-16 需求② —— 微信 jscode2session 不下发昵称头像，
 *     首登用户昵称为服务端默认值（用户xxxx）；点击昵称行即可改名，
 *     同样走 PATCH /auth/me + patchSessionUser 本地广播
 *   · 我的家庭：增（新建）/ 删（解散）/ 改（改名）/ 查（成员列表）
 *   · 成员管理：**不区分爸爸妈妈等角色、无人数上限**，仅区分「管理员 / 成员」——
 *     创建家庭者即管理员；邀请制新增成员：展示邀请码 / 复制 / 分享，
 *     对方点开分享链接即落到 JoinFamilyPage 凭码加入
 *
 * 数据源：api.listFamilies / getFamily / createFamily / updateFamily / dissolveFamily
 *         / addFamilyMember / removeFamilyMember / updateMe（Mock 与真后端同形）
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View, Input, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { Family, FamilyDetail, FamilyMember, User } from '../api/types';
import { patchSessionUser, retryLogin } from '../api/session';
import { navigate } from '../nav';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { SectionTitle } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { useSession } from '../hooks/useSession';
import { buildJoinLink, copyText } from '../utils/clipboard';
import { pickAndUploadAvatar, uploadAvatarImage } from '../utils/upload';

/** 编译期常量：分享面板在小程序是原生能力，H5 只能给链接（不 fork 组件，只分行为） */
const IS_WEAPP = process.env.TARO_ENV === 'weapp';

/*
 * 2026-10-27 反馈④第三次：「物品清单还是要作为一个 tab」——
 * 清单已恢复为一级 tabBar 入口（pages/ItemsPage），本页不再保留二级 tab。
 * 🔴 同一功能不能既有 tab 又有页内入口，那正是用户最初嫌"混乱"的根源。
 */

export function ProfilePage() {
  const user = useSession();
  // 分享卡片携带的邀请信息（由展开的家庭卡片回填）
  const shareRef = useRef<{ code: string; name: string } | null>(null);

  const q = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  /**
   * 分享卡片必须**常驻**邀请码，不能只在「展开家庭卡片」时才回填。
   * ==========================================================================
   * 反馈「家庭邀请码分享之后无效」的根因之一：原实现只在卡片展开的瞬间写
   * shareRef，用户直接从右上角菜单转发 → shareRef 为 null → 分享路径不带
   * invite 参数 → 对方打开只有空表单，看起来就是「码无效」。
   * 这里在家庭列表到位后先兜底成第一个有邀请码的家庭，展开时再覆盖成具体那家。
   */
  useEffect(() => {
    const families = q.data ?? [];
    const first = families.find((f) => (f.inviteCode ?? '') !== '');
    if (first?.inviteCode !== undefined && shareRef.current === null) {
      shareRef.current = { code: first.inviteCode, name: first.name };
    }
  }, [q.data]);

  Taro.useShareAppMessage(() => {
    const s = shareRef.current;
    return s
      ? { title: `加入「${s.name}」一起出行`, path: `/pages/JoinFamilyPage?invite=${s.code}` }
      : { title: '来加入我的家庭出行计划', path: '/pages/JoinFamilyPage' };
  });

  Taro.useDidShow(() => {
    q.reload();
  });

  return (
    <PageLayout title="我的" sub="账号与家庭成员">
      <AccountCard user={user} />

      {/* 管理入口：家里各种要维护的数据，从一个地方进 */}
      <SectionTitle icon="package">管理</SectionTitle>
      <View className="mgmt-grid">
        <MgmtEntry
          icon="heart"
          label="心愿池"
          hint="想去的地方"
          onClick={() => navigate('/wishes')}
        />
        <MgmtEntry
          icon="sparkles"
          label="回忆墙"
          hint="出行档案"
          onClick={() => navigate('/memory')}
        />
      </View>

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

/** 管理入口宫格单项 */
function MgmtEntry({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: 'package' | 'map' | 'heart' | 'sparkles';
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <View className="mgmt-entry" onClick={onClick}>
      <Text className="mgmt-entry__icon">
        <Icon name={icon} size={18} />
      </Text>
      <View className="mgmt-entry__body">
        <Text className="mgmt-entry__label">{label}</Text>
        <Text className="mgmt-entry__hint">{hint}</Text>
      </View>
      <Text className="mgmt-entry__chev">
        <Icon name="chevron-right" size={14} />
      </Text>
    </View>
  );
}

/**
 * 账号卡 —— 头像（可更换）+ 昵称 + 时区 + 重新登录
 * ============================================================================
 * 2026-10-16 需求①：头像可修改，且允许使用微信头像。
 * 双端口径（不 fork，按运行环境二选一）：
 *   · 小程序：<Button openType="chooseAvatar"> —— 微信官方头像选择器
 *     （含历史头像），回调 detail.avatarUrl 为临时文件，走媒体链路上传固化
 *     后 PATCH /auth/me 落库；这是微信生态「用微信头像」的唯一正规入口。
 *   · H5：无 chooseAvatar，点击头像走 Taro.chooseImage（相册）同一条上传链路。
 * 成功后 patchSessionUser 本地广播，首页/我的页头像即时一致（不发额外请求）。
 */
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
        <Avatar user={user} size={46} />
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
    <>
      <View className="card profile-card">
        <AvatarPicker user={user} />
        <View className="profile-card__body">
          <NicknameEditor user={user} />
          <Text className="profile-card__sub">{user.homeTimezone ?? 'Asia/Shanghai'}</Text>
        </View>
        <View
          className={`icon-btn ${busy ? 'icon-btn--busy' : ''}`}
          onClick={busy ? undefined : () => void relogin()}
        >
          <Icon name="link" size={16} />
        </View>
      </View>
      <Text className="muted" style={{ fontSize: 11.5, margin: '-4px 2px 10px' }}>
        点击头像可更换；小程序端可选用微信头像
      </Text>
    </>
  );
}

/** 头像 + 相机徽标；点击（小程序为 chooseAvatar 按钮）触发更换流程 */
function AvatarPicker({ user }: { user: User }) {
  const [busy, setBusy] = useState(false);
  const isWeb = Taro.getEnv() === Taro.ENV_TYPE.WEB;

  /** 上传 → 落库 → 本地广播，三条链路共用同一收尾 */
  const save = useCallback(async (avatarUrl: string) => {
    const updated = await api.updateMe({ avatarUrl });
    patchSessionUser(updated);
    void Taro.showToast({ title: '头像已更新', icon: 'success' });
  }, []);

  const applyTempFile = useCallback(
    async (tempPath: string) => {
      if (tempPath === '') return;
      setBusy(true);
      try {
        const { avatarUrl } = await uploadAvatarImage(tempPath);
        await save(avatarUrl);
      } catch (e: unknown) {
        void Taro.showToast({
          title: e instanceof Error ? e.message : '头像更新失败',
          icon: 'none',
        });
      } finally {
        setBusy(false);
      }
    },
    [save],
  );

  const pickFromAlbum = useCallback(async () => {
    setBusy(true);
    try {
      const { avatarUrl } = await pickAndUploadAvatar();
      await save(avatarUrl);
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '头像更新失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }, [save]);

  const body = (
    <>
      <Avatar user={user} size={46} />
      <View className="avatar-pick__badge">
        <Icon name="camera" size={11} />
      </View>
    </>
  );

  if (isWeb) {
    return (
      <View
        className={`avatar-pick ${busy ? 'avatar-pick--busy' : ''}`}
        style={{ width: 46, height: 46 }}
        onClick={busy ? undefined : () => void pickFromAlbum()}
      >
        {body}
      </View>
    );
  }

  return (
    <Button
      className={`avatar-pick ${busy ? 'avatar-pick--busy' : ''}`}
      style={{ width: 46, height: 46 }}
      disabled={busy}
      openType="chooseAvatar"
      onChooseAvatar={(e) => {
        // 微信官方头像选择器回调：detail.avatarUrl 为本地临时文件路径
        const detail = e.detail as { avatarUrl?: string };
        if (typeof detail.avatarUrl === 'string') void applyTempFile(detail.avatarUrl);
      }}
    >
      {body}
    </Button>
  );
}

/**
 * 昵称行 —— 常态展示，点击进入就地编辑（Input + 保存/取消）
 * ============================================================================
 * 2026-10-16 需求②：微信 jscode2session 只换 openid，不下发昵称；首登用户
 * 昵称是服务端默认值（用户xxxx）。若不提供改名入口，「我的」页会永远显示
 * 默认昵称——真实 exchanger 只解决「身份不再漂移」，改名靠这里落库。
 * 落库走 PATCH /auth/me（schema：1–64 字，前端先挡一轮），成功后
 * patchSessionUser 本地广播，首页/我的页即时一致（不发额外请求）。
 * 编辑态与 RenameRow 同一模式：未改动直接收起，空值/超长前端先报错。
 */
function NicknameEditor({ user }: { user: User }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(user.nickname);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = useCallback(() => {
    setDraft(user.nickname);
    setErr('');
    setEditing(true);
  }, [user.nickname]);

  const cancel = useCallback(() => {
    setEditing(false);
    setErr('');
  }, []);

  const save = useCallback(async () => {
    const nickname = draft.trim();
    if (nickname === '') {
      setErr('昵称不能为空');
      return;
    }
    if (nickname.length > 64) {
      setErr('昵称最多 64 字');
      return;
    }
    if (nickname === user.nickname) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const updated = await api.updateMe({ nickname });
      patchSessionUser(updated);
      void Taro.showToast({ title: '昵称已更新', icon: 'success' });
      setEditing(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }, [draft, user.nickname]);

  if (!editing) {
    return (
      <View className="profile-card__name-row" onClick={open}>
        <Text className="profile-card__name">{user.nickname}</Text>
        <View className="icon-btn" style={{ width: 22, height: 22 }}>
          <Icon name="edit" size={12} />
        </View>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 2 }}>
      <View style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          className="add-row__input"
          style={{ height: 32, fontSize: 14 }}
          value={draft}
          onInput={(e) => setDraft(e.detail.value)}
          placeholder="输入昵称"
          focus
        />
        <View
          className={`add-row__btn ${busy ? 'add-row__btn--off' : ''}`}
          style={{ height: 32 }}
          onClick={busy ? undefined : () => void save()}
        >
          {busy ? '…' : '保存'}
        </View>
        <Text className="card__more" onClick={cancel}>
          取消
        </Text>
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
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
                  {/* selectable：复制通道全失败时，用户能长按选中这几个字符（最后一道兜底） */}
                  <Text className="invite__code" selectable>
                    {inviteCode ?? '——'}
                  </Text>
                </View>
                <View className="invite__ops">
                  <View
                    className={`btn btn--ghost invite__btn ${inviteCode ? '' : 'btn--busy'}`}
                    onClick={inviteCode ? () => void copyCode(inviteCode) : undefined}
                  >
                    <Icon name="copy" size={14} />
                    复制
                  </View>
                  {/*
                    分享分流（2026-10-26 修复「分享之后无效」）：
                      · 小程序：<Button openType="share"> 唤起原生转发面板，path 带 invite
                      · H5：没有转发面板，openType="share" 点了完全没反应 —— 改成
                        「复制加入链接」，把可粘贴的 URL 发给对方，这才是 Web 端的正解
                  */}
                  {IS_WEAPP ? (
                    <Button className="btn btn--ghost invite__btn invite__share" openType="share">
                      <Icon name="share" size={14} />
                      分享
                    </Button>
                  ) : (
                    <View
                      className={`btn btn--ghost invite__btn ${inviteCode ? '' : 'btn--busy'}`}
                      onClick={inviteCode ? () => void copyJoinLink(inviteCode) : undefined}
                    >
                      <Icon name="share" size={14} />
                      复制链接
                    </View>
                  )}
                </View>
              </View>
              {inviteCode ? (
                <Text className="invite__hint">
                  {IS_WEAPP
                    ? '把邀请码或分享链接发给家人，对方点开即可加入'
                    : '把邀请码或复制的链接发给家人，对方打开链接即可加入'}
                </Text>
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
          {member.role === 'OWNER' ? '管理员' : '成员'}
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

/** 复制邀请码到剪贴板（H5 / 小程序共用，实现见 utils/clipboard 的三档降级） */
function copyCode(code: string): void {
  void copyText(code, '邀请码已复制');
}

/** 复制「凭邀请码加入」的链接（H5 专用：没有转发面板时的分享正解） */
function copyJoinLink(code: string): void {
  void copyText(buildJoinLink(code), '加入链接已复制');
}

/** 解散家庭：二次确认后调用（仅管理员可操作，后端校验） */
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
