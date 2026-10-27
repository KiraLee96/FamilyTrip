/**
 * 中国法定节假日 + 调休字典（纯数据 + 纯函数，不依赖 Taro，可在 Node 里单测）
 * ============================================================================
 * 数据来源：国务院办公厅《关于 2026 年部分节假日安排的通知》
 *           国办发明电〔2025〕7 号（2025-11-04 发布）
 *           https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * 为什么内置而不查后端 `/holidays`：
 *   · 小程序每次打开日历都发一次网络请求，只为标几个字，不划算；
 *   · 后端 `holiday` 表目前是空字典（没有种子数据），线上查也是空数组；
 *   · 法定节假日一年只变一次，属于**编译期常量**，内置最稳、离线可用。
 *   后端字典（含家庭自定义假）留给「提醒排期 / 工作日估算」这类需要覆盖场景，
 *   日历展示用内置表即可 —— 两者不冲突。
 *
 * 🔴 维护方式（一年一次，5 分钟）：
 *   国办通常在**前一年 11 月**发布次年通知 → 在 `HOLIDAYS` / `MAKEUP_WORKDAYS`
 *   各加一个年份块即可，无需改任何逻辑。缺年份时不会报错，只是不标假期标记
 *   （退化成「只按周一到周五区分工作日」），所以**忘了更新也不会坏**。
 *
 * 🔴 口径（与后端 holiday 域一致）：
 *   · 放假期间（含被包含进来的周六日）→ HOLIDAY，显示「休」
 *   · 调休补班的周末             → MAKEUP，显示「班」
 *   · 其余日子不标记（普通周末不标，避免整屏花花绿绿）
 */

/** 某一天的假期属性 */
export type DayKind = 'HOLIDAY' | 'MAKEUP';

export interface DayMark {
  kind: DayKind;
  /** 节日名（调休日写「补班」，不猜它属于哪个节） */
  name: string;
}

/** 一段连续假期：[from, to] 含头含尾，YYYY-MM-DD */
interface HolidayRange {
  name: string;
  from: string;
  to: string;
}

/** 按年份的放假区间 */
const HOLIDAYS: Record<number, HolidayRange[]> = {
  2026: [
    { name: '元旦', from: '2026-01-01', to: '2026-01-03' },
    { name: '春节', from: '2026-02-15', to: '2026-02-23' },
    { name: '清明节', from: '2026-04-04', to: '2026-04-06' },
    { name: '劳动节', from: '2026-05-01', to: '2026-05-05' },
    { name: '端午节', from: '2026-06-19', to: '2026-06-21' },
    { name: '中秋节', from: '2026-09-25', to: '2026-09-27' },
    { name: '国庆节', from: '2026-10-01', to: '2026-10-07' },
  ],
};

/** 按年份的调休补班日（周末上班） */
const MAKEUP_WORKDAYS: Record<number, string[]> = {
  // 元旦后补班 1/4；春节前后补班 2/14、2/28；劳动节后补班 5/9；国庆前后补班 9/20、10/10
  2026: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
};

/** 展开成「日期 → 标记」的查找表（首次访问时构建一次） */
const MARK_TABLE: Map<string, DayMark> = (() => {
  const map = new Map<string, DayMark>();
  for (const ranges of Object.values(HOLIDAYS)) {
    for (const r of ranges) {
      for (const ds of eachDay(r.from, r.to)) {
        map.set(ds, { kind: 'HOLIDAY', name: r.name });
      }
    }
  }
  for (const days of Object.values(MAKEUP_WORKDAYS)) {
    for (const ds of days) map.set(ds, { kind: 'MAKEUP', name: '补班' });
  }
  return map;
})();

/** 含头含尾逐日枚举（纯字面量运算，不经时区） */
function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.UTC(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10)),
  );
  const end = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
    );
  }
  return out;
}

/** 某天的假期标记；普通日子返回 null（没数据 / 不是假期 / 不是调休） */
export function dayMarkOf(ds: string): DayMark | null {
  return MARK_TABLE.get(ds) ?? null;
}

/** 该月包含的假期段（用于日历上方的一句「本月：国庆节 10/1–10/7」） */
export function holidayRangesOfMonth(
  y: number,
  m: number,
): Array<{ name: string; from: string; to: string }> {
  const prefix = `${y}-${String(m).padStart(2, '0')}`;
  return (HOLIDAYS[y] ?? []).filter((r) => r.from.startsWith(prefix) || r.to.startsWith(prefix));
}

/** 字典里有哪些年份（供测试与「数据到哪年」的提示用） */
export function knownHolidayYears(): number[] {
  return Object.keys(HOLIDAYS)
    .map(Number)
    .sort((a, b) => a - b);
}
