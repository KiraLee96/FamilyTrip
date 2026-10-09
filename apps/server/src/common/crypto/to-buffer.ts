/**
 * M2 · 二进制适配层
 * ---------------------------------------------------------------------------
 * 为什么需要这一层：
 *
 * Prisma 6.x 从 MySQL 读回 `VARBINARY` 时返回**裸 `Uint8Array`**，不是 `Buffer`。
 * `Buffer.isBuffer(new Uint8Array())` === false，而 Node crypto 的一批方法
 * （`slice` / `readUInt32BE` / `subarray` 的 Buffer 专有重载等）在 `Uint8Array`
 * 上不存在或语义不同。
 *
 * 最危险的地方在于：**把 `Uint8Array` 直接传给 crypto 层可能静默失败、不报错**。
 * 解密出来是空串，调用方拿到 ''，业务层写进 DB 表现为「这单没有订单号」，
 * 排查成本极高——因为没有任何异常、没有任何日志。
 *
 * 因此本文件是**唯一允许从 DB 读取二进制字段的入口**，红线 R1：
 * 加密字段的每一次 `decipher.update()` / `final()` 都必须经过 `toBuffer()`。
 */

/** 标量 ID：技术方案全栈用雪花 ID，落库为 BIGINT */
export type SnowflakeId = string | number | bigint;

/**
 * 归一化为 Node `Buffer`。
 *
 * 接受：Buffer / Uint8Array / ArrayBuffer / DataView / number[] / base64 字符串。
 * 拒绝：null / undefined / 其他 —— 一律抛错，**绝不返回空 Buffer**。
 *
 * 抛错而非兜底返回空 Buffer 是刻意的：静默返回空 Buffer 等于把「解密失败」
 * 伪装成「明文为空」，正是派发单要堵的洞。
 */
export function toBuffer(input: unknown, fieldName = 'binary'): Buffer {
  if (Buffer.isBuffer(input)) {
    // 已经是 Buffer，但可能是外部共享的视图 —— 复制一份防止调用方意外改写
    return Buffer.from(input);
  }

  if (input instanceof Uint8Array) {
    // Prisma VARBINARY 的真实返回类型走这里。
    // Buffer.from(uint8) 会**复制**字节，字节序保持不变 —— 正是我们要的。
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  if (input instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(input));
  }

  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }

  if (Array.isArray(input) && input.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Buffer.from(input);
  }

  if (typeof input === 'string') {
    // base64 —— DB 直传 / KMS 返回的常见形态
    const decoded = Buffer.from(input, 'base64');
    // Buffer.from 对非法 base64 不抛错而是丢弃脏字符，必须自己校验
    if (decoded.toString('base64').replace(/=+$/, '') !== input.replace(/=+$/, '')) {
      throw new TypeError(`${fieldName}: 字符串不是合法 base64，拒绝猜测解码`);
    }
    return decoded;
  }

  throw new TypeError(
    `${fieldName}: 无法转为 Buffer（收到 ${describe(input)}）。` +
      '加密字段读取必须经 toBuffer()；若是 Prisma 的 VARBINARY，请勿传裸 Uint8Array 以外的包装类型。',
  );
}

/** 空值守卫：DB 中可空加密列统一用它，而不是散落各处写 `if (!x)` */
export function toBufferOrNull(input: unknown, fieldName = 'binary'): Buffer | null {
  if (input === null || input === undefined) return null;
  return toBuffer(input, fieldName);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') return value.constructor?.name ?? 'Object';
  if (typeof value === 'string') return `string(${value})`;
  if (typeof value === 'number') return `number(${value})`;
  if (typeof value === 'boolean') return `boolean(${value})`;
  if (typeof value === 'bigint') return `bigint(${value})`;
  return typeof value; // symbol / function → 仅返回类型名
}

/**
 * recordId 的**唯一**编码入口。
 *
 * 🔴 派发单红线 4：必须含表标识，格式 `"<表标识>:<主键>"`。
 *
 * 为什么不能只用裸主键：两张表的主键同为 `123` 时，裸主键使两行AAD 完全相同。
 * 攻击者（或仅仅是运维误操作）把 A 表的密文整段搬到B 表的 `123` 行，
 * GCM 认证标签校验会**通过** —— 因为 key、IV、tag、AAD 全都一致 ——
 * 从而越权读出他人数据。加表标识后 AAD 不符，解密直接认证失败。
 */
export function buildRecordId(table: string, primaryKey: SnowflakeId): string {
  if (typeof table !== 'string' || table.trim() === '') {
    throw new TypeError('buildRecordId: table 不得为空（红线 R4：AAD recordId 必须含表标识）');
  }
  if (primaryKey === null || primaryKey === undefined || primaryKey === '') {
    throw new TypeError('buildRecordId: primaryKey 不得为空');
  }
  return `${table}:${String(primaryKey)}`;
}
