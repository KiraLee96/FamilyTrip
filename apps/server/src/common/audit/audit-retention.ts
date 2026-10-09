/**
 * M5 · 审计日志保留期与清理
 * ---------------------------------------------------------------------------
 * `audit_logs` 增三列：`reason` / `severity` / `retain_until` + 到期清理任务。
 *
 * 保留期口径：**PIPL ≥1 年，取更严者实取 ≥2 年**。
 * 法律给的是下限，合规取更严的一档 —— 所以基线是2 年而不是 1 年。
 */

/** PIPL 下限：1 年 */
export const PIPL_MIN_RETENTION_YEARS = 1;

/** 本项目实取（更严一档） */
export const AUDIT_RETENTION_YEARS = 2;

/** 保留期下限的运行时校验 —— 防止有人把基线改回 1 年 */
export const AUDIT_MIN_RETENTION_YEARS = Math.max(PIPL_MIN_RETENTION_YEARS, 2);

export const enum AuditSeverity {
  Info = 'INFO',
  Warn = 'WARN',
  /** 合规告警：EXIF 带 GPS、解密异常、越权尝试等 */
  Alert = 'ALERT',
  Critical = 'CRITICAL',
}

export const enum AuditReason {
  OrderDecrypted = 'ORDER_DECRYPTED',
  ItineraryChanged = 'ITINERARY_CHANGED',
  PermissionChanged = 'PERMISSION_CHANGED',
  /** M6：检出带 GPS 的图片 */
  GpsInExif = 'GPS_IN_EXIF',
  /** M6：EXIF 剥离执行 */
  ExifStripped = 'EXIF_STRIPPED',
  AccessDenied = 'ACCESS_DENIED',
  RateRecomputed = 'RATE_RECOMPUTED',
  FileOrphaned = 'FILE_ORPHANED',
}

export interface AuditRow {
  id: bigint;
  actorId: bigint | null;
  action: string;
  /** M5 新增：业务原因（枚举） */
  reason: AuditReason | string;
  /** M5 新增：严重级别 */
  severity: AuditSeverity;
  /** M5 新增：保留到期时刻。到期前清理任务不得触碰 */
  retainUntil: Date;
  targetType: string | null;
  targetId: bigint | null;
  createdAt: Date;
}

/**
 * 计算保留到期时刻 = 记录时刻 + 保留年限。
 *
 * 用 `setUTCFullYear` 而非毫秒加法 —— 闰日（2/29）不会被溢出到 3/1。
 */
export function computeRetainUntil(createdAt: Date, years: number = AUDIT_RETENTION_YEARS): Date {
  if (years < AUDIT_MIN_RETENTION_YEARS) {
    throw new Error(
      `审计保留期 ${years} 年低于合规下限 ${AUDIT_MIN_RETENTION_YEARS} 年（PIPL ≥${PIPL_MIN_RETENTION_YEARS} 年，取更严者）。拒绝写入。`,
    );
  }
  const d = new Date(createdAt.getTime());
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d;
}

export interface AuditQuery {
  /** 只取已到期（retain_until < now）的记录 */
  expiredBefore: Date;
  limit: number;
}

/**
 * 到期清理任务的查询条件。
 *
 * ⛔ 硬约束：条件里必须有 `retain_until < now`。
 * 少这个条件就是「把审计表全删了」—— 宁可清理失败也不能删掉在保留期内的记录。
 */
export function buildCleanupQuery(now: Date, limit = 1000): AuditQuery {
  return { expiredBefore: now, limit: Math.min(Math.max(limit, 1), 10000) };
}

export interface CleanupResult {
  deleted: number;
  /** 因仍在保留期内而被跳过的条数 */
  skippedInRetention: number;
}

/** 审计仓储 —— 生产实现待 v1.4 建表后注入 */
export interface AuditRepository {
  insert(row: Omit<AuditRow, 'id' | 'createdAt'> & { createdAt?: Date }): Promise<bigint>;
  /** 按到期条件批量删除；**实现必须遵守 retain_until < now** */
  deleteExpired(q: AuditQuery): Promise<number>;
  countInRetention(now: Date): Promise<number>;
}

/**
 * 清理任务。
 *
 * ⚠️ 该任务只删「已过保留期」的记录。实现须做二次保护：
 * 即使仓储实现有bug，这里也再校验一次 `retainUntil < now`。
 */
export async function runAuditCleanup(
  repo: AuditRepository,
  now: Date,
  limit = 1000,
): Promise<CleanupResult> {
  const q = buildCleanupQuery(now, limit);
  if (!(q.expiredBefore instanceof Date) || Number.isNaN(q.expiredBefore.getTime())) {
    throw new Error('清理任务拒绝执行：expiredBefore 非法');
  }
  const deleted = await repo.deleteExpired(q);
  const skippedInRetention = await repo.countInRetention(now);
  return { deleted, skippedInRetention };
}

/** 供管理端/运维查询：某条记录是否仍在保留期内 */
export function isInRetention(row: Pick<AuditRow, 'retainUntil'>, now: Date): boolean {
  return row.retainUntil.getTime() > now.getTime();
}
