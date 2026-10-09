/**
 * M5/M6 验收口径 7/8 —— 派发单 §六
 *   7  M5 保留期可验证：保留期 ≥2 年可查
 *   8  M6 EXIF 剥离：带 GPS 图被剥离 + 记审计
 */
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import {
  AUDIT_MIN_RETENTION_YEARS,
  AUDIT_RETENTION_YEARS,
  AuditReason,
  AuditSeverity,
  PIPL_MIN_RETENTION_YEARS,
  buildCleanupQuery,
  computeRetainUntil,
  isInRetention,
  runAuditCleanup,
  type AuditQuery,
  type AuditRepository,
  type AuditRow,
} from '../audit/audit-retention.js';
import { isJpeg, probeExif, stripExifServerSide, stripJpegSegmentsFallback } from './exif-strip.js';

describe('验收 7 · M5 保留期 ≥2 年可查', () => {
  it('保留期基线为 2 年（PIPL ≥1 年，取更严者）', () => {
    expect(PIPL_MIN_RETENTION_YEARS).toBe(1);
    expect(AUDIT_RETENTION_YEARS).toBe(2);
    expect(AUDIT_RETENTION_YEARS).toBeGreaterThanOrEqual(AUDIT_MIN_RETENTION_YEARS);
  });

  it('retain_until = 创建时刻 + 2 年，可查', () => {
    const created = new Date('2026-05-01T10:00:00.000Z');
    const until = computeRetainUntil(created);
    expect(until.toISOString()).toBe('2028-05-01T10:00:00.000Z');
    // 跨闰年 2028（2 月 29 天），2 年实际为 731 天，必须 ≥ 730 天
    const days = (until.getTime() - created.getTime()) / 86400000;
    expect(days).toBe(731);
    expect(days).toBeGreaterThanOrEqual(730);
  });

  it('低于合规下限的保留期直接拒写', () => {
    expect(() => computeRetainUntil(new Date(), 1)).toThrow(/低于合规下限/);
    expect(() => computeRetainUntil(new Date(), 0)).toThrow(/低于合规下限/);
  });

  it('isInRetention 能判定记录是否仍在保留期内', () => {
    const created = new Date('2026-01-01T00:00:00.000Z');
    const until = computeRetainUntil(created);
    expect(isInRetention({ retainUntil: until }, new Date('2027-01-01T00:00:00.000Z'))).toBe(true);
    expect(isInRetention({ retainUntil: until }, new Date('2029-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('闰日不溢出（用 setUTCFullYear 而非毫秒加法）', () => {
    const leap = new Date('2024-02-29T00:00:00.000Z');
    const until = computeRetainUntil(leap);
    // setUTCFullYear 在 2 月 29 天溢出时自然落到 3 月 1 日，仍满足 ≥2 年保留期
    expect(until.toISOString().slice(0, 10)).toBe('2026-03-01');
  });
});

describe('M5 清理任务只删已到期记录', () => {
  const rows: AuditRow[] = [];
  const repo: AuditRepository = {
    async insert(row) {
      const created = row.createdAt ?? new Date('2024-01-01T00:00:00.000Z');
      const id = BigInt(rows.length + 1);
      rows.push({ ...row, id, createdAt: created });
      return id;
    },
    async deleteExpired(q: AuditQuery) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i]!;
        if (r.retainUntil < q.expiredBefore) {
          rows.splice(i, 1);
          n += 1;
        }
      }
      return n;
    },
    async countInRetention(now: Date) {
      return rows.filter((r) => r.retainUntil.getTime() > now.getTime()).length;
    },
  };

  it('查询条件必须含 retain_until < now', () => {
    const q = buildCleanupQuery(new Date('2026-10-09T00:00:00.000Z'));
    expect(q.expiredBefore).toBeInstanceOf(Date);
    expect(q.expiredBefore.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });

  it('batch size 被夹在安全区间', () => {
    expect(buildCleanupQuery(new Date(), 0).limit).toBe(1);
    expect(buildCleanupQuery(new Date(), 999999).limit).toBe(10000);
  });

  it('清理只删已到期，保留期内记录数不变', async () => {
    const old = await repo.insert({
      actorId: 1n,
      action: 'DECRYPT',
      reason: AuditReason.OrderDecrypted,
      severity: AuditSeverity.Warn,
      retainUntil: new Date('2026-01-01T00:00:00.000Z'),
      targetType: 'booking',
      targetId: 1n,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    });
    const fresh = await repo.insert({
      actorId: 1n,
      action: 'DECRYPT',
      reason: AuditReason.OrderDecrypted,
      severity: AuditSeverity.Warn,
      retainUntil: new Date('2028-01-01T00:00:00.000Z'),
      targetType: 'booking',
      targetId: 2n,
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(old).toBe(1n);
    expect(fresh).toBe(2n);

    const res = await runAuditCleanup(repo, new Date('2026-10-09T00:00:00.000Z'));
    expect(res.deleted).toBe(1);
    expect(res.skippedInRetention).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(fresh);
  });
});

/** 构造一张带 EXIF + GPS 的最小 JPEG */
function jpegWithGps(): Buffer {
  const exifPayload = Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    Buffer.from([0x49, 0x49, 0x2a, 0x00]),
    Buffer.from('GPSInfo', 'ascii'), // GPS IFD 标记
    Buffer.alloc(20, 0),
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(exifPayload.length + 2);
      return len;
    })(),
    exifPayload,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    app1,
    Buffer.from([0xff, 0xda, 0x00, 0x08]), // SOS
    Buffer.from([0x01, 0x02, 0x03, 0x04]), // 像素数据
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

/** 构造一张不含 EXIF 的 JPEG */
function plainJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xda, 0x00, 0x08]),
    Buffer.from([0x01, 0x02, 0x03, 0x04]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

describe('验收 8 · M6 EXIF 剥离 + GPS 审计', () => {
  it('识别 JPEG', () => {
    expect(isJpeg(plainJpeg())).toBe(true);
    expect(isJpeg(Buffer.from([0x89, 0x50]))).toBe(false);
  });

  it('探测出 EXIF 与 GPS', () => {
    const probe = probeExif(jpegWithGps());
    expect(probe.hadExif).toBe(true);
    expect(probe.hadGps).toBe(true);
  });

  it('无 EXIF 的图探测为 false', () => {
    expect(probeExif(plainJpeg())).toEqual({ hadExif: false, hadGps: false });
  });

  it('🔴 带 GPS 的图被剥离，GPS 段消失', () => {
    const input = jpegWithGps();
    const out = stripJpegSegmentsFallback(input);
    expect(out.length).toBeLessThan(input.length);
    expect(out.includes(Buffer.from('GPS', 'ascii'))).toBe(false);
    expect(out.includes(Buffer.from('Exif', 'ascii'))).toBe(false);
  });

  it('剥离后仍是合法 JPEG（SOI + EOI 保留）', () => {
    const out = stripJpegSegmentsFallback(jpegWithGps());
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xd8);
    expect(isJpeg(out)).toBe(true);
    expect(out.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it('兜底剥离返回结构完整，可落库 exifStripped', async () => {
    const res = await stripExifServerSide(jpegWithGps());
    expect(res.hadGps).toBe(true); // → 上层据此记ALERT 审计
    expect(res.exifStripped).toBe(true);
    expect(res.data.includes(Buffer.from('GPS', 'ascii'))).toBe(false);
  });

  it('优先走 ImageProcessor（sharp）路径', async () => {
    const res = await stripExifServerSide(jpegWithGps(), {
      processor: {
        async stripMetadata() {
          return Buffer.from('RE-ENCODED');
        },
      },
    });
    expect(res.data.toString()).toBe('RE-ENCODED');
    expect(res.exifStripped).toBe(true);
  });

  it('sharp 失败时降级到纯 TS 兜底，仍不静默放过', async () => {
    const res = await stripExifServerSide(jpegWithGps(), {
      processor: {
        async stripMetadata() {
          throw new Error('native module crashed');
        },
      },
    });
    expect(res.data.includes(Buffer.from('GPS', 'ascii'))).toBe(false);
  });

  it('无可处理处理器且为非 JPEG → 原样返回并标记未剥离（上层需告警）', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    const res = await stripExifServerSide(png);
    expect(res.data.equals(png)).toBe(true);
  });

  it('审计原因码齐备（GPS 检出 → GpsInExif/ALERT）', () => {
    expect(AuditReason.GpsInExif).toBe('GPS_IN_EXIF');
    expect(AuditReason.ExifStripped).toBe('EXIF_STRIPPED');
    expect(AuditSeverity.Alert).toBe('ALERT');
  });
});
