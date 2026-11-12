/**
 * 家庭成员展示名投影回归
 * ============================================================================
 * 背景（2026-11-06 反馈）：改昵称后，「我的」页顶部名字变了，家庭成员里
 * 自己那一行还是旧名字。后端 family_member.display_name 是加入时的快照，
 * PATCH /auth/me 不回写；旧前端只在「空 / 等于家庭名」时兜底，旧昵称漏网。
 */
import { describe, expect, it } from 'vitest';
import type { FamilyMember, User } from '../../api/types';
import { memberDisplayName, memberLabels } from '../member-display';

function member(patch: Partial<FamilyMember> = {}): FamilyMember {
  return {
    id: 'm1',
    familyId: 'f1',
    userId: 'u1',
    role: 'OWNER',
    isVirtual: false,
    managedBy: null,
    displayName: '旧昵称',
    joinedAt: '2026-01-01T00:00:00.000Z',
    ...patch,
  };
}

function user(patch: Partial<User> = {}): User {
  return { id: 'u1', nickname: '新昵称', ...patch };
}

describe('memberDisplayName · 本人以账号昵称为准', () => {
  it('旧昵称快照 → 改昵称后显示新昵称（本次反馈）', () => {
    expect(memberDisplayName(member(), user())).toBe('新昵称');
  });

  it('老脏数据 displayName 等于家庭名 → 仍显示新昵称（反馈①不回归）', () => {
    expect(memberDisplayName(member({ displayName: '暑假旅行组' }), user())).toBe('新昵称');
  });

  it('displayName 为空字符串 → 显示新昵称', () => {
    expect(memberDisplayName(member({ displayName: '' }), user())).toBe('新昵称');
  });

  it('displayName 只有空白 → 显示新昵称', () => {
    expect(memberDisplayName(member({ displayName: '   ' }), user())).toBe('新昵称');
  });

  it('displayName 已等于新昵称 → 幂等，仍是新昵称', () => {
    expect(memberDisplayName(member({ displayName: '新昵称' }), user())).toBe('新昵称');
  });

  it('账号昵称带首尾空格 → 展示时去掉空格', () => {
    expect(memberDisplayName(member(), user({ nickname: '  小满  ' }))).toBe('小满');
  });

  it('会话更新后同一成员行立即跟随，无需 reload 家庭详情', () => {
    const row = member();
    expect(memberDisplayName(row, user({ nickname: '旧昵称' }))).toBe('旧昵称');
    expect(memberDisplayName(row, user({ nickname: '新昵称' }))).toBe('新昵称');
  });
});

describe('memberDisplayName · 不误伤其他成员', () => {
  it('他人 userId 不同 → 原样显示其 displayName', () => {
    expect(memberDisplayName(member({ userId: 'u2', displayName: '妈妈' }), user())).toBe('妈妈');
  });

  it('虚拟成员 userId 为 null → 原样显示，即使名字恰好等于家庭名', () => {
    expect(
      memberDisplayName(
        member({ userId: null, isVirtual: true, displayName: '暑假旅行组' }),
        user(),
      ),
    ).toBe('暑假旅行组');
  });

  it('会话未就绪（undefined）→ 按快照显示，不闪成未命名成员', () => {
    expect(memberDisplayName(member(), undefined)).toBe('旧昵称');
  });

  it('会话昵称为空白 → 按快照显示', () => {
    expect(memberDisplayName(member(), user({ nickname: '   ' }))).toBe('旧昵称');
  });

  it('会话 id 为空（老持久化副本）→ 不误判为本人', () => {
    expect(memberDisplayName(member(), user({ id: '' }))).toBe('旧昵称');
  });

  it('快照与会话昵称都为空 → 未命名成员', () => {
    expect(memberDisplayName(member({ displayName: '' }), user({ nickname: '' }))).toBe(
      '未命名成员',
    );
  });

  it('运行时缺 displayName 字段 → 不抛错，回退到账号昵称', () => {
    const broken = member() as unknown as Record<string, unknown>;
    delete broken['displayName'];
    expect(memberDisplayName(broken as unknown as FamilyMember, user())).toBe('新昵称');
  });
});

/**
 * 双行投影（2026-11-06 口径）：主行昵称，副行灰字称呼。
 * 后端从这一版起在成员行里返回 `nickname`，所以大多数场景以它为权威源。
 */
describe('memberLabels · 昵称主行 + 称呼副行', () => {
  it('账号叫「小珂」、家里称「爸爸」→ 主行小珂，副行爸爸（本次需求）', () => {
    const labels = memberLabels(
      member({ displayName: '爸爸', nickname: '小珂' }),
      user({ nickname: '小珂' }),
    );
    expect(labels.primary).toBe('小珂');
    expect(labels.alias).toBe('爸爸');
  });

  it('非本人成员也按后端 nickname 展示，不需要会话', () => {
    const labels = memberLabels(
      member({ userId: 'u2', displayName: '二姨', nickname: '李梅' }),
      user(),
    );
    expect(labels.primary).toBe('李梅');
    expect(labels.alias).toBe('二姨');
  });

  it('称呼与昵称相同 → 不出副行（避免重复）', () => {
    const labels = memberLabels(
      member({ displayName: '小珂', nickname: '小珂' }),
      user({ nickname: '小珂' }),
    );
    expect(labels.primary).toBe('小珂');
    expect(labels.alias).toBeNull();
  });

  it('虚拟成员（无账号）→ nickname 为 null，主行即称呼，无副行', () => {
    const labels = memberLabels(
      member({ userId: null, isVirtual: true, displayName: '奶奶', nickname: null }),
      user(),
    );
    expect(labels.primary).toBe('奶奶');
    expect(labels.alias).toBeNull();
  });

  it('后端没给 nickname 且是本人 → 主行用会话昵称，但不出副行（防伪 bug）', () => {
    // 老后端场景：displayName 还是旧昵称副本，若当称呼展示就是「新昵称 + 灰色旧昵称」
    const labels = memberLabels(member({ displayName: '旧昵称' }), user({ nickname: '新昵称' }));
    expect(labels.primary).toBe('新昵称');
    expect(labels.alias).toBeNull();
  });

  it('昵称带首尾空格 → 主行与副行都 trim 后比较', () => {
    const labels = memberLabels(
      member({ displayName: ' 爸爸 ', nickname: '  小珂 ' }),
      user({ nickname: '小珂' }),
    );
    expect(labels.primary).toBe('小珂');
    expect(labels.alias).toBe('爸爸');
  });

  it('nickname 为空串 → 视为未返回（本人退回会话昵称）', () => {
    const labels = memberLabels(
      member({ displayName: '爸爸', nickname: '' }),
      user({ nickname: '小珂' }),
    );
    expect(labels.primary).toBe('小珂');
    expect(labels.alias).toBeNull();
  });

  it('memberDisplayName 与 memberLabels.primary 同源（不会两套口径）', () => {
    const row = member({ displayName: '爸爸', nickname: '小珂' });
    expect(memberDisplayName(row, user({ nickname: '小珂' }))).toBe(
      memberLabels(row, user({ nickname: '小珂' })).primary,
    );
  });
});
