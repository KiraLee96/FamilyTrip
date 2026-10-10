/**
 * booking 域 · service（C-1~C-7 字段级加密落地）
 * ============================================================================
 * 这是**加密域**：订单号 / 订单链接 / 联系方式三个字段密文落库。
 *
 * 🔴 红线清单（本文件是执行现场）：
 *   R1 · toBuffer 纪律 —— 密文进出必须经 `toBuffer(raw, 'table.column')`，
 *        绝不 `as Buffer` 强转。Prisma 的 Bytes 在不同驱动下可能是
 *        Buffer / Uint8Array / 对象，强转会在生产中炸。
 *   R3 · 盲索引与密文**同事务**写入 —— 分两次事务会出现
 *        「密文在、盲索引不在」→ 按订单号查不到，用户以为丢单。
 *   R4 · AAD 含表标识 —— `buildRecordId(table, primaryKey)`，
 *        防止「A 表的密文被搬到 B 表后还能解密」的跨表重放。
 *   R6 · 档位切换不重算历史 —— 换 DEK 版本后老密文仍用老 key_ver 解，
 *        不回写、不重加密（重加密是显式的运维动作，须留审计）。
 *
 * 🔴 加密时机：**必须在事务内**做本地加解密（KMS 网络调用禁止在事务内，
 *    故 DEK 需先 prefetch 到本地缓存）。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import type { DomainContext, TxHandle } from '../domain-context.js';
import { serializeRow } from '../domain-context.js';
import type {
  FieldCryptoService} from '../../common/crypto/field-crypto-service.js';
import {
  BOOKING_ENCRYPTED_FIELDS,
  type EncryptedFieldSpec,
} from '../../common/crypto/field-crypto-service.js';
import { toMinorUnits } from '../../common/fx/amount.js';
import { buildPageMeta, normalizePageQuery } from '../../common/pagination/pagination.js';

export interface BookingServiceOptions {
  ctx: DomainContext;
  /** 按 userId 取加密服务（per-user DEK） */
  cryptoFor: (userId: bigint) => FieldCryptoService;
  auditRetentionDays?: number;
}

const BOOKING_BIGINT_FIELDS = ['id', 'tripId', 'createdBy', 'amount', 'amountBase'];
/** 响应里必须剔除的密文列 —— 绝不外泄给客户端 */
const CIPHERTEXT_COLUMNS = ['orderNoEnc', 'orderLinkEnc', 'contactEnc', 'orderNoBlind'];

export class BookingService {
  private readonly retentionDays: number;

  constructor(private readonly o: BookingServiceOptions) {
    this.retentionDays = o.auditRetentionDays ?? 365;
  }

