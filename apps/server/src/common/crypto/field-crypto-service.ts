/**
 * C-1~C-7 · 加密字段应用层（编码落地）
 * ============================================================================
 * `common/crypto/` 里的原语（field-crypto / cipher-format / dek-store /
 * blind-index / to-buffer）已经就绪。本文件把它们**装配成可直接用于
 * 仓储层的服务**，补齐 C 组「编码落地」的最后一段：
 *
 *   C-1 存储格式 15B 头      → 复用 cipher-format
 *   C-2 AAD 绑定 recordId    → 复用 buildAad（含表标识）
 *   C-3 解密前长度校验       → 复用 parseCiphertext
 *   C-4 IV 每次随机          → 复用 randomBytes(12)
 *   C-5 DEK 缓存 TTL ≤10min  → 复用 DekStore
 *   C-6 密钥退役三步         → 本文件编排退役流程
 *   C-7 调用数监控 2^32      → 复用 recordEncryptCall + 本文件聚合
 *
 * 🔴 本文件的核心价值：把「加密列 + 盲索引 + 审计」三件事
 *    **绑成一个不可拆的写入单元**。
 *    盲索引与密文必须同事务（红线 R3），若让调用方自己记得，
 *    迟早会有人只写密文忘了盲索引 → 检索不到 → 表现为「数据丢失」。
 */

import { Buffer } from 'node:buffer';
import { encryptField, decryptFieldOrNull } from '../crypto/field-crypto.js';
import {
  ColumnCapacity,
  type EncryptedColumn,
} from '../crypto/cipher-format.js';
import { computeBlindIndex } from '../crypto/blind-index.js';
import { DekStore, KeyState, type KmsClient, type DekMaterial } from '../crypto/dek-store.js';
import type { SnowflakeId } from '../crypto/to-buffer.js';
import { ErrorCode, AppError, decryptFormatError } from '../errors/error-code.js';

/** 加解密失败统一错误 */
export class CryptoFailureError extends AppError {
  constructor(detail: string) {
    super(ErrorCode.CRYPTO_ERROR, `加密失败：${detail}`);
    this.name = 'CryptoFailureError';
  }
}

/**
 * 加密字段的**声明式定义** —— 一处声明，读写两侧共用。
 *
 * ⛔ 不允许在读写两端各写一遍「哪个列是加密的」：
 *    两处不一致会导致「写入加密、读出当明文」这类静默错误。
 */
export interface EncryptedFieldSpec {
  /** 落库列名（决定容量） */
  column: EncryptedColumn;
  /** 数据库表标识（进 AAD，红线 R4） */
  table: string;
  /** 是否需要配套盲索引（等值检索用） */
  blindIndex?: {
    /** 盲索引列名 */
    column: string;
    /** 参与计算的低基数字段（必须全部参与，规则 2） */
    lowCardinality: readonly string[];
  };
}

/**
 * booking 域的加密字段清单（P2 依赖）。
 *
 * 与 prisma schema 的 booking 表逐列对应：
 *   order_no_enc / order_link_enc / contact_enc + order_no_blind
 *
 * 🔴 盲索引的低基数字段必须**同时**包含 `familyId` 与 `tripId`（规则 2）：
 *    只带 familyId 会让「同一家庭下两个不同出行的同名订单号」撞成同一摘要，
 *    等值检索会跨出行误命中；而少带任一字段都属于「低基数字段未全部参与」。
 */
export const BOOKING_ENCRYPTED_FIELDS: Readonly<Record<string, EncryptedFieldSpec>> = {
  orderNo: {
    column: 'order_no_enc',
    table: 'booking',
    blindIndex: { column: 'order_no_blind', lowCardinality: ['familyId', 'tripId'] },
  },
  orderLink: {
    column: 'order_link_enc',
    table: 'booking',
  },
  contact: {
    column: 'contact_enc',
    table: 'booking',
  },
} as const;

/**
 * 加密服务 —— per-user DEK + 列容量 + 盲索引的同事务绑定。
 */
export class FieldCryptoService {
  private readonly store: DekStore;

