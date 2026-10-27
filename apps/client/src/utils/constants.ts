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

/**
 * 长期清单「改条目 / 删整套」端点未上线时的友好提示（派发单 P0-1 / P0-2）。
 * ============================================================================
 * 后端 checklist 域目前只有 templates 的 建 / 列 / 套用 三个端点，
 * PATCH / DELETE 未命中路由时 dispatcher 统一回 `4040 资源不存在`。
 * 直接把这句抛给用户会被理解成「这套清单没了」——按错误码分流成人话。
 */
export function templateWriteUnavailableHint(message: string): string {
  if (message.includes('4040') || message.includes('资源不存在') || message.includes('(code 404')) {
    return '清单内容的修改需要配套后端接口，接口上线后这里就能改（新建与引用到行程现在可用）';
  }
  return message;
}

/**
 * 归档行程的照片写被服务端拒绝时的人话提示（派发单 D-2026-10-26-02 P0-2）。
 * ============================================================================
 * 服务端 `media.service` 的两道门（assertTripActiveWritable / assertTripMemberWritable）
 * 都认 HISTORICAL_READONLY，所以行程归档后**加/删照片都会 403「该出行已归档，仅可查看」**。
 * 用户的要求正相反：「已完成的行程……只能添加或删除回忆照片」。
 * 前端不藏按钮（藏了用户就以为功能不存在），而是把 403 翻成「需要后端放开」，
 * 后端一放开，这里自然走成功分支，前端无需再改。
 */
export function photoWriteHint(message: string, action: 'upload' | 'delete' = 'upload'): string {
  if (message.includes('已归档') || message.includes('(code 403')) {
    return action === 'upload'
      ? '这场行程已归档：照片可以查看，但新增照片需要后端放开归档写权限（已提交派发单 P0-2）'
      : '这场行程已归档：删除照片需要后端放开归档写权限（已提交派发单 P0-2）';
  }
  return message;
}

/**
 * 「后端还没部署」的统一判定与文案（2026-10-27）
 * ============================================================================
 * 背景：客户端与后端版本不同步时，旧后端有三种**假装成功**的姿势，都会让用户
 * 以为功能坏了而不是以为没上线：
 *   ① 新路由不存在        → `4040 资源不存在`（回忆墙的照片聚合就是这条）
 *   ② 新字段被 Zod strip  → 200 OK，但值没写进去（预算、清单 kind）
 *   ③ 新字段压根没读      → 返回体里没有该字段（同上）
 *
 * 这张表就是「把静默失效翻译成人话」的唯一出处，各调用点不要各写一份。
 * 撤销条件：后端按 docs/交付说明-2026-10-27-五条反馈.md §6 部署完成后，本函数
 * 不会被触发（条件不再成立），可以保留 —— 它防的是下一次版本错位。
 */
export function backendOutdatedHint(feature: string): string {
  return `后端还没升级（${feature}）。请先部署：prisma migrate deploy → pnpm build → 重启 API`;
}

/** 是不是「后端缺这个能力」类错误（4040 = 路由/资源不存在） */
export function isBackendOutdated(message: string | undefined): boolean {
  return message !== undefined && /code 4040/.test(message);
}

/** 今日 YYYY-MM-DD（记账/安排的默认日期） */
export function todayYmd(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 行程是否「已经走完」——**派生**判断，不改库。
 * ============================================================================
 * 口径（三选一即算结束）：
 *   1. status 已经是 FINISHED / CANCELLED（服务端已流转）；
 *   2. 结束日期早于今天（到期但服务端还没流转）。
 *
 * 🔴 为什么前端也要派生一次：用户反馈「行程的时间结束后要自动变成已完成」。
 *    服务端目前**没有**定时/惰性流转（见派发单 P0-1），所以到期后 status 仍停在
 *    PLANNED，界面上看起来「一直没结束」。前端先按日期派生，保证界面正确；
 *    真正的状态落库仍由后端负责，前端不伪造写权限（撤销条件：后端补上自动流转，
 *    本函数退化为「只读 status」的快路径，调用方无需改动）。
 */
export function tripIsEnded(t: { status: string; endDate?: string | null }): boolean {
  if (t.status === 'FINISHED' || t.status === 'CANCELLED') return true;
  if (t.endDate === undefined || t.endDate === null || t.endDate === '') return false;
  // 字符串比较即可：两边都是 YYYY-MM-DD，字典序 == 时间序
  return t.endDate < todayYmd();
}

/**
 * 展示用状态：过期未流转的行程显示为「已完成」。
 * 只影响展示，不参与任何写权限判断 —— 写权限一律以服务端返回的 status /
 * accessLevel 为准，避免出现「界面说不能改、请求却成功」的不一致。
 */
export function tripDisplayStatus<T extends string>(t: {
  status: T;
  endDate?: string | null;
}): T | 'FINISHED' {
  const open = t.status === 'PLANNED' || t.status === 'ONGOING' || t.status === 'DRAFT';
  if (open && tripIsEnded(t)) return 'FINISHED';
  return t.status;
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
