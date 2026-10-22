/**
 * 邀请码生成 —— family 域与 trip 域共用
 * ============================================================================
 * 字符集去掉易混淆字符（0/O/1/I/l），降低口述/手抄出错率：
 * 家庭邀请码靠念给家人听，行程邀请码靠念给同行朋友听，出错代价同样高。
 *
 * 🔴 为什么抽到 common：
 *   family 与 trip 各留一份实现是明确的坏味道 —— 两处字符集一旦漂移，
 *   「前端 toUpperCase 后统一校验」的前提就被破坏，且排查时会误以为是
 *   「某个域的特例」。生成侧单点收敛后，字符集只有一处定义。
 *
 * 🔴 这里只负责**生成**，不负责查重。查重必须在调用方的事务里做
 *   （`findUnique({inviteCode, deletedAt:null})`），因为唯一性依赖库内现状。
 */

/** 去易混淆字符（0/O/1/I/l）后的 31 字符集：与 family 域既有实现完全一致 */
export const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 默认长度（family / trip 均为 8 位） */
export const INVITE_CODE_LENGTH = 8;

/**
 * 生成指定长度的邀请码。
 *
 * ⚠️ 用 `Math.random()` 而非 `crypto.randomBytes`：邀请码不是安全凭证
 *    （持有者仍须登录才能 join），但它**可被猜测枚举** —— 故 join 端点必须
 *    维持「未命中即 404 同形」+ 限流，不能仅靠长度防爆破。
 *    这一点已在 access-policy 的「越权与不存在逐字节一致」口径内。
 */
export function randomInviteCode(len: number = INVITE_CODE_LENGTH): string {
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
  }
  return out;
}

/** 邀请码合法性（供 schema / 测试共用）：只允许字符集内的大写字符 */
export const INVITE_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;
