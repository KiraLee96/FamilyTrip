/**
 * 真实微信登录 exchanger（生产路径）
 * ============================================================================
 * 契约与 `stubWechat()` 完全一致（`WechatCodeExchanger`），差别只在 openid 来源：
 *
 *   · 桩：`openid = openid_${code}` —— wx.login 每次返回的 code 都不同，
 *     于是**每次登录都是一个新 openid → 插入新用户行**，"我的"页永远显示
 *     默认昵称（`用户xxxx`）且资料改了就丢。这是线上默认值症状的根因。
 *   · 真实实现：走微信 `jscode2session` —— 同一微信用户的 openid 稳定，
 *     首登注册后账号可复用，资料修改才能落得住。
 *
 * 🔴 微信 jscode2session **不返回昵称 / 头像**（2022 年后小程序不再静默
 *    下发用户资料；头像走 chooseAvatar、昵称走用户手填，见 ProfilePage）。
 *    它的职责只有一个：把一次性 code 换成稳定 openid（+ unionid）。
 *
 * 🔴 secret 只出现在请求 query 里（微信 API 形态如此，无 body 替代）——
 *    因此**严禁打印完整 URL**；本文件的日志只输出 errcode/errmsg。
 *
 * 错误分档（对客户端不泄露微信侧细节，与服务层既有口径一致）：
 *   · 微信明确拒绝（code 无效 / 已复用 / 风控 / 限频）→ 4010 UNAUTHORIZED
 *   · 传输层失败（网络 / 超时 / 非 JSON 响应）→ 5000 INTERNAL_ERROR
 *   · 微信 -1 系统繁忙（重试后仍失败）→ 5000 INTERNAL_ERROR
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { WechatCodeExchanger } from './auth.service.js';

/** 微信 jscode2session 端点（HTTPS，无替代域名） */
const JSCode2SESSION_URL = 'https://api.weixin.qq.com/sns/jscode2session';

export interface Jscode2SessionOptions {
  appid: string;
  secret: string;
  /** 注入 fetch 便于测试；默认 globalThis.fetch（Node ≥ 18，Prisma 6 依赖栈已保证） */
  fetchImpl?: typeof fetch;
  /** 单次请求超时（ms），默认 5000 —— 登录是用户可感知的同步路径，不宜久等 */
  timeoutMs?: number;
  /** 传输层 / 微信 -1 系统忙的额外重试次数（不含首次），默认 1（共 2 次） */
  retries?: number;
}

/** 微信响应形状：成功带 openid，失败带 errcode */
interface WechatSessionResponse {
  openid?: string;
  session_key?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

/**
 * 构造真实 exchanger。
 *
 * 失败策略：抛 `AppError`（不返回 null）—— 调用方 `AuthService.login` 对 null
 * 的兜底分支保留给桩；真实实现必须区分「凭证被拒（4010）」与「上游不可用（5000）」，
 * 否则客户端无法判断该重试还是该重新登录。
 */
export function createJscode2SessionExchanger(o: Jscode2SessionOptions): WechatCodeExchanger {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const timeoutMs = o.timeoutMs ?? 5000;
  const maxRetries = o.retries ?? 1;

  return {
    async exchange(code: string): Promise<{ openid: string; unionid?: string }> {
      const url = new URL(JSCode2SESSION_URL);
      url.searchParams.set('appid', o.appid);
      url.searchParams.set('secret', o.secret);
      url.searchParams.set('js_code', code);
      url.searchParams.set('grant_type', 'authorization_code');

      // 总尝试次数 = 1 + maxRetries。仅传输层错误与微信 -1（系统繁忙）值得重试；
      // 其余 errcode（code 无效 / 已复用 / 风控 / 限频）重试无意义，立即失败。
      for (let attempt = 0; ; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let body: WechatSessionResponse;
        try {
          const res = await fetchImpl(url.toString(), {
            method: 'GET',
            signal: controller.signal,
          });
          body = (await res.json()) as WechatSessionResponse;
        } catch (e: unknown) {
          // 传输层失败：网络错误 / 超时 abort / 响应非 JSON
          if (attempt < maxRetries) continue;
          const reason = e instanceof Error ? e.message : String(e);
          console.error(`[wechat] jscode2session 传输失败（已重试 ${maxRetries} 次）：${reason}`);
          throw new AppError(ErrorCode.INTERNAL_ERROR, '微信登录服务暂不可用');
        } finally {
          clearTimeout(timer);
        }

        if (body.errcode === undefined || body.errcode === 0) {
          if (typeof body.openid !== 'string' || body.openid === '') {
            // 微信返回 200 但缺 openid —— 契约破坏，按上游不可用处理
            throw new AppError(ErrorCode.INTERNAL_ERROR, '微信登录服务响应异常');
          }
          return body.unionid !== undefined
            ? { openid: body.openid, unionid: body.unionid }
            : { openid: body.openid };
        }

        if (body.errcode === -1) {
          // 系统繁忙：可重试；耗尽后按上游不可用（5000），不是凭证问题
          if (attempt < maxRetries) continue;
          console.error(`[wechat] jscode2session 系统繁忙（重试 ${maxRetries} 次后仍失败）`);
          throw new AppError(ErrorCode.INTERNAL_ERROR, '微信登录服务暂不可用');
        }

        // 🔴 日志只带 errcode/errmsg；绝不输出 URL（含 secret）与 code
        console.error(
          `[wechat] jscode2session 被拒 errcode=${body.errcode} errmsg=${body.errmsg ?? '(empty)'}`,
        );
        throw new AppError(ErrorCode.UNAUTHORIZED, '登录凭证无效');
      }
    },
  };
}

/**
 * 按环境选取 exchanger（供生产入口 `main.ts` 调用，仿 `resolveAppDriver` 模式）。
 *
 *   · `WECHAT_APPID` + `WECHAT_SECRET` 成对配置 → 真实 exchanger
 *   · 两者皆缺 + 非生产 → `undefined`（组合根回落 `stubWechat`，开发/测试行为不变）
 *   · 两者皆缺 + `NODE_ENV=production` → **拒绝启动**
 *   · 只配其中一个 → **拒绝启动**（半配置比不配置更危险：看起来接了微信，
 *     实际还在跑桩，正是本次线上事故的形态）
 */
export function resolveWechatExchanger(env: NodeJS.ProcessEnv): WechatCodeExchanger | undefined {
  const appid = env['WECHAT_APPID']?.trim() ?? '';
  const secret = env['WECHAT_SECRET']?.trim() ?? '';
  const nodeEnv = env['NODE_ENV'] ?? 'development';

  if (appid === '' && secret === '') {
    if (nodeEnv === 'production') {
      throw new Error(
        'NODE_ENV=production 但缺少 WECHAT_APPID / WECHAT_SECRET —— 拒绝以开发桩启动' +
          '（桩下每次登录都会生成新用户，"我的"页将永远显示默认资料）。' +
          '请在微信小程序后台获取 AppID/AppSecret 并配置后重启。',
      );
    }
    return undefined;
  }

  if (appid === '' || secret === '') {
    throw new Error(
      'WECHAT_APPID 与 WECHAT_SECRET 必须成对配置（检测到只配了其中一个）——' +
        '半配置会让生产带着开发桩跑，拒绝启动。',
    );
  }

  return createJscode2SessionExchanger({ appid, secret });
}
