/**
 * 家庭成员「昵称 + 称呼」双行投影（纯函数）
 * ============================================================================
 * 两个字段各管一件事（2026-11-06 产品口径）：
 *   · `nickname`    —— 账号昵称，本人可随时改，**权威源**
 *   · `displayName` —— 家里 / 行程里的**称呼**（「爸爸」「二姨」），由家人设定
 *
 * 界面：主行显示昵称，副行用灰字显示称呼（两者不同时才有副行）。
 *   例：账号叫「小珂」、家里称「爸爸」→ 主行「小珂」/ 灰字「爸爸」。
 *
 * 🔴 昵称的三个来源，优先级从高到低：
 *   ① `member.nickname`（后端 2026-11-06 起随成员行返回，最准）
 *   ② 本人会话里的 `currentUser.nickname`（后端未部署时兜底，只对本人行有效）
 *   ③ 退回 `displayName`（虚拟成员 / 老数据）
 *
 * 🔴 本人行在**后端没返回 nickname** 时，不把 displayName 当称呼展示：
 *    那种情况下 displayName 很可能只是「旧昵称副本」（老后端的快照语义），
 *    显示出来就是「新昵称 + 灰色旧昵称」的伪 bug。宁可少一行，不要误导。
 *
 * 这是渲染期投影，不写回、不请求、不动 ApiClient 契约。
 */
import type { FamilyMember, User } from '../api/types';

export interface MemberLabels {
  /** 主行：账号昵称优先，取不到退回称呼，最后兜底「未命名成员」 */
  primary: string;
  /** 副行补充的称呼；与主行相同、或不可信时为 null（不渲染） */
  alias: string | null;
}

/** 判断这行成员是不是当前登录用户本人 */
function isSelf(member: FamilyMember, currentUser: User | undefined): boolean {
  return (
    member.userId !== null &&
    member.userId !== '' &&
    currentUser !== undefined &&
    currentUser.id !== '' &&
    member.userId === currentUser.id
  );
}

/**
 * @param member      家庭 / 行程详情返回的成员行
 * @param currentUser 当前登录会话（改名后由 patchSessionUser 换引用广播）
 */
export function memberLabels(member: FamilyMember, currentUser: User | undefined): MemberLabels {
  // 防御运行时缺字段：契约类型是 string，但老后端 / Mock 可能漏传
  const display = (member.displayName ?? '').trim();
  const backendNickname = (member.nickname ?? '').trim();
  const self = isSelf(member, currentUser);
  const selfNickname = self ? (currentUser?.nickname ?? '').trim() : '';

  const nickname = backendNickname !== '' ? backendNickname : selfNickname;
  const primary = nickname !== '' ? nickname : display !== '' ? display : '未命名成员';

  // 本人行 + 后端没给 nickname → displayName 不可信（可能是旧昵称副本），不展示
  const aliasTrusted = backendNickname !== '' || !self;
  const alias = aliasTrusted && display !== '' && display !== primary ? display : null;

  return { primary, alias };
}

/**
 * 只要主行文案时的简化入口（移除确认弹窗等场景）。
 * @returns 恒为非空字符串
 */
export function memberDisplayName(member: FamilyMember, currentUser: User | undefined): string {
  return memberLabels(member, currentUser).primary;
}
