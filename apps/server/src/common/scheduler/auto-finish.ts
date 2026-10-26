/**
 * D-2026-10-26-02 P0-1 · 过期行程自动完结（进程内定时器）
 * ============================================================================
 * 职责：把「行程过了 end_date 还挂着 PLANNED/ONGOING」这件事，从只有用户手点
 *      `POST /trips/:id/finish`，变成**系统自己会做**。
 *
 * 🔴 为什么是进程内 `setInterval` 而不是 cron / 队列：
 *    当前部署是单个 pm2 实例，没有独立调度基础设施；引入 cron 依赖或外部队列
 *    属于「为一件 5 分钟一次、失败可重入的事」新增运维面。业务侧已用 CAS 兜住
 *    并发（多实例同时跑也只有一个能改成功，另一个视为已完成），故单实例定时器
 *    是当下正确的量级。多实例前需补 DB 行锁（见 trip.service 注释）。
 *
 * 🔴 三层保险（缺一不可）：
 *    ① 本定时器 —— 唯一真相来源（周期性把所有过期行程归档）；
 *    ② 读路径惰性流转 —— 进程刚重启 / 任务挂掉时的兜底（trip.service.autoFinishOnRead）；
 *    ③ `AUTO_FINISH_ENABLED=false` —— 一键回滚，前端 `FinishTripBar` 已就绪，无需改客户端。
 */

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
const DEFAULT_BATCH_LIMIT = 200;
const MIN_INTERVAL_MS = 1_000; // 防止把环境变量写成 0/负数导致空转打满 CPU

export interface AutoFinishConfig {
  /** 总开关（默认开；关闭后定时器不启动，读路径惰性流转也一并关掉） */
  enabled: boolean;
  /** 扫描间隔（毫秒） */
  intervalMs: number;
  /** 单轮扫描上限 */
  batchLimit: number;
  /** 读路径惰性流转（方案 B） */
  lazyOnRead: boolean;
}

export const AUTO_FINISH_DEFAULTS: AutoFinishConfig = {
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  batchLimit: DEFAULT_BATCH_LIMIT,
  lazyOnRead: true,
};

/**
 * 解析环境变量。
 *
 * 非法值**不抛错**：调度配置写错不该让服务起不来（与「生产缺 JWT_SECRET 拒绝启动」
 * 那类安全红线不同，这里最坏后果是自动完结退化成默认频率）。
 */
export function readAutoFinishConfig(env: NodeJS.ProcessEnv = process.env): AutoFinishConfig {
  return {
    enabled: readBool(env['AUTO_FINISH_ENABLED'], AUTO_FINISH_DEFAULTS.enabled),
    intervalMs: readInt(
      env['AUTO_FINISH_INTERVAL_MS'],
      AUTO_FINISH_DEFAULTS.intervalMs,
      MIN_INTERVAL_MS,
    ),
    batchLimit: readInt(env['AUTO_FINISH_BATCH_LIMIT'], AUTO_FINISH_DEFAULTS.batchLimit, 1),
    lazyOnRead: readBool(env['AUTO_FINISH_LAZY_ON_READ'], AUTO_FINISH_DEFAULTS.lazyOnRead),
  };
}

/** 单轮扫描结果（只关心「归档了几个 / 失败几个」，细节由 service 打日志） */
export interface AutoFinishSweepResult {
  finished: number;
  failed: number;
}

export interface AutoFinishScheduler {
  stop(): void;
}

export interface StartAutoFinishOptions {
  config: AutoFinishConfig;
  sweep: () => Promise<AutoFinishSweepResult>;
  /** 覆盖扫描间隔（仅测试用；生产走 config.intervalMs） */
  intervalMs?: number;
  /** 启动时立即跑一轮（默认 true：进程重启后立刻补齐积压） */
  runOnStart?: boolean;
  log?: (line: string) => void;
}

/**
 * 启动周期任务。`config.enabled=false` 时返回 `null`（调用方据此跳过）。
 *
 * 四条硬约束：
 *   1. **防重入**：上一轮还没跑完就跳过本轮，不在内存里堆积未完成的 sweep；
 *   2. **不阻塞退出**：`unref()`，不让定时器拽住事件循环；
 *   3. **单轮失败不终止**：异常被吞掉并计入连续失败次数，从第 3 次起升级 error；
 *   4. **推进系统时间即可测**：全局 `setInterval` 被 vitest fake timers 拦截。
 */
export function startAutoFinishScheduler(o: StartAutoFinishOptions): AutoFinishScheduler | null {
  if (!o.config.enabled) return null;

  const intervalMs = Math.max(MIN_INTERVAL_MS, o.intervalMs ?? o.config.intervalMs);
  const log = o.log ?? ((line: string): void => console.log(line));
  let running = false;
  let stopped = false;
  let consecutiveFailures = 0;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await o.sweep();
      consecutiveFailures = 0;
      if (r.finished > 0 || r.failed > 0) {
        log(`[family-trip] 自动完结：本轮归档 ${r.finished} 个，失败 ${r.failed} 个`);
      }
    } catch (e) {
      consecutiveFailures += 1;
      const msg = e instanceof Error ? e.message : String(e);
      const line = `[family-trip] 自动完结任务失败（连续第 ${consecutiveFailures} 次）：${msg}`;
      // ⚠️ 进程内没有独立告警通道（notify 域面向家庭成员，不适合运维告警）；
      //    连续 3 次失败升级为 error 级日志，供部署侧日志告警规则捞取。
      if (consecutiveFailures >= 3) console.error(line);
      else console.warn(line);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Node 的 Timeout 有 unref；浏览器/类型收窄环境下没有，故可选调用
  (timer as unknown as { unref?: () => void }).unref?.();

  if (o.runOnStart !== false) void tick();

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function readInt(raw: string | undefined, fallback: number, min: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) return fallback;
  return n;
}