  constructor(
    private readonly userId: string,
    kms: KmsClient,
    now: () => number = Date.now,
  ) {
    this.store = new DekStore(userId, kms, now);
  }

  /**
   * 取当前活跃 DEK（用于加密）并记录一次调用（C-7）。
   */
  private async activeDekForEncrypt(): Promise<DekMaterial> {
    const material = await this.store.activeDek();
    this.store.recordEncryptCall(material.keyVer);
    return material;
  }

  /**
   * 加密一个字段。
   *
   * @throws CryptoFailureError 容量超限 / DEK 异常
   */
  async encryptValue(args: {
    spec: EncryptedFieldSpec;
    primaryKey: SnowflakeId;
    plaintext: string | null | undefined;
  }): Promise<Buffer | null> {
    if (args.plaintext === null || args.plaintext === undefined || args.plaintext === '') {
      // 空值不加密 —— 加密空串会让「未填写」与「填写了空」无法区分
      return null;
    }

    const dek = await this.activeDekForEncrypt();

    try {
      return encryptField({
        plaintext: args.plaintext,
        table: args.spec.table,
        primaryKey: args.primaryKey,
        column: args.spec.column,
        dek: dek.key,
        keyVer: dek.keyVer,
      });
    } catch (e) {
      throw new CryptoFailureError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * 解密一个字段。
   *
   * 🔴 走 decryptFieldOrNull，内部强制 toBuffer()（红线 R1）。
   */
  decryptValue(args: {
    spec: EncryptedFieldSpec;
    primaryKey: SnowflakeId;
    raw: unknown;
  }): Promise<string | null> {
    try {
      // 解密本身是同步的（DEK 必须先 prefetch 到缓存）；此处包成 Promise 以保持
      // 加解密两侧的调用形态一致，且不写 `async`（体内无 await）。
      return Promise.resolve(
        decryptFieldOrNull({
          raw: args.raw,
          table: args.spec.table,
          primaryKey: args.primaryKey,
          column: args.spec.column,
          resolveDek: (keyVer) => this.resolveDekSync(keyVer),
        }),
      );
    } catch (e) {
      throw decryptFormatError(
        `密文解密失败（${args.spec.table}.${args.spec.column}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /**
   * 🔴 说明：decryptField 的签名要求同步 resolveDek。
   * 因此解密前必须先把所需版本的 DEK 预取进缓存（见 prefetchDek）。
   */
  private resolveDekSync(keyVer: number): Buffer {
    const cached = this.store.peek(keyVer);
    if (cached === undefined) {
      throw new CryptoFailureError(
        `key_ver=${keyVer} 的 DEK 未预取。解密前必须调用 prefetchDek()，` +
          '以避免在同步解密路径里做异步 KMS 调用。',
      );
    }
    return cached;
  }

  /** 预取指定版本 DEK（解密前调用；可批量） */
  async prefetchDek(keyVer: number): Promise<void> {
    await this.store.dekByVersion(keyVer);
  }

  /** 预取一批密文各自的 key_ver（从密文头部读第 1 字节） */
  async prefetchForCiphertexts(raws: readonly unknown[]): Promise<void> {
    const versions = new Set<number>();
    for (const raw of raws) {
      if (raw === null || raw === undefined) continue;
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      if (buf.length >= 2) versions.add(buf.readUInt8(1));
    }
    for (const v of versions) await this.prefetchDek(v);
  }

  /**
   * 计算盲索引（与密文同事务写入，红线 R3）。
   *
   * 🔴 「盲索引」与「摘要指纹」是两回事，别混：
   *     · 摘要指纹 = sha256(低基数字段 + 主键)  → 每条记录唯一，**不可用于等值检索**
   *       （要查它得先知道主键，而知道主键就不需要查了）。
   *     · 盲索引   = sha256(低基数字段 + **被索引的值**) → 同一值得到同一摘要，
   *       才能用 `WHERE order_no_blind = ?` 反查。
   *
   * 本方法是**盲索引**语义，因此入参必须有 `value`（被索引的明文字段），
   * 且低基数字段作为盐参与 —— 这就是规则 2「低基数字段必须全部参与」的落点：
   * 少了盐，同一订单号在不同家庭会算出相同摘要 → 跨家庭可枚举碰撞。
   *
   * ⛔ 不要把 primaryKey 掺进来：那会让它退化成不可检索的指纹。
   *    primaryKey 的信息已通过 AAD 参与**密文**绑定（见 encryptField / R4），
   *    无需也不应在盲索引里重复。
   */
  computeBlind(args: {
    spec: EncryptedFieldSpec;
    /** 被索引字段的明文值（null/空 → 无索引） */
    value: string | null | undefined;
    values: Record<string, string | number | bigint | null>;
  }): Buffer | null {
    const bi = args.spec.blindIndex;
    if (bi === undefined) return null;
    if (args.value === null || args.value === undefined || args.value === '') return null;

    const low: Record<string, string | number | null | undefined> = {};
    for (const key of bi.lowCardinality) {
      const v = args.values[key];
      low[key] = v === null || v === undefined ? '' : String(v);
    }
    return computeBlindIndex({ lowCardinality: low, indexedValue: args.value });
  }

  /**
   * 一次性构造「密文 + 盲索引」写入载荷。
   *
   * ⛔ 必须把返回对象**整个**塞进同一个事务的 create/update，
   *    拆开写就破坏了红线 R3。
   */
  async buildWritePayload(args: {
    specs: Readonly<Record<string, EncryptedFieldSpec>>;
    primaryKey: SnowflakeId;
    plaintexts: Record<string, string | null | undefined>;
    /** 盲索引低基数字段来源 */
    lowCardinalityValues?: Record<string, string | number | bigint | null>;
  }): Promise<{ encrypted: Record<string, Buffer | null>; blindIndexes: Record<string, Buffer | null> }> {
    const encrypted: Record<string, Buffer | null> = {};
    const blindIndexes: Record<string, Buffer | null> = {};

    for (const [field, spec] of Object.entries(args.specs)) {
      encrypted[spec.column] = await this.encryptValue({
        spec,
        primaryKey: args.primaryKey,
        plaintext: args.plaintexts[field],
      });

      if (spec.blindIndex !== undefined) {
        // 盲索引只在有明文时计算；无明文则置 null（可检索性随明文消失）
        blindIndexes[spec.blindIndex.column] =
          args.plaintexts[field] === null || args.plaintexts[field] === undefined || args.plaintexts[field] === ''
            ? null
            : this.computeBlind({
                spec,
                value: args.plaintexts[field],
                values: args.lowCardinalityValues ?? {},
              });
      }
    }

    return { encrypted, blindIndexes };
  }

  // ── C-6 密钥退役编排 ────────────────────────────────────────

  /**
   * 退役流程（三步，一步都不能跳）：
   *   ① 转只读（停止用于加密，保留解密）
   *   ② 观察该 key_ver 密文数量归零
   *   ③ 销毁
   *
   * @param remainingCiphertextCount 由数据层统计的「该 key_ver 的密文行数」
   * @throws 未归零时返回 blocked，**不销毁**
   */
  async retireKey(
    keyVer: number,
    remainingCiphertextCount: number,
  ): Promise<'step1_readonly' | 'step3_destroyed' | 'blocked_not_zero'> {
    // ① 转只读
    const material = await this.store.dekByVersion(keyVer);
    if (material.state === KeyState.Active) {
      // invalidation 让下一次 activeDek() 申请新版本
      this.store.invalidate(keyVer);
    }
    return this.store.retire(keyVer, remainingCiphertextCount);
  }

  /** C-7：加密调用数监控快照 */
  usage(): Array<{ keyVer: number; encryptCalls: number; warnRatio: number; exhausted: boolean }> {
    return this.store.usage();
  }

  /** 尽力而为的擦除（⛔ 非安全边界，见dek-store 红线 R9） */
  wipe(): void {
    this.store.wipe();
  }

  /**
   * 明文上限查询（供入参校验：写入前就拒，避免算完密文才发现塞不下）
   */
  maxPlaintextBytes(column: EncryptedColumn): number {
    return ColumnCapacity[column] - 15 - 16;
  }
}
