/**
 * M2 验收口径 1/2/3 —— 派发单 §六
 *   1M2 GCM 往返一致
 *   2  M2 AAD 跨表搬运拒绝
 *   3  M2 无静默失败（代码中不存在直接传 Uint8Array 给 crypto 的写法）
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { toBuffer, toBufferOrNull, buildRecordId } from './to-buffer.js';
import {
  buildAad,
  decryptField,
  decryptFieldOrNull,
  encryptField,
  plaintextByteLength,
} from './field-crypto.js';
import {
  AlgoId,
  ColumnCapacity,
  FormatVer,
  HEADER_LENGTH,
  MIN_CIPHERTEXT_LENGTH,
  assertCiphertextFits,
  maxPlaintextFor,
  parseCiphertext,
  plainLengthOf,
} from './cipher-format.js';

const DEK = randomBytes(32);
const resolveDek = (): Buffer => DEK;

describe('toBuffer 适配层', () => {
  it('接受 Buffer 并复制，避免调用方改写共享视图', () => {
    const src = Buffer.from([1, 2, 3]);
    const out = toBuffer(src);
    expect(out).toEqual(src);
    out[0] = 9;
    expect(src[0]).toBe(1);
  });

  it('接受 Prisma 返回的裸 Uint8Array（关键路径）', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);
    expect(Buffer.isBuffer(bytes)).toBe(false); // 前提：它确实不是 Buffer
    const out = toBuffer(bytes);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect([...out]).toEqual([10, 20, 30, 40]);
  });

  it('尊重 Uint8Array 的 byteOffset 视图，不越界读', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const view = backing.subarray(2, 5); // [3,4,5]
    expect([...toBuffer(view)]).toEqual([3, 4, 5]);
  });

  it('接受 ArrayBuffer / DataView / number[] / base64', () => {
    expect([...toBuffer(new Uint8Array([1, 2]).buffer)]).toEqual([1, 2]);
    expect([...toBuffer(new DataView(new Uint8Array([7, 8]).buffer))]).toEqual([7, 8]);
    expect([...toBuffer([1, 2, 255])]).toEqual([1, 2, 255]);
    expect([...toBuffer(Buffer.from('hi').toString('base64'))]).toEqual([...Buffer.from('hi')]);
  });

  it('空值与非二进制一律抛错，绝不返回空 Buffer', () => {
    // 静默返回空 Buffer 等于把「解密失败」伪装成「明文为空」—— 必须抛
    expect(() => toBuffer(null)).toThrow(TypeError);
    expect(() => toBuffer(undefined)).toThrow(TypeError);
    expect(() => toBuffer(42)).toThrow(TypeError);
    expect(() => toBuffer({})).toThrow(TypeError);
    expect(() => toBuffer('!!!not-base64!!!')).toThrow(/base64/);
  });

  it('toBufferOrNull 对 null 返回 null（DB 可空加密列）', () => {
    expect(toBufferOrNull(null)).toBeNull();
    expect(toBufferOrNull(undefined)).toBeNull();
    expect([...toBufferOrNull(new Uint8Array([1]))!]).toEqual([1]);
  });

  it('recordId 必须含表标识', () => {
    expect(buildRecordId('booking', 123)).toBe('booking:123');
    expect(buildRecordId('booking', 123)).not.toBe('contact_enc:123');
    expect(() => buildRecordId('', 1)).toThrow(/表标识/);
    expect(() => buildRecordId('booking', '')).toThrow();
  });
});

describe('密文头 15B 布局', () => {
  it('头长唯一 15B', () => {
    expect(HEADER_LENGTH).toBe(15);
    expect(MIN_CIPHERTEXT_LENGTH).toBe(31); // 15 + 16
  });

  it('容量公式 = 列容量 − 15 − 16', () => {
    expect(maxPlaintextFor(ColumnCapacity.order_link_enc)).toBe(2048 - 15 - 16);
    expect(maxPlaintextFor(ColumnCapacity.order_no_enc)).toBe(1024 - 15 - 16);
    // 派发单口径：order_link_enc ≤2000B、order_no_enc ≤950B（留余量）
    expect(maxPlaintextFor(2048)).toBeGreaterThanOrEqual(2000);
    expect(maxPlaintextFor(1024)).toBeGreaterThanOrEqual(950);
  });

  it('反解明文长度 = 字段长度 − 15 − 16', () => {
    expect(plainLengthOf(31)).toBe(0);
    expect(plainLengthOf(31 + 10)).toBe(10);
  });

  it('超容量抛错，禁止静默截断', () => {
    expect(() => assertCiphertextFits(2049, 2048)).toThrow(/禁止静默截断/);
  });

  it('长度不足立即抛错（解密前校验）', () => {
    expect(() => parseCiphertext(Buffer.alloc(30))).toThrow(/最小合法长度/);
  });

  it('拒绝未知 format_ver / algo_id', () => {
    const bad = Buffer.from(
      encryptField({
        plaintext: 'x',
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        dek: DEK,
        keyVer: 1,
      }),
    );
    bad[0] = 0x09;
    expect(() => parseCiphertext(bad)).toThrow(/format_ver/);

    const bad2 = Buffer.from(
      encryptField({
        plaintext: 'x',
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        dek: DEK,
        keyVer: 1,
      }),
    );
    bad2[2] = 0x09;
    expect(() => parseCiphertext(bad2)).toThrow(/algo_id/);
  });
});

describe('验收 1 · GCM 往返一致', () => {
  const cases = [
    '订单号 1234567890',
    'https://booking.example.com/order/abc?token=xyz',
    '联系人 张三',
    'a',
    '中文与emoji 🧳🌏 与换行\n第二行',
  ];

  for (const plaintext of cases) {
    it(`往返一致：${plaintext.slice(0, 24)}`, () => {
      const ct = encryptField({
        plaintext,
        table: 'booking',
        primaryKey: 10086,
        column: 'order_no_enc',
        dek: DEK,
        keyVer: 3,
      });
      const back = decryptField({
        raw: ct,
        table: 'booking',
        primaryKey: 10086,
        column: 'order_no_enc',
        resolveDek,
      });
      expect(back).toBe(plaintext);
    });
  }

  it('密文字节 = 15 + len(plaintext utf8) + 16（中文按字节算）', () => {
    const plaintext = '订单号';
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 1,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    expect(ct.length).toBe(HEADER_LENGTH + plaintextByteLength(plaintext) + 16);
    expect(ct.length).toBe(15 + 9 + 16);
  });

  it('同一明文两次加密产出不同密文（IV 每记录唯一）', () => {
    const args = {
      plaintext: 'same',
      table: 'booking',
      primaryKey: 7,
      column: 'order_no_enc' as const,
      dek: DEK,
      keyVer: 1,
    };
    const a = encryptField(args);
    const b = encryptField(args);
    expect(a.equals(b)).toBe(false); // IV 随机 => 密文不同
    // 但都能解回原文
    expect(decryptField({ raw: a, ...args, resolveDek })).toBe('same');
    expect(decryptField({ raw: b, ...args, resolveDek })).toBe('same');
  });

  it('key_ver 写入密文头第 2 字节', () => {
    const ct = encryptField({
      plaintext: 'x',
      table: 'booking',
      primaryKey: 1,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 200,
    });
    expect(ct.readUInt8(0)).toBe(FormatVer.V1);
    expect(ct.readUInt8(1)).toBe(200);
    expect(ct.readUInt8(2)).toBe(AlgoId.Aes256Gcm);
  });

  it('解密可接受裸 Uint8Array（Prisma 真实返回类型）', () => {
    const ct = encryptField({
      plaintext: 'order-abc',
      table: 'booking',
      primaryKey: 9,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    const asUint8 = new Uint8Array(ct); // 模拟 Prisma VARBINARY 返回
    expect(
      decryptField({
        raw: asUint8,
        table: 'booking',
        primaryKey: 9,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toBe('order-abc');
  });

  it('可空列：null 返回 null', () => {
    expect(
      decryptFieldOrNull({
        raw: null,
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toBeNull();
  });

  it('明文超容量：加密前即抛错', () => {
    const tooLong = 'x'.repeat(maxPlaintextFor(ColumnCapacity.order_no_enc) + 1);
    expect(() =>
      encryptField({
        plaintext: tooLong,
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        dek: DEK,
        keyVer: 1,
      }),
    ).toThrow(/超出列/);
  });
});

describe('验收 2 · AAD 跨表搬运拒绝（最关键的越权防线）', () => {
  const plaintext = '机密订单链接 https://secret.example.com/xyz';

  it('密文搬到另一张表 → 认证失败，不得静默成功', () => {
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 123,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });

    // 攻击者/误操作：把 booking 表 123 行的密文原样搬到 trip_contact 表 123 行
    expect(() =>
      decryptField({
        raw: ct,
        table: 'trip_contact',
        primaryKey: 123,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toThrow(); // 必须抛错
  });

  it('密文搬到同表另一主键 → 认证失败', () => {
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 123,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    expect(() =>
      decryptField({
        raw: ct,
        table: 'booking',
        primaryKey: 124,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toThrow();
  });

  it('裸主键会致AAD 相同 → 这正是必须加表标识的原因（反证）', () => {
    // 若AAD 只用裸主键：两表 123 行 AAD 一致，密文搬运后校验会通过。
    const aadBare123 = buildAad(1, 1, 1, '123');
    const bareFromBooking = buildAad(1, 1, 1, '123');
    expect(aadBare123.equals(bareFromBooking)).toBe(true);

    // 加表标识后 AAD 不同 —— 搬运即被拦
    const aadBooking = buildAad(1, 1, 1, 'booking:123');
    const aadContact = buildAad(1, 1, 1, 'trip_contact:123');
    expect(aadBooking.equals(aadContact)).toBe(false);
  });

  it('AAD = format_ver ‖ key_ver ‖ algo_id ‖ recordId', () => {
    const aad = buildAad(0x01, 0x02, 0x01, 'booking:123');
    expect(aad.subarray(0, 3)).toEqual(Buffer.from([0x01, 0x02, 0x01]));
    expect(aad.subarray(3).toString('utf8')).toBe('booking:123');
  });

  it('换 DEK 后旧密文解不开（不同 key_ver 走不同 DEK）', () => {
    const otherDek = randomBytes(32);
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 5,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    expect(() =>
      decryptField({
        raw: ct,
        table: 'booking',
        primaryKey: 5,
        column: 'order_no_enc',
        resolveDek: () => otherDek,
      }),
    ).toThrow();
  });

  it('密文被篡改 1 字节 → 认证失败', () => {
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 5,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    const tampered = Buffer.from(ct);
    tampered[20] = tampered[20]! ^ 0xff;
    expect(() =>
      decryptField({
        raw: tampered,
        table: 'booking',
        primaryKey: 5,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toThrow();
  });
});

describe('验收 3 · 无静默失败', () => {
  it('DB 返回裸 Uint8Array 时必须能正确解密（非静默空串）', () => {
    const plaintext = 'NON_EMPTY_SENTINEL';
    const ct = encryptField({
      plaintext,
      table: 'booking',
      primaryKey: 42,
      column: 'order_no_enc',
      dek: DEK,
      keyVer: 1,
    });
    const fromPrisma = new Uint8Array(ct);
    const out = decryptField({
      raw: fromPrisma,
      table: 'booking',
      primaryKey: 42,
      column: 'order_no_enc',
      resolveDek,
    });
    // 若实现把 Uint8Array 直接传 crypto，会得到 '' 且不报错
    expect(out).not.toBe('');
    expect(out).toBe(plaintext);
  });

  it('传垃圾类型时抛错而非返回空串', () => {
    expect(() =>
      decryptField({
        raw: 'not-a-cipher',
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        resolveDek,
      }),
    ).toThrow(TypeError);
  });

  it('DEK 长度非法时抛错', () => {
    expect(() =>
      encryptField({
        plaintext: 'x',
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        dek: randomBytes(16),
        keyVer: 1,
      }),
    ).toThrow(/32B/);
  });

  it('key_ver 越界抛错', () => {
    expect(() =>
      encryptField({
        plaintext: 'x',
        table: 'booking',
        primaryKey: 1,
        column: 'order_no_enc',
        dek: DEK,
        keyVer: 256,
      }),
    ).toThrow(/0–255/);
  });
});