  /** 创建预订 —— 敏感字段加密 + 盲索引（R3 同事务） */
  async create(userId: bigint, input: {
    tripId: bigint;
    familyId: bigint;
    type: string;
    title: string;
    provider?: string;
    orderNo?: string;
    orderLink?: string;
    contact?: string;
    startAt?: string;
    endAt?: string;
    amount?: string;
    currency: string;
    note?: string;
  }): Promise<Record<string, unknown>> {
    // DEK 预取必须在事务**外**（KMS 是网络调用，事务内禁止）
    const crypto = this.o.cryptoFor(userId);
    await crypto.prefetchDek(1);

    return this.o.ctx.tx(async (tx) => {
      const t = await tx.db.findUnique('trip', { id: input.tripId, deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      const id = tx.write.nextId();

      // 敏感字段 → 密文 + 盲索引
      const { encrypted, blindIndexes } = await crypto.buildWritePayload({
        specs: BOOKING_ENCRYPTED_FIELDS,
        primaryKey: id,
        plaintexts: {
          orderNo: input.orderNo ?? null,
          orderLink: input.orderLink ?? null,
          contact: input.contact ?? null,
        },
        lowCardinalityValues: {
          // 🔑 盲索引盐：必须与 BOOKING_ENCRYPTED_FIELDS.orderNo.blindIndex.lowCardinality
          //    集合逐字一致（familyId + tripId），否则反查时摘要不匹配 → 永远查不到。
          familyId: input.familyId,
          tripId: input.tripId,
        },
      });

      const amountMinor =
        input.amount !== undefined ? toMinorUnits(input.amount, input.currency) : null;

      await tx.db.insert('booking', {
        id,
        tripId: input.tripId,
        familyId: input.familyId,
        createdBy: userId,
        type: input.type,
        title: input.title,
        provider: input.provider ?? null,
        // 🔒 密文列（VARBINARY）
        orderNoEnc: encrypted['order_no_enc'] ?? null,
        orderLinkEnc: encrypted['order_link_enc'] ?? null,
        contactEnc: encrypted['contact_enc'] ?? null,
        // 🔑 盲索引（与密文同事务，R3）
        orderNoBlind: blindIndexes['order_no_blind'] ?? null,
        // 明文列一律不落（防「顺手也存一份」的习惯性泄漏）
        orderNo: null,
        orderLink: null,
        contact: null,
        startAt: input.startAt !== undefined ? parseLocal(input.startAt) : null,
        endAt: input.endAt !== undefined ? parseLocal(input.endAt) : null,
        amount: amountMinor,
        currency: input.currency.toUpperCase(),
        amountBase: null,
        rateSource: 'SAME_CURRENCY',
        rateBy: null,
        status: 'PENDING',
        note: input.note ?? null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      await this.change(tx, 'booking', id, input.familyId, input.tripId, 'INSERT', now);

      await this.audit(tx, {
        actorId: userId,
        action: 'booking.create',
        reason: 'BOOKING_CREATED',
        severity: 'INFO',
        targetId: id,
        // ⚠️ T-4：detail 绝不落明文敏感字段，只记「哪些字段被加密了」
        detail: { encryptedFields: Object.keys(BOOKING_ENCRYPTED_FIELDS) },
        at: now,
      });

      const row = await tx.db.findUnique('booking', { id });
      return this.decryptRow(crypto, row ?? {}, id, true);
    });
  }

  /** 列表 —— 默认解密敏感字段（列表页要展示订单号） */
  async list(userId: bigint, q: {
    tripId?: bigint;
    familyId?: bigint;
    type?: string;
    status?: string;
    includeSecrets: boolean;
    page?: unknown;
    pageSize?: unknown;
  }): Promise<{ items: Record<string, unknown>[]; meta: Record<string, unknown>; }> {
    const page = normalizePageQuery(q.page, q.pageSize);
    const visible = await this.visibleTripIds(userId);

    const all = await this.o.ctx.read.findMany('booking', { where: { deletedAt: null } });
    let rows = all.filter((b) => visible.has(b['tripId'] as bigint));
    if (q.tripId !== undefined) rows = rows.filter((b) => b['tripId'] === q.tripId);
    if (q.familyId !== undefined) rows = rows.filter((b) => b['familyId'] === q.familyId);
    if (q.type !== undefined) rows = rows.filter((b) => b['type'] === q.type);
    if (q.status !== undefined) rows = rows.filter((b) => b['status'] === q.status);

    rows = [...rows].sort((a, b) => timeOf(b['createdAt']) - timeOf(a['createdAt']));
    const slice = rows.slice(page.skip, page.skip + page.take);

    const crypto = this.o.cryptoFor(userId);
    if (q.includeSecrets) {
      // 一次性预取本页密文涉及的所有 key_ver（减少 KMS 往返）
      await crypto.prefetchForCiphertexts(
        slice.flatMap((r) => [r['orderNoEnc'], r['orderLinkEnc'], r['contactEnc']]),
      );
    }

    const items: Array<Record<string, unknown>> = [];
    for (const r of slice) {
      items.push(await this.decryptRow(crypto, r, r['id'] as bigint, q.includeSecrets));
    }

    return { items, meta: buildPageMeta(page, rows.length) as unknown as Record<string, unknown> };
  }

  /** 详情 */
  async detail(userId: bigint, bookingId: bigint): Promise<Record<string, unknown>> {
    const r = await this.o.ctx.read.findUnique('booking', { id: bookingId, deletedAt: null });
    if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    await this.assertBookingVisible(this.o.ctx, r, userId);

    const crypto = this.o.cryptoFor(userId);
    await crypto.prefetchForCiphertexts([r['orderNoEnc'], r['orderLinkEnc'], r['contactEnc']]);
    return this.decryptRow(crypto, r, bookingId, true);
  }

  /**
   * 按订单号查找 —— **走盲索引**（R3/R7）。
   *
   * 🔴 绝不遍历解密全部记录做「内存里比对」：
   *    那是 O(n) 次解密，既慢又违反 R7（禁止以「扫一遍」代替索引）。
   *    正确做法：用**与写入时完全同构**的算式算出目标 blind，直接等值查。
   *
   * 🔴 同构是这里唯一的正确性来源：
   *    · 低基数字段集合必须与 `BOOKING_ENCRYPTED_FIELDS.orderNo.blindIndex.lowCardinality`
   *      逐字一致（当前是 `familyId` + `tripId`）。少传一个 → 摘要不同 → 永远查不到。
   *    · 被索引值必须传**明文订单号**（而不是主键）—— 盲索引的意义就在于
   *      「仅有明文即可反查」，掺主键会让它退化成不可检索的指纹。
   *    所以调用方必须同时给出 familyId 与 tripId。
   */
  async findByOrderNo(userId: bigint, input: { orderNo: string; familyId: bigint; tripId: bigint }): Promise<{ found: boolean; booking: null; } | { found: boolean; booking: Record<string, unknown>; }> {
    const crypto = this.o.cryptoFor(userId);
    const blind = crypto.computeBlind({
      spec: BOOKING_ENCRYPTED_FIELDS['orderNo'] as EncryptedFieldSpec,
      value: input.orderNo,
      values: { familyId: input.familyId, tripId: input.tripId },
    });
    if (blind === null) {
      // 该字段没配盲索引 → 无法按密文等值查，只能退回全表筛
      throw new AppError(ErrorCode.INTERNAL_ERROR, '订单号字段缺少盲索引配置');
    }

    const hits = await this.o.ctx.read.findMany('booking', {
      where: { orderNoBlind: blind, deletedAt: null },
    });
    if (hits.length === 0) return { found: false, booking: null };

    const hit = hits[0]!;
    await this.assertBookingVisible(this.o.ctx, hit, userId);
    await crypto.prefetchForCiphertexts([hit['orderNoEnc']]);
    const booking = await this.decryptRow(crypto, hit, hit['id'] as bigint, true);

    // 盲索引是**粗筛**（同 family+trip 内仍可能碰撞），必须再比对解密后的明文
    if (booking['orderNo'] !== input.orderNo) return { found: false, booking: null };
    return { found: true, booking };
  }

  /** 更新（CAS）—— 敏感字段变更即重新加密 */
  async update(userId: bigint, bookingId: bigint, patch: {
    version: number;
    title?: string;
    provider?: string | null;
    orderNo?: string | null;
    orderLink?: string | null;
    contact?: string | null;
    startAt?: string | null;
    endAt?: string | null;
    amount?: string;
    currency?: string;
    status?: string;
    note?: string | null;
  }): Promise<Record<string, unknown>> {
    const crypto = this.o.cryptoFor(userId);
    await crypto.prefetchDek(1);

    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('booking', { id: bookingId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: r['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      const data: Row = { updatedAt: now, version: patch.version + 1 };
      if (patch.title !== undefined) data['title'] = patch.title;
      if (patch.provider !== undefined) data['provider'] = patch.provider;
      if (patch.status !== undefined) data['status'] = patch.status;
      if (patch.note !== undefined) data['note'] = patch.note;
      if (patch.startAt !== undefined) data['startAt'] = patch.startAt === null ? null : parseLocal(patch.startAt);
      if (patch.endAt !== undefined) data['endAt'] = patch.endAt === null ? null : parseLocal(patch.endAt);

      // 敏感字段：任一变更 → 重算密文 + 盲索引（同事务，R3）
      const sensitiveTouched =
        patch.orderNo !== undefined || patch.orderLink !== undefined || patch.contact !== undefined;
      if (sensitiveTouched) {
        const { encrypted, blindIndexes } = await crypto.buildWritePayload({
          specs: BOOKING_ENCRYPTED_FIELDS,
          primaryKey: bookingId,
          plaintexts: {
            orderNo: patch.orderNo !== undefined ? patch.orderNo : null,
            orderLink: patch.orderLink !== undefined ? patch.orderLink : null,
            contact: patch.contact !== undefined ? patch.contact : null,
          },
          lowCardinalityValues: {
            // 与创建路径逐字一致：familyId + tripId 两个盐都要给，
            // 否则更新后算出的 blind 与创建时不同 → 索引失效。
            familyId: r['familyId'] as bigint,
            tripId: r['tripId'] as bigint,
          },
        });
        if (patch.orderNo !== undefined) {
          data['orderNoEnc'] = encrypted['order_no_enc'] ?? null;
          data['orderNoBlind'] = blindIndexes['order_no_blind'] ?? null;
        }
        if (patch.orderLink !== undefined) data['orderLinkEnc'] = encrypted['order_link_enc'] ?? null;
        if (patch.contact !== undefined) data['contactEnc'] = encrypted['contact_enc'] ?? null;
      }

      if (patch.amount !== undefined || patch.currency !== undefined) {
        const cur = (patch.currency ?? String(r['currency'])).toUpperCase();
        data['amount'] = patch.amount !== undefined ? toMinorUnits(patch.amount, cur) : (r['amount']);
        data['currency'] = cur;
      }

      const affected = await tx.db.update(
        'booking',
        { id: bookingId, version: patch.version, deletedAt: null },
        data,
      );
      if (affected === 0) {
        throw new AppError(ErrorCode.VERSION_CONFLICT, '该预订已被他人修改，请刷新后重试');
      }

      await this.change(tx, 'booking', bookingId, r['familyId'] as bigint, r['tripId'] as bigint, 'UPDATE', now);

      const row = await tx.db.findUnique('booking', { id: bookingId });
      return this.decryptRow(crypto, row ?? {}, bookingId, true);
    });
  }

  async remove(userId: bigint, bookingId: bigint): Promise<Date> {
    return this.o.ctx.tx(async (tx) => {
      const r = await tx.db.findUnique('booking', { id: bookingId, deletedAt: null });
      if (!r) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      const t = await tx.db.findUnique('trip', { id: r['tripId'], deletedAt: null });
      if (!t) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
      await this.assertTripWritable(tx, t, userId);

      const now = await tx.db.dbNow();
      // 软删时把密文一并清零 —— 数据保留策略与可读性解耦（保留行，抹除敏感内容）
      await tx.db.update('booking', { id: bookingId }, {
        deletedAt: now,
        orderNoEnc: null,
        orderLinkEnc: null,
        contactEnc: null,
        orderNoBlind: null,
        updatedAt: now,
      });
      await this.change(tx, 'booking', bookingId, r['familyId'] as bigint, r['tripId'] as bigint, 'DELETE', now);

      await this.audit(tx, {
        actorId: userId,
        action: 'booking.delete',
        reason: 'BOOKING_DELETED',
        severity: 'WARN',
        targetId: bookingId,
        detail: { secretsWiped: true },
        at: now,
      });

      return now;
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  /**
   * 解密并序列化一行。
   *
   * 🔴 密文列**必须剔除**：`orderNoEnc` 等一旦漏给客户端，
   *    等于把 ciphertext 送出去，且 R1 的 toBuffer 纪律会被绕过。
   */
  private async decryptRow(
    crypto: FieldCryptoService,
    row: Row,
    id: bigint,
    includeSecrets: boolean,
  ): Promise<Record<string, unknown>> {
    const base = serializeRow(row, BOOKING_BIGINT_FIELDS);
    for (const c of CIPHERTEXT_COLUMNS) delete base[c];

    if (!includeSecrets) return base;

    const orderNo = await crypto.decryptValue({
      spec: BOOKING_ENCRYPTED_FIELDS['orderNo'] as EncryptedFieldSpec,
      primaryKey: id,
      raw: row['orderNoEnc'],
    });
    const orderLink = await crypto.decryptValue({
      spec: BOOKING_ENCRYPTED_FIELDS['orderLink'] as EncryptedFieldSpec,
      primaryKey: id,
      raw: row['orderLinkEnc'],
    });
    const contact = await crypto.decryptValue({
      spec: BOOKING_ENCRYPTED_FIELDS['contact'] as EncryptedFieldSpec,
      primaryKey: id,
      raw: row['contactEnc'],
    });

    return { ...base, orderNo, orderLink, contact };
  }

  private async assertBookingVisible(src: TxHandle | DomainContext, r: Row, userId: bigint): Promise<void> {
    const visible = await this.visibleTripIds(userId);
    if (!visible.has(r['tripId'] as bigint)) {
      throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
    }
  }

  private async assertTripWritable(tx: TxHandle, t: Row, userId: bigint): Promise<void> {
    const m = await tx.db.findUnique('tripMember', { tripId: t['id'], userId, deletedAt: null });
    if (m) {
      if (m['accessLevel'] === 'HISTORICAL_READONLY') {
        throw new AppError(ErrorCode.FORBIDDEN, '该出行已归档，仅可查看');
      }
      return;
    }
    if (t['createdBy'] === userId) return;
    throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }

  private async visibleTripIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('tripMember', { where: { userId, deletedAt: null } });
    const managed = await this.o.ctx.read.findMany('tripMember', { where: { managedBy: userId, deletedAt: null } });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['tripId'] as bigint);
    for (const m of managed) s.add(m['tripId'] as bigint);
    return s;
  }

  private async change(
    tx: TxHandle,
    entityType: string,
    entityId: bigint,
    familyId: bigint | null,
    tripId: bigint | null,
    op: 'INSERT' | 'UPDATE' | 'DELETE',
    at: Date,
  ): Promise<void> {
    await tx.db.insert('changeLog', {
      id: tx.write.nextId(),
      entityType,
      entityId,
      familyId,
      tripId,
      op,
      changedAt: at,
      createdAt: at,
    });
  }

  private async audit(
    tx: TxHandle,
    e: {
      actorId: bigint;
      action: string;
      reason: string;
      severity: 'INFO' | 'WARN' | 'ALERT' | 'CRITICAL';
      targetId: bigint;
      detail?: Record<string, unknown>;
      at: Date;
    },
  ): Promise<void> {
    await tx.db.insert('auditLog', {
      id: tx.write.nextId(),
      actorId: e.actorId,
      action: e.action,
      reason: e.reason,
      severity: e.severity,
      retainUntil: new Date(e.at.getTime() + this.retentionDays * 86_400_000),
      targetType: 'booking',
      targetId: e.targetId,
      detail: e.detail ?? null,
      createdAt: e.at,
    });
  }
}

function parseLocal(s: string): Date {
  return new Date(`${s}:00.000Z`);
}

function timeOf(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  const t = new Date(String(v)).getTime();
  return Number.isFinite(t) ? t : 0;
}
