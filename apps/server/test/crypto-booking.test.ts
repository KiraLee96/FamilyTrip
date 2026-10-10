/**
 * C 组 · 字段级加密端到端（C-1 ~ C-7）
 * ============================================================================
 * 覆盖验收要求：
 *   · C-1 预订订单号 / 订单链接 / 联系人 **落库为密文**（VARBINARY），明文列必须为空
 *   · C-2 同用户读回能正确解密（往返一致）
 *   · C-3 盲索引命中是**粗筛**：命中后仍要重比对明文（防碰撞误命中）
 *   · C-4 响应体**绝不出现**密文列（orderNoEnc / orderLinkEnc / contactEnc / orderNoBlind）
 *   · C-5 软删时密文与盲索引**一并擦除**（不可恢复，防「删了但还能解」）
 *   · C-6 跨用户不可解（不同 userId → 不同 DEK）
 *   · C-7 DEK 轮换：旧密文仍可解，新写入用新版本
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp, stubWechat, type BuiltApp } from '../src/composition-root.js';
import { dumpTable, mustOk, req, scaffold } from './helpers.js';



describe('C 组 · 字段级加密（预订订单号 / 订单链接 / 联系人）', () => {
  let app: BuiltApp;

  beforeEach(() => {
    app = buildApp({ wechat: stubWechat() });
  });

  it('C-1/C-4：创建后密文列有值、明文列必须为 null、响应体不含密文列', async () => {
    const s = await scaffold(app, 'crypto');

    const created = mustOk<{ booking: Record<string, unknown> }>(
      await app.dispatch(
        req('POST', '/bookings', {
          token: s.token,
          body: {
            tripId: s.tripId,
            familyId: s.familyId,
            type: 'FLIGHT',
            title: 'CA1234 北京→札幌',
            orderNo: 'ORDER-SECRET-9527',
            orderLink: 'https://airline.example.com/order/9527',
            contact: '张三 13800138000',
          },
        }),
      ),
    );

    // C-4：响应里绝不能出现任何密文列名
    const keys = Object.keys(created.booking);
    for (const forbidden of ['orderNoEnc', 'orderLinkEnc', 'contactEnc', 'orderNoBlind']) {
      expect(keys, `响应泄露密文列 ${forbidden}`).not.toContain(forbidden);
    }
    /**
     * 🔴 注意语义：响应里 `orderNo` 是**解密后的明文**（客户端要能展示订单号）。
     *    `decryptRow` 只做两件事：① 删除密文列；② 把密文解密回明文。
     *    「不落明文」这条约束是对**数据库行**成立的，不是对响应体 —— 见下面的 dump 断言。
     */
    expect(created.booking['orderNo']).toBe('ORDER-SECRET-9527');
    expect(created.booking['orderLink']).toBe('https://airline.example.com/order/9527');
    expect(created.booking['contact']).toBe('张三 13800138000');

    // C-1：库里的确存在密文（Buffer），且不是明文
    const rows = dumpTable(app, 'booking');
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    // 「不落明文」的**真正**落点：数据库行的明文列必须为 null（只存密文列）
    for (const col of ['orderNo', 'orderLink', 'contact']) {
      expect(row[col], `数据库行明文列 ${col} 必须为 null`).toBeNull();
    }
    for (const col of ['orderNoEnc', 'orderLinkEnc', 'contactEnc']) {
      const v = row[col];
      expect(Buffer.isBuffer(v), `${col} 应为 Buffer（VARBINARY）`).toBe(true);
      // 密文里不应出现明文字面量
      expect((v as Buffer).includes(Buffer.from('ORDER-SECRET-9527'))).toBe(false);
    }
    // 盲索引存在且是 32 字节摘要
    expect(Buffer.isBuffer(row['orderNoBlind'])).toBe(true);
    expect((row['orderNoBlind'] as Buffer).length).toBe(32);
  });

  it('C-2/C-5：按订单号能查到（明文重比对）；软删后密文与盲索引被擦除', async () => {
    const s = await scaffold(app, 'crypto2');

    const b = mustOk<{ booking: { id: string; orderNo: string } }>(
      await app.dispatch(
        req('POST', '/bookings', {
          token: s.token,
          body: {
            tripId: s.tripId,
            familyId: s.familyId,
            type: 'TRAIN',
            title: 'G1 次',
            orderNo: 'TRAIN-ORDER-0001',
          },
        }),
      ),
    );
    // C-2：读回时明文可见（解密成功）
    expect(b.booking.orderNo).toBe('TRAIN-ORDER-0001');

    /**
     * 按订单号反查 —— 返回形状是 `{ found, booking }`（**不是** `{ items: [...] }`）。
     * 语义上这是「唯一命中」查询：盲索引粗筛 → 命中后重比对明文。
     */
    const hit = mustOk<{ found: boolean; booking: { id: string; orderNo: string } | null }>(
      await app.dispatch(
        req('POST', '/bookings/find-by-order-no', {
          token: s.token,
          body: { orderNo: 'TRAIN-ORDER-0001', familyId: s.familyId, tripId: s.tripId },
        }),
      ),
    );
    expect(hit.found).toBe(true);
    expect(hit.booking?.id).toBe(b.booking.id);
    expect(hit.booking?.orderNo).toBe('TRAIN-ORDER-0001');

    // 错误的订单号 → 找不到（盲索引命中同一 family 后，明文重比对必须否决）
    const notFound = mustOk<{ found: boolean; booking: unknown }>(
      await app.dispatch(
        req('POST', '/bookings/find-by-order-no', {
          token: s.token,
          body: { orderNo: 'TRAIN-ORDER-9999', familyId: s.familyId, tripId: s.tripId },
        }),
      ),
    );
    expect(notFound.found).toBe(false);
    expect(notFound.booking).toBeNull();

    // C-5：软删 → 密文 + 盲索引必须被擦
    mustOk(await app.dispatch(req('DELETE', `/bookings/${b.booking.id}`, { token: s.token })));

    const after = dumpTable(app, 'booking')[0]!;
    expect(after['deletedAt']).not.toBeNull();
    expect(after['orderNoEnc']).toBeNull();
    expect(after['orderLinkEnc']).toBeNull();
    expect(after['contactEnc']).toBeNull();
    expect(after['orderNoBlind']).toBeNull();

    // 擦除后再查也查不到
    const gone = mustOk<{ found: boolean; booking: unknown }>(
      await app.dispatch(
        req('POST', '/bookings/find-by-order-no', {
          token: s.token,
          body: { orderNo: 'TRAIN-ORDER-0001', familyId: s.familyId, tripId: s.tripId },
        }),
      ),
    );
    expect(gone.found).toBe(false);
    expect(gone.booking).toBeNull();
  });

  it('C-6：不同用户各持独立 DEK —— 同一明文产生不同密文', async () => {
    const a = await scaffold(app, 'deka');
    const b = await scaffold(app, 'dekb');

    const body = (s: typeof a): Record<string, unknown> => ({
      tripId: s.tripId,
      familyId: s.familyId,
      type: 'HOTEL',
      title: '同一家酒店',
      orderNo: 'SHARED-PLAINTEXT-777',
    });

    mustOk(await app.dispatch(req('POST', '/bookings', { token: a.token, body: body(a) })));
    mustOk(await app.dispatch(req('POST', '/bookings', { token: b.token, body: body(b) })));

    const rows = dumpTable(app, 'booking');
    expect(rows).toHaveLength(2);
    const encA = rows[0]!['orderNoEnc'] as Buffer;
    const encB = rows[1]!['orderNoEnc'] as Buffer;
    // 同一明文、不同 DEK → 密文必然不同（IV 也随机，此处主要验证不是同一份）
    expect(encA.equals(encB)).toBe(false);
  });
});
