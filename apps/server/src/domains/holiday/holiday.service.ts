/**
 * holiday 域 · service
 * ============================================================================
 * 职责：节假日字典（含调休），供行程天数估算与提醒避让使用。
 *
 * 设计要点：
 *   · 这是**字典数据**，弱依赖 —— 无需权限判定（公开读）。
 *   · `is_workday` 表达的是「这天是否上班」：
 *       - 法定节假日（放假）   → isWorkday = false
 *       - 调休补班日（周末上班）→ isWorkday = true
 *     这样单一字段即可覆盖中国的「节假日 + 调休」双轨制。
 *   · `family_id` 允许为空 = 全国通用；非空 = 家庭自定义（如公司假）。
 *     查询时两者合并，家庭自定义**优先级更高**（可覆盖国家法定）。
 */

import { AppError, ErrorCode } from '../../common/errors/error-code.js';
import type { Row } from '../../common/db/table-client.js';
import { stringCell } from '../../common/db/row-key.js';
import type { DomainContext } from '../domain-context.js';

export interface HolidayServiceOptions {
  ctx: DomainContext;
}


export interface HolidayItem {
  name: string;
  date: string;
  isWorkday: boolean;
  /** 来源：NATIONAL=法定，FAMILY=家庭自定义 */
  source: 'NATIONAL' | 'FAMILY';
}

export class HolidayService {
  constructor(private readonly o: HolidayServiceOptions) {}

  /** 查某年节假日（含家庭自定义覆盖） */
  async list(
    userId: bigint,
    q: { country: string; year: number; from?: string; to?: string },
  ): Promise<{ year: number; country: string; items: HolidayItem[] }> {
    const familyIds = await this.visibleFamilyIds(userId);

    const all = await this.o.ctx.read.findMany('holiday', { where: { deletedAt: null } });
    const inRange = (d: string): boolean => {
      if (q.from !== undefined && d < q.from) return false;
      if (q.to !== undefined && d > q.to) return false;
      return true;
    };

    const toItem = (h: Row, source: HolidayItem['source']): HolidayItem => ({
      name: stringCell(h, 'name') ?? '',
      date: toYmd(h['date']),
      isWorkday: h['isWorkday'] === true,
      source,
    });

    // 国家法定（family_id 为空）
    const national = all
      .filter((h) => h['country'] === q.country && (h['familyId'] === null || h['familyId'] === undefined))
      .filter((h) => Number(h['year'] ?? q.year) === q.year || h['year'] === undefined)
      .filter((h) => inRange(toYmd(h['date'])))
      .map((h) => toItem(h, 'NATIONAL'));

    // 家庭自定义（覆盖同名日期）
    const familyRows = all
      .filter((h) => h['familyId'] !== null && h['familyId'] !== undefined)
      .filter((h) => familyIds.has(h['familyId'] as bigint))
      .filter((h) => inRange(toYmd(h['date'])))
      .map((h) => toItem(h, 'FAMILY'));

    const byDate = new Map<string, HolidayItem>();
    for (const it of national) byDate.set(it.date, it);
    for (const it of familyRows) byDate.set(it.date, it); // 家庭覆盖国家

    const items = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return { year: q.year, country: q.country, items };
  }

  /** 某天是否工作日 */
  async isWorkday(userId: bigint, q: { country: string; date: string }): Promise<{ date: string; isWorkday: boolean; name: string | null }> {
    const year = Number(q.date.slice(0, 4));
    const { items } = await this.list(userId, { country: q.country, year, from: q.date, to: q.date });
    const hit = items.find((i) => i.date === q.date);
    if (hit) return { date: q.date, isWorkday: hit.isWorkday, name: hit.name };

    // 字典里没有 → 按「周一至周五上班」兜底
    const dow = new Date(`${q.date}T00:00:00.000Z`).getUTCDay();
    return { date: q.date, isWorkday: dow >= 1 && dow <= 5, name: null };
  }

