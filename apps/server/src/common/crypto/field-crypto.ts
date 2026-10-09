/**
 * M2 · AES-256-GCM 字段级加解密
 * ---------------------------------------------------------------------------
 * 强制项逐条对应 TP-02C：
 *   C-1 存储格式 15B 头       → cipher-format.ts
 *   C-2 AAD 绑定 recordId     → buildAad()，recordId 含表标识
 *   C-3 解密前长度校验        → assertCiphertextFits() + parseCiphertext()
 *   C-4 IV 仅 randomBytes(12) → 新鲜 IV，禁止复用
 *   C-5 DEK缓存 TTL ≤ 10min   → dek-provider.ts
 *   C-6 密钥退役三步          → dek-provider.ts（只读态/ 归零判定）
 *   C-7 调用数监控 2^32       → dek-provider.ts（90% 预警）
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { buildRecordId, toBuffer, type SnowflakeId } from './to-buffer.js';
import {
  AlgoId,
  ColumnCapacity,
  FormatVer,
  HEADER_LENGTH,
  type EncryptedColumn,
  assertCiphertextFits,
  parseCiphertext,
} from './cipher-format.js';

const AES_256_KEY_BYTES = 32;
const IV_BYTES = 12;
const GCM_TAG_BITS = 128;

/**
 * AAD = format_ver ‖ key_ver ‖ algo_id ‖ recordId
 *
 * 🔴 recordId 必须是 `"<表标识>:<主键>"`，绝不可用裸主键。
 * 裸主键会让两表同号主键行的 AAD 相同 → 密文跨表搬运后认证通过 → 越权读取。
 */
export function buildAad(
  formatVer: number,
  keyVer: number,
  algoId: number,
  recordId: string,
): Buffer {
  return Buffer.concat([Buffer.from([formatVer, keyVer, algoId]), Buffer.from(recordId, 'utf8')]);
}

/** 明文 UTF-8 编码后的字节长度 —— 加密前用它做容量预检 */
export function plaintextByteLength(plaintext: string): number {
  return Buffer.byteLength(plaintext, 'utf8');
}

export interface EncryptFieldInput {
  /** 明文 */
  plaintext: string;
  /** 表标识，如 'booking' */
  table: string;
  /** ��键（雪花 ID） */
  primaryKey: SnowflakeId;
  /** 落库列名，决定容量上限 */
  column: EncryptedColumn;
  /** 当前用户的 DEK 与版本号（来自 KMS，缓存 TTL ≤ 10min） */
  dek: Buffer;
  keyVer: number;
}

export interface DecryptFieldInput {
  /** DB 读回的原始列值 —— 可能是 Uint8Array，必须经 toBuffer() */
  raw: unknown;
  table: string;
  primaryKey: SnowflakeId;
  column: EncryptedColumn;
  /** 按 key_ver 从 KMS 缓存取对应版本的 DEK */
  resolveDek: (keyVer: number) => Buffer;
}

/**
 * 加密。
 *
 * @returns可直接落库的 Buffer，长度 = 15 + len(ciphertext) + 16
 */
export function encryptField(input: EncryptFieldInput): Buffer {
  const { plaintext, table, primaryKey, column, dek, keyVer } = input;

  if (dek.length !== AES_256_KEY_BYTES) {
    throw new TypeError(`DEK 长度必须 ${AES_256_KEY_BYTES}B，实际 ${dek.length}B`);
  }
  if (!Number.isInteger(keyVer) || keyVer < 0 || keyVer > 255) {
    throw new RangeError(`key_ver 必须在 0–255，实际 ${keyVer}`);
  }

  const capacity = ColumnCapacity[column];
  const plainBytes = plaintextByteLength(plaintext);

  // 加密前就容量预检，避免白算一场Cipher 再发现塞不下
  if (plainBytes + HEADER_LENGTH + 16 > capacity) {
    throw new RangeError(
      `明文 ${plainBytes}B 超出列 ${column}(${capacity}B) 容量上限；` +
        `最大明文 ${capacity - HEADER_LENGTH - 16}B。`,
    );
  }

  const formatVer = FormatVer.V1;
  const algoId = AlgoId.Aes256Gcm;

  // C-4：IV 只允许 CSPRNG。同一记录每次重加密都换新 IV（此处天然满足）
  const iv = randomBytes(IV_BYTES);

  const recordId = buildRecordId(table, primaryKey);
  const aad = buildAad(formatVer, keyVer, algoId, recordId);

  const cipher = createCipheriv('aes-256-gcm', dek, iv, { authTagLength: GCM_TAG_BITS / 8 });
  cipher.setAAD(aad, { plaintextLength: plaintextByteLength(plaintext) });

  // ⛔ 只传 Buffer，不传 Uint8Array
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const out = Buffer.concat([Buffer.from([formatVer, keyVer, algoId]), iv, ciphertext, authTag]);

  // 双保险：出库前再校验一次长度
  assertCiphertextFits(out.length, capacity);
  return out;
}

/**
 * 解密。
 *
 * @throws 认证失败时抛错——**这正是跨表搬运被拦下的地方**。
 */
export function decryptField(input: DecryptFieldInput): string {
  const { raw, table, primaryKey, column, resolveDek } = input;

  // 🔴 红线 R1：唯一允许的 DB 二进制读取入口
  const buf = toBuffer(raw, `${table}.${column}`);

  // C-3：解密前长度校验，禁止静默截断
  const { keyVer, iv, ciphertext, authTag } = parseCiphertext(buf);

  const dek = resolveDek(keyVer);
  if (dek.length !== AES_256_KEY_BYTES) {
    throw new TypeError(
      `key_ver=${keyVer} 的 DEK 长度必须 ${AES_256_KEY_BYTES}B，实际 ${dek.length}B`,
    );
  }

  const recordId = buildRecordId(table, primaryKey);
  const aad = buildAad(FormatVer.V1, keyVer, AlgoId.Aes256Gcm, recordId);

  const decipher = createDecipheriv('aes-256-gcm', dek, iv, { authTagLength: GCM_TAG_BITS / 8 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);

  // ✅ 派发单指定的唯一正确写法：先 toBuffer，再传给 crypto 层
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/**
 * 便捷解密：输入可能是 null（DB 可空加密列）。
 */
export function decryptFieldOrNull(
  input: Omit<DecryptFieldInput, 'raw'> & { raw: unknown },
): string | null {
  if (input.raw === null || input.raw === undefined) return null;
  return decryptField(input);
}

/**
 * 常量时间比较 —— 用于校验密文是否与预期一致，避免计时侧信道。
 */
export function cipherEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
