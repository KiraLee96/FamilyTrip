/**
 * 雪花 ID 生成器（技术方案：全栈主键为雪花 ID，落库 BIGINT）
 * ============================================================================
 * 为什么不用自增：
 *   · 多端同步需要客户端可预生成 ID（离线创建后同步）→ 自增做不到
 *   · 分库分表时自增冲突
 *   · 自增会泄漏业务量（爬虫按 ID 递增即可估算订单数）
 *
 * 结构（64bit，与业界一致）：
 *   | 1bit 符号=0 | 41bit 毫秒时间戳 | 10bit 机器号 | 12bit 序列 |
 *
 * 🔴 时钟回拨必须处理：回拨会让同一毫秒内重复出 ID。
 *    处置：小幅回拨（≤ 5ms）等待追平；大幅回拨直接抛错，
 *    宁可拒绝服务，也不发出重复主键（重复主键=数据覆盖，不可恢复）。
 */

const EPOCH = 1_700_000_000_000n; // 2023-11-14，早于项目起点
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER_ID = (1n << WORKER_BITS) - 1n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n;

export class ClockBackwardsError extends Error {
  constructor(readonly driftMs: number) {
    super(
      `检测到时钟回拨 ${driftMs}ms。拒绝生成雪花 ID —— ` +
        '回拨会复现已发出的 ID，导致主键冲突与数据覆盖。请先同步 NTP。',
    );
    this.name = 'ClockBackwardsError';
  }
}

export interface SnowflakeOptions {
  /** 机器号 0–1023（部署时按实例注入） */
  workerId: number;
  /** 允许的最大回拨容忍（毫秒）；超出即抛错 */
  maxBackwardMs?: number;
  now?: () => number;
}

export class Snowflake {
  private lastTimestamp = -1n;
  private sequence = 0n;
  private readonly workerId: bigint;
  private readonly maxBackwardMs: number;
  private readonly now: () => number;

  constructor(opts: SnowflakeOptions) {
    if (!Number.isInteger(opts.workerId) || opts.workerId < 0 || BigInt(opts.workerId) > MAX_WORKER_ID) {
      throw new RangeError(`workerId 必须在 0–${MAX_WORKER_ID}，实际 ${opts.workerId}`);
    }
    this.workerId = BigInt(opts.workerId);
    this.maxBackwardMs = opts.maxBackwardMs ?? 5;
    this.now = opts.now ?? Date.now;
  }

  /**
   * 生成下一个 ID。
   *
   * @throws ClockBackwardsError 回拨超过容忍值
   */
  next(): bigint {
    let ts = BigInt(this.now());

    if (ts < this.lastTimestamp) {
      const drift = Number(this.lastTimestamp - ts);
      if (drift > this.maxBackwardMs) throw new ClockBackwardsError(drift);
      // 小幅回拨：占用当前序列位等待追平（不退避到未来，避免累积偏移）
      ts = this.lastTimestamp;
    }

    if (ts === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // 同一毫秒序列用尽 → 自旋到下一毫秒（100 万/秒已是远超需求的上限）
        ts = this.waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = ts;

    return ((ts - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)) | (this.workerId << SEQUENCE_BITS) | this.sequence;
  }

  /** 批量生成（避免调用方循环里反复取时间） */
  nextBatch(count: number): bigint[] {
    const out = new Array<bigint>(count);
    for (let i = 0; i < count; i += 1) out[i] = this.next();
    return out;
  }

  private waitNextMillis(last: bigint): bigint {
    let ts = BigInt(this.now());
    while (ts <= last) ts = BigInt(this.now());
    return ts;
  }
}

/** 从雪花 ID 反解时间戳（排障用） */
export function timestampOf(snowflake: bigint): Date {
  return new Date(Number((snowflake >> (WORKER_BITS + SEQUENCE_BITS)) + EPOCH));
}

/** 从雪花 ID 反解机器号 */
export function workerOf(snowflake: bigint): number {
  return Number((snowflake >> SEQUENCE_BITS) & MAX_WORKER_ID);
}

/** 进程级默认实例 —— 生产应按实例注入 workerId（环境变量 SNOWFLAKE_WORKER_ID） */
let defaultGen: Snowflake | null = null;

export function defaultSnowflake(): Snowflake {
  if (defaultGen === null) {
    const workerId = Number(process.env.SNOWFLAKE_WORKER_ID ?? 1);
    defaultGen = new Snowflake({ workerId });
  }
  return defaultGen;
}

/** 便捷：取一个新 ID */
export function nextId(): bigint {
  return defaultSnowflake().next();
}
