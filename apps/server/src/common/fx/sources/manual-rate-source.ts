/**
 * 人工录入汇率源 —— 上线初期生产路径（银行牌价周录）
 * ============================================================================
 * 定位：一个**诚实**的授权源。
 *
 * 🔴 它不提供任何数据，也绝不伪装有数据。存在的意义是让 M3 启动闸门
 *    (`assertFxSourceConfigured`) 有一个合规的放行对象 —— 因为「人工录入」
 *    本身就是项目认可的合规数据路径（R7 注释原话：录入只能走 MANUAL，
 *    即人工授权源录入）。
 *
 * 取数链路回顾（`FxService.getRate`）：
 *     缓存 → **库内（人工录入落点）** → 回源（本类）
 * 也就是说：库里已有录入数据时，请求根本到不了这里；走到这里 =
 * 该 (币种对, 日期) 还没录入 —— 抛 5006 + 录入指引，前端据此显示
 * 「暂无汇率」，与「网络错误」区分开。
 *
 * 数据来源（人工）：中国银行等官网每日外汇牌价中的**现汇卖出价**
 * （SPOT_SELL，正确口径；免费公开 API 只有中间价，差 1-3% 不能用于记账）。
 * 录入走 `POST /fx/rates`（带 source=MANUAL_RATE_ENTRY + 操作人，审计链完整）。
 *
 * 何时被替换：用户量上来、每周抄牌价成为负担时，写签约 API 适配器
 * （实现同一个 FxRateSource），main.ts 装配处换一行 —— 域代码零改动。
 */

import { AppError, ErrorCode } from '../../errors/error-code.js';
import type { FxRateSource } from '../source-guard.js';

/** 源标识：须与 FX_AUTHORIZED_SOURCES 白名单及 POST /fx/rates 的 source 字段一致 */
export const MANUAL_RATE_SOURCE_NAME = 'MANUAL_RATE_ENTRY';

export class ManualRateSource implements FxRateSource {
  readonly name: string;

  constructor(name: string = MANUAL_RATE_SOURCE_NAME) {
    this.name = name;
  }

  /**
   * 恒抛 5006（FX_SOURCE_MISCONFIGURED）—— 语义 = 「汇率尚不可用」。
   *
   * 用 AppError 而非裸 Error：让错误码穿透信封到达前端，`useFxRate` 的
   * `missing` 分支（按 5006 判断）才能把 UI 切成「暂无汇率」而不是「出错了」。
   */
  fetchRate(args: { base: string; quote: string; tier: string; date: string }): Promise<never> {
    throw new AppError(
      ErrorCode.FX_SOURCE_MISCONFIGURED,
      `汇率 ${args.base}→${args.quote}（${args.date}）尚未录入。` +
        `请从银行牌价页抄录【现汇卖出价】，POST /fx/rates 录入` +
        `（source=${this.name}）。录入后即时生效，无需重启。`,
    );
  }
}
