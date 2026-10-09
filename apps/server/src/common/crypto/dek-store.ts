/**
 * M2 · DEK 供应与密钥生命周期（TP-02C C-5 / C-6 / C-7）
 * ---------------------------------------------------------------------------
 * KMS CMK 保护 per-user DEK。本文件只定义**接口与不变量**，
 * 具体 KMS 客户端（腾讯云 KMS SDK）在凭证到位后注入。
 *
 * 🔴 红线 R9：Node.js 无法真正擦除密钥。
 * V8 GC 会搬移对象、`Buffer.fill(0)` 只尽力而为，JIT 可能把密钥留在寄存器/栈上。
 * 因此**不得依赖运行时擦除**作为安全边界 —— 真正的边界是 KMS 侧的访问控制
 * 与审计。本模块的 wipe() 只是尽力而为的补充，不是保证。
 */

import type { Buffer } from 'node:buffer';

/** DEK 缓存 TTL ≤ 10 分钟（TP-02C C-5） */
export const DEK_CACHE_TTL_MS = 10 * 60 * 1000;

/** 同密钥累计加密调用数上限 2^32（GCM 的 IV 随机性在 2^32 后需重新评估） */
export const MAX_ENCRYPT_CALLS_PER_KEY = 2 ** 32;

/** 达90% 即预警并触发轮换（TP-02C C-7） */
export const ENCRYPT_CALL_WARN_RATIO = 0.9;

export const enum KeyState {
  /** 活跃：可用于加密与解密 */
  Active = 'ACTIVE',
  /** 只读：仅可解密，停止用于加密 —— 退役第 ①步 */
  ReadOnly = 'READ_ONLY',
  /** 已销毁：不可用 —— 退役第 ③ 步 */
  Destroyed = 'DESTROYED',
}

export interface DekMaterial {
  keyVer: number;
  /** 32B AES-256 密钥 */
  key: Buffer;
  state: KeyState;
}

/** KMS 适配接口 —— 生产实现注入腾讯云 KMS SDK */
export interface KmsClient {
  /** 生成新 DEK（轮换时调用），返回 keyVer 由 KMS 分配 */
  generateDek(userId: string): Promise<DekMaterial>;
  /** 取指定版本的 DEK 明文（KMS 侧解密后返回） */
  getDek(userId: string, keyVer: number): Promise<DekMaterial>;
  /** 拉取全部版本的元信息（不含明文），用于归零判定 */
  listDekVersions(userId: string): Promise<Omit<DekMaterial, 'key'>[]>;
  /** 销毁指定版本 */
  destroyDek(userId: string, keyVer: number): Promise<void>;
}

interface CacheEntry {
  material: DekMaterial;
  fetchedAt: number;
}

export interface DekUsageSnapshot {
  keyVer: number;
  encryptCalls: number;
  warnRatio: number;
  exhausted: boolean;
}

/**
 * per-user DEK 缓存。
 *
 * 一次实例对应一个 userId，避免把多个用户的密钥混在一个 map 里。
 */
export class DekStore {
  private readonly cache = new Map<number, CacheEntry>();
  private readonly encryptCalls = new Map<number, number>();
  private readonly now: () => number;

  constructor(
    private readonly userId: string,
    private readonly kms: KmsClient,
    now: () => number = Date.now,
  ) {
    this.now = now;
  }

  /** 取可用于加密的活跃 DEK；不存在则向 KMS 申请新版本 */
  async activeDek(): Promise<DekMaterial> {
    const cached = this.cached();
    if (cached && cached.state === KeyState.Active) return cached;

    const material = await this.kms.generateDek(this.userId);
    this.store(material);
    return material;
  }

  /** 按 key_ver 取 DEK（解密路径） */
  async dekByVersion(keyVer: number): Promise<DekMaterial> {
    const cached = this.cached(keyVer);
    if (cached) return cached;

    const material = await this.kms.getDek(this.userId, keyVer);
    this.store(material);
    return material;
  }

  /**
   * 轮换事件主动刷新 —— 不等 TTL 过期（TP-02C C-5）。
   */
  invalidate(keyVer?: number): void {
    if (keyVer === undefined) this.cache.clear();
    else this.cache.delete(keyVer);
  }

  /**
   * 尽力而为的擦除。⛔ **不构成安全边界**（红线 R9）：
   * V8 可能已把密钥字节复制到别处。
   */
  wipe(): void {
    for (const entry of this.cache.values()) entry.material.key.fill(0);
    this.cache.clear();
  }

  // ── 加密调用计数（C-7）────────────────────────────────────────
  recordEncryptCall(keyVer: number): void {
    const n = (this.encryptCalls.get(keyVer) ?? 0) + 1;
    this.encryptCalls.set(keyVer, n);
    if (n >= ENCRYPT_CALL_WARN_RATIO * MAX_ENCRYPT_CALLS_PER_KEY) {
      // 上层接监控告警；此处只标记，不直接抛 —— 抛会让写入全挂
      this.flagRotate(keyVer);
    }
  }

  usage(): DekUsageSnapshot[] {
    return [...this.encryptCalls.entries()].map(([keyVer, encryptCalls]) => ({
      keyVer,
      encryptCalls,
      warnRatio: encryptCalls / MAX_ENCRYPT_CALLS_PER_KEY,
      exhausted: encryptCalls >= MAX_ENCRYPT_CALLS_PER_KEY,
    }));
  }

  /**
   * 退役三步（TP-02C C-6）：
   *① 转只读 → ② 观察该 key_ver 密文数量归零 → ③ 销毁。
   *
   * ⛔ 未归零绝不销毁 —— 本函数是那道闸。
   */
  async retire(
    keyVer: number,
    remainingCiphertextCount: number,
  ): Promise<'step1_readonly' | 'step3_destroyed' | 'blocked_not_zero'> {
    if (remainingCiphertextCount > 0) {
      return 'blocked_not_zero';
    }
    const material = await this.dekByVersion(keyVer);
    if (material.state !== KeyState.Destroyed) {
      await this.kms.destroyDek(this.userId, keyVer);
      this.cache.delete(keyVer);
      return 'step3_destroyed';
    }
    return 'step3_destroyed';
  }

  private flagRotate(keyVer: number): void {
    // 降级为只读：停止用该版本加密，但保留解密能力
    const entry = this.cache.get(keyVer);
    if (entry) entry.material.state = KeyState.ReadOnly;
  }

  private cached(keyVer?: number): DekMaterial | undefined {
    if (keyVer === undefined) {
      // 无参时返回活跃版本中最新一个
      let newest: CacheEntry | undefined;
      for (const entry of this.cache.values()) {
        if (!newest || entry.material.keyVer > newest.material.keyVer) newest = entry;
      }
      if (!newest) return undefined;
      return this.fresh(newest)?.material;
    }
    const entry = this.cache.get(keyVer);
    if (!entry) return undefined;
    return this.fresh(entry)?.material;
  }

  private fresh(entry: CacheEntry): CacheEntry | undefined {
    if (this.now() - entry.fetchedAt > DEK_CACHE_TTL_MS) {
      this.cache.delete(entry.material.keyVer);
      return undefined;
    }
    return entry;
  }

  private store(material: DekMaterial): void {
    this.cache.set(material.keyVer, { material, fetchedAt: this.now() });
  }
}
