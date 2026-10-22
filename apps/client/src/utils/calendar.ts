/**
 * 日期区间计算 —— 纯函数层（不依赖 Taro，可在 Node 里单测）
 * ============================================================================
 * 从 `components/Calendar.tsx` 里抽出来的原因：区间选择的**语义**（点第二下算终点、
 * 点早了算重开、单日怎么算）是业务规则，写死在视图里就只能靠手点验证。
 * 抽成纯函数后 `src/utils/__tests__/calendar.test.ts` 可以直接断言这些边界。
 *
 * 口径：全部按 `YYYY-MM-DD` 字面量运算，不经本地时区换算（避免跨时区偏移一天）。
 */

/** 两位补零 */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 组合 YYYY-MM-DD（纯字面量拼接，不做时区换算） */
export const ymd = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** 解析 YYYY-MM-DD；非法返回 null（不抛，调用方决定兜底） */
export function parseYmd(s: string | undefined): Ymd | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 某月天数（m 为 1-12） */
export function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

/** 该月 1 号在「周一开头」的网格里排第几格（0 = 周一，6 = 周日） */
export function firstWeekdayIndex(y: number, m: number): number {
  const w = new Date(y, m - 1, 1).getDay(); // 0 = 周日
  return (w + 6) % 7;
}

/** 含头含尾的天数（同一天 = 1） */
export function inclusiveDays(a: string, b: string): number {
  const pa = parseYmd(a);
  const pb = parseYmd(b);
  if (!pa || !pb) return 1;
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((tb - ta) / 86_400_000) + 1;
}

/** 今日 YYYY-MM-DD（本地时区） */
export function todayYmd(): string {
  const d = new Date();
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 相对今天偏移 n 天 */
export function offsetYmd(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** 本周末（周六 ~ 周日）；今天就是周日则取当天 */
export function thisWeekend(): { start: string; end: string } {
  const d = new Date();
  const dow = d.getDay(); // 0 = 周日
  const toSat = (6 - dow + 7) % 7;
  const start = offsetYmd(dow === 0 ? 0 : toSat);
  const end = dow === 0 ? start : offsetYmd(toSat + 1);
  return { start, end };
}

/**
 * 区间摘要文案（表单行 / 面板顶部共用）
 * 只有起点时显示单日，不让用户误以为「已经选了区间」。
 */
export function rangeText(start: string, end: string): string {
  if (start === '' && end === '') return '';
  if (start !== '' && end !== '') return `${start} → ${end} · ${inclusiveDays(start, end)} 天`;
  return start || end;
}

export interface RangeSelection {
  start: string;
  end: string;
}

/**
 * 两次点选的区间语义（本次修复的核心规则，被线上反馈反复问到）：
 *
 * | 当前状态         | 点击的一天     | 结果                     |
 * | ---------------- | -------------- | ------------------------ |
 * | 无起点           | 任意           | 设为起点，终点清空       |
 * | 有起点、无终点   | 晚于起点       | 设为终点（区间成立）     |
 * | 有起点、无终点   | 等于起点       | 保持单日（终点留空）     |
 * | 有起点、无终点   | 早于起点       | **以该天为新起点重开**   |
 * | 区间已成立       | 任意           | 以该天为新起点重开       |
 *
 * 「点早了就重开」而不是弹错：日历上误点前一格是高频操作，报错会打断选期节奏。
 */
export function nextRangeSelection(selStart: string, selEnd: string, ds: string): RangeSelection {
  const settled = selStart !== '' && selEnd !== '';
  if (settled) return { start: ds, end: '' };
  if (selStart === '') return { start: ds, end: '' };
  if (ds > selStart) return { start: selStart, end: ds };
  if (ds === selStart) return { start: selStart, end: '' };
  return { start: ds, end: '' };
}

/** 月历网格单元（前置空格为 null，行数补齐到整周，至少 5 行） */
export function buildMonthCells(y: number, m: number): Array<{ day: number; ds: string } | null> {
  const total = daysInMonth(y, m);
  const lead = firstWeekdayIndex(y, m);
  const list: Array<{ day: number; ds: string } | null> = [];
  for (let i = 0; i < lead; i += 1) list.push(null);
  for (let d = 1; d <= total; d += 1) list.push({ day: d, ds: ymd(y, m, d) });
  while (list.length % 7 !== 0) list.push(null);
  while (list.length < 35) list.push(null);
  return list;
}