  /**
   * 两日期间工作日数（含首尾）。
   *
   * 用途：行程天数估算、提醒排期。一次性拉全区间字典，避免逐日查询。
   */
  async workdaysBetween(
    userId: bigint,
    q: { country: string; start: string; end: string },
  ): Promise<{ start: string; end: string; workdays: number; holidays: number; totalDays: number }> {
    if (q.start > q.end) throw new AppError(ErrorCode.VALIDATION_FAILED, '开始日期不能晚于结束日期');
    const y1 = Number(q.start.slice(0, 4));
    const y2 = Number(q.end.slice(0, 4));
    if (y2 - y1 > 5) throw new AppError(ErrorCode.VALIDATION_FAILED, '日期跨度不能超过 5 年');

    const items: HolidayItem[] = [];
    for (let y = y1; y <= y2; y += 1) {
      const r = await this.list(userId, { country: q.country, year: y, from: q.start, to: q.end });
      items.push(...r.items);
    }
    const dict = new Map(items.map((i) => [i.date, i.isWorkday]));

    let workdays = 0;
    let holidays = 0;
    let total = 0;
    for (let d = q.start; d <= q.end; d = addDays(d, 1)) {
      total += 1;
      const override = dict.get(d);
      if (override !== undefined) {
        if (override) workdays += 1;
        else holidays += 1;
        continue;
      }
      const dow = new Date(`${d}T00:00:00.000Z`).getUTCDay();
      if (dow >= 1 && dow <= 5) workdays += 1;
      else holidays += 1;
    }
    return { start: q.start, end: q.end, workdays, holidays, totalDays: total };
  }

  /**
   * 导入/覆盖节假日字典（内部运营接口）。
   *
   * 幂等：同 (country, year, date, familyId) 视为同一条 —— 覆盖而非新增。
   * 用软删 + 插入的方式实现「覆盖」，保留历史便于审计。
   */
  async upsert(
    userId: bigint,
    q: { familyId?: bigint; country: string; items: Array<{ name: string; date: string; isWorkday: boolean }> },
  ): Promise<{ inserted: number; replaced: number }> {
    if (q.familyId !== undefined) {
      await this.assertFamilyMember(userId, q.familyId);
    }
    return this.o.ctx.tx(async (tx) => {
      const now = await tx.db.dbNow();
      let inserted = 0;
      let replaced = 0;

      for (const item of q.items) {
        const year = Number(item.date.slice(0, 4));
        const existing = await tx.db.findMany('holiday', {
          where: {
            country: q.country,
            year,
            deletedAt: null,
            familyId: q.familyId ?? null,
          },
        });
        // 同日期已有 → 软删旧的（保留历史）
        for (const e of existing.filter((r) => toYmd(r['date']) === item.date)) {
          await tx.db.update('holiday', { id: e['id'] }, { deletedAt: now });
          replaced += 1;
        }

        await tx.db.insert('holiday', {
          id: tx.write.nextId(),
          country: q.country,
          name: item.name,
          date: new Date(`${item.date}T00:00:00.000Z`),
          isWorkday: item.isWorkday,
          year,
          familyId: q.familyId ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        });
        inserted += 1;
      }

      return { inserted, replaced };
    });
  }

  // ── 内部 ────────────────────────────────────────────────

  private async visibleFamilyIds(userId: bigint): Promise<Set<bigint>> {
    const mine = await this.o.ctx.read.findMany('familyMember', { where: { userId, deletedAt: null } });
    const s = new Set<bigint>();
    for (const m of mine) s.add(m['familyId'] as bigint);
    return s;
  }

  private async assertFamilyMember(userId: bigint, familyId: bigint): Promise<void> {
    const m = await this.o.ctx.read.findUnique('familyMember', { familyId, userId, deletedAt: null });
    if (!m) throw new AppError(ErrorCode.NOT_FOUND, '资源不存在');
  }
}

function toYmd(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
