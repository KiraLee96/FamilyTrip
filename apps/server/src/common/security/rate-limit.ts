/**
 * 进程内「最小间隔」限流（D-2026-10-26-01 P1-1）
 * ============================================================================
 * 用途单一：给**低频但重**的写接口（如批量导入账单 200 行）加一道「同一用户
 * 每秒最多一次」的闸，避免弱网重试 / 客户端死循环把库打穿。
 *
 * 🔴 为什么是「最小间隔」而不是令牌桶：
 *    派发单口径就是「单用户 1 次/秒」。最小间隔的语义**逐字**对应它，
 *    且不需要补给线程、不需要后台定时器 —— 判定只看「上次放行时间」。
 *    令牌桶留出突发额度，反而与「低频操作收紧没代价」的意图相反。
 *
 * 🔴 已知边界（必须在交付物里如实披露，不要当作完整限流）：
 *    · **进程内**：pm2 fork 单实例时有效；一旦扩成 cluster / 多机，
 *      每个进程各有一份计数，实际额度 = N × 配置值。
 *    · **重启即清零**：pm2 restart 后第一秒不会拦。
 *    · 真要做跨实例精确限流，需要 Redis / DB 计数，属基建范畴（另单）。
 *
 * ⚠️ 拒绝时**不要**在错误里回显「还有多少额度」—— 那给攻击者试探空间；
 *    只回「稍后重试」+ 建议的重试间隔。
 */

export interface MinIntervalLimiterOptions {
  /** 同一 key 两次放行之间的最小间隔（毫秒） */
  intervalMs: number;
  /** 最多记忆多少个 key（默认 10000）；超出按最久未用淘汰，防无界增长 */
  maxKeys?: number;
  /** 时钟（单测注入） */
  now?: () => number;
}

export type AcquireDecision = { ok: true } | { ok: false; retryAfterMs: number };

export class MinIntervalLimiter {
  private readonly intervalMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  /** key → 上次放行时间（毫秒）。Map 的插入顺序即 LRU 顺序。 */
  private readonly last = new Map<string, number>();

  constructor(options: MinIntervalLimiterOptions) {
    this.intervalMs = options.intervalMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * 尝试放行。
   *
   * 放行 → 记下本次时间；拒绝 → 回 `retryAfterMs`（不改变上次放行时间，
   * 否则连续被拒会把窗口不断后推，变成「越试越久」的惩罚）。
   */
  tryAcquire(key: string): AcquireDecision {
    const at = this.now();
    const prev = this.last.get(key);
    if (prev !== undefined) {
      const elapsed = at - prev;
      if (elapsed < this.intervalMs) {
        return { ok: false, retryAfterMs: this.intervalMs - elapsed };
      }
    }
    // 先删再 set：让该 key 移到 Map 末尾（最近使用）
    this.last.delete(key);
    this.last.set(key, at);
    this.evictIfNeeded();
    return { ok: true };
  }

  /** 当前记忆的 key 数（测试与运维巡检用） */
  get size(): number {
    return this.last.size;
  }

  private evictIfNeeded(): void {
    while (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next();
      if (oldest.done === true) return;
      this.last.delete(oldest.value);
    }
  }
}
