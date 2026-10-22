/**
 * 业务常量 —— 多页面共用的枚举标签与默认种子
 * ============================================================================
 * M-Client-2：把「交通方式文案」「物品分类」「新建行程默认清单」三处收敛到这里，
 * 避免在页面里散落魔法字符串（切换后端/改文案只需动一处）。
 */

import type { TransportMode } from '../api/types';

/** 交通方式中文标签（行程卡片 / 地图连线图例共用） */
export const TRANSPORT_LABEL: Record<TransportMode, string> = {
  WALK: '步行',
  BIKE: '骑行',
  CAR: '自驾',
  BUS: '公交 / 大巴',
  TRAIN: '火车 / 高铁',
  FLIGHT: '飞机',
};

/** 交通方式选项顺序（表单下拉/胶囊选择器用） */
export const TRANSPORT_MODES: TransportMode[] = ['WALK', 'BIKE', 'CAR', 'BUS', 'TRAIN', 'FLIGHT'];

/** 个人物品库分类（物品页分组与筛选用） */
export const ITEM_CATEGORIES = [
  '证件',
  '电子',
  '衣物',
  '洗护',
  '药品',
  '食品',
  '母婴',
  '其他',
] as const;

export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** 记账分类（花销页按类目汇总与筛选） */
export const EXPENSE_CATEGORIES = ['交通', '住宿', '餐饮', '门票', '购物', '其他'] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * 邀请接口未就绪时的友好提示
 * ============================================================================
 * 后端 trip 域目前没有 `/trips/:id/invite` 三个端点，dispatcher 未命中路由时统一回
 * `{ code: 4040, message: '资源不存在' }`（见 common/middleware/dispatcher.ts 的
 * notFoundResult）。直接把「资源不存在」抛给用户，会被理解成「这场行程没了」——
 * 这里按错误码/文案分流成人话，避免误判（派发单 D-2026-10-22-01）。
 */
export function inviteUnavailableHint(message: string): string {
  if (message.includes('4040') || message.includes('资源不存在')) {
    return '后端邀请接口尚未上线，邀请码暂时生成不了（行程本身正常，邀请码上线后自动可用）';
  }
  return message;
}

/** 今日 YYYY-MM-DD（记账/安排的默认日期） */
export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 含头含尾天数（与 components/shared.tsx 的 tripDays 同理，此处独立以免依赖 UI 层） */
export function tripNights(startDate?: string | null, endDate?: string | null): number {
  if (!startDate || !endDate) return 0;
  const a = Date.parse(`${startDate}T00:00:00Z`);
  const b = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export interface DefaultChecklistSeed {
  title: string;
  scope: 'SHARED' | 'PERSONAL';
}

/**
 * 新建行程后自动播种的默认清单项（反馈 #5：清单不能默认沿用上一个行程）。
 * 覆盖「往返票 → 住宿 → 证件 → 充电」四件每次出行都绕不开的事。
 * 住宿项按行程天数算出实际晚数（无日期时为通用文案）。
 */
export function defaultChecklistFor(
  startDate?: string | null,
  endDate?: string | null,
): DefaultChecklistSeed[] {
  const nights = tripNights(startDate, endDate);
  return [
    { title: '预订往返机票 / 车票', scope: 'SHARED' },
    { title: nights > 0 ? `预订住宿（${nights} 晚）` : '预订住宿', scope: 'SHARED' },
    { title: '整理证件（身份证 / 护照）', scope: 'PERSONAL' },
    { title: '充电设备（充电宝 + 数据线）', scope: 'PERSONAL' },
  ];
}
