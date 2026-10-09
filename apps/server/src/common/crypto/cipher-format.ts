/**
 * 密文存储格式（技术方案 v1.3 §4.7 / TP-02C C-1，不得改动）
 *
 *   [1B format_ver][1B key_ver][1B algo_id][12B IV][ciphertext][16B authTag]
 *   └────── 加密头 = 15B ──────┘
 *   1 + 1 + 1 + 12 = 15B
 */

import { Buffer } from 'node:buffer';

/** 🔴 红线 R8：密文头长唯一 15B。任何改动都会让全库长度校验失效。 */
export const HEADER_LENGTH = 1 + 1 + 1 + 12; // = 15

/** GCM 认证标签长度 */
export const AUTH_TAG_LENGTH = 16;

/** 最短合法密文长度 = 头15 + 密文0 + tag16，用于解密前校验（TP-02C C-3） */
export const MIN_CIPHERTEXT_LENGTH = HEADER_LENGTH + AUTH_TAG_LENGTH; // = 31

/** 明文上限 = 列容量 − 15 − 16 */
export function maxPlaintextFor(columnCapacity: number): number {
  return columnCapacity - HEADER_LENGTH - AUTH_TAG_LENGTH;
}

/** 反推：给定密文字段长度，返回明文长度 */
export function plainLengthOf(fieldLength: number): number {
  return fieldLength - HEADER_LENGTH - AUTH_TAG_LENGTH;
}

/** 长度校验：field_length >= 15 + len(ct) + 16 */
export function assertCiphertextFits(fieldLength: number, columnCapacity: number): void {
  if (fieldLength > columnCapacity) {
    // ⛔ 禁止静默截断（A22）—— 直接抛错，让调用方看到容量配置错误
    throw new RangeError(
      `密文长度 ${fieldLength} 超出列容量 ${columnCapacity}；` +
        `最大明文 ${maxPlaintextFor(columnCapacity)}B。禁止静默截断。`,
    );
  }
}

/** 加密算法标识 */
export const enum AlgoId {
  Aes256Gcm = 0x01,
}

/** 存储格式版本 */
export const enum FormatVer {
  /** 当前格式 */
  V1 = 0x01,
}

/** 落库列容量（技术方案 §2.2.4 / A22） */
export const ColumnCapacity = {
  order_link_enc: 2048,
  order_no_enc: 1024,
  contact_enc: 1024,
} as const;

export type EncryptedColumn = keyof typeof ColumnCapacity;

/** 解析出的密文头 */
export interface ParsedHeader {
  formatVer: number;
  keyVer: number;
  algoId: number;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

/** 从整段密文中切出头部各字段 */
export function parseCiphertext(raw: Buffer): ParsedHeader {
  if (raw.length < MIN_CIPHERTEXT_LENGTH) {
    throw new RangeError(
      `密文长度 ${raw.length} < 最小合法长度 ${MIN_CIPHERTEXT_LENGTH}（头 ${HEADER_LENGTH}B + tag ${AUTH_TAG_LENGTH}B）。` +
        '禁止静默截断，立即抛错。',
    );
  }

  const formatVer = raw.readUInt8(0);
  if (formatVer !== FormatVer.V1.valueOf()) {
    throw new Error(`不支持的 format_ver=${formatVer}（当前仅支持 0x01）`);
  }

  const algoId = raw.readUInt8(2);
  if (algoId !== AlgoId.Aes256Gcm.valueOf()) {
    throw new Error(`不支持的 algo_id=${algoId}（当前仅支持 0x01 = AES-256-GCM）`);
  }

  return {
    formatVer,
    keyVer: raw.readUInt8(1),
    algoId,
    iv: raw.subarray(3, 3 + 12),
    // ⛔ 这里必须是 subarray/copy，不可让 ciphertext 与 raw 共享内存后再被改写
    ciphertext: Buffer.from(raw.subarray(HEADER_LENGTH, raw.length - AUTH_TAG_LENGTH)),
    authTag: Buffer.from(raw.subarray(raw.length - AUTH_TAG_LENGTH)),
  };
}
