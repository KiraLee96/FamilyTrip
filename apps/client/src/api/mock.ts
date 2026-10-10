/**
 * Mock API 实现 —— 原型阶段的数据来源
 * ============================================================================
 * 数据形状严格对齐后端契约（字段名/枚举值取自 apps/server 各域 schema）。
 * 时间用固定值而非 new Date()，保证每次打开界面一致，方便比对设计稿。
 */

import { ApiError, unwrap, type ApiClient } from './client';
import type {
  ChecklistItem,
  Expense,
  ExpenseSummary,
  Family,
  ItineraryItem,
  Trip,
  User,
  Wish,
} from './types';

const ME: User = { id: '1', nickname: '小珂', avatarUrl: undefined, homeTimezone: 'Asia/Shanghai' };

const FAMILY: Family = { id: '10', name: '我们一家', ownerUserId: '1', memberCount: 4 };

const TRIPS: Trip[] = [
  {
    id: '101',
    familyId: '10',
    title: '国庆 · 青岛看海',
    status: 'PLANNED',
    startDate: '2026-10-01',
    endDate: '2026-10-05',
    timezone: 'Asia/Shanghai',
    destinations: [
      { name: '青岛', note: '栈桥 / 八大关' },
      { name: '崂山', note: '一日游' },
    ],
    version: 3,
  },
  {
    id: '102',
    familyId: '10',
    title: '春节 · 回老家',
    status: 'DRAFT',
    startDate: '2027-02-14',
    endDate: '2027-02-20',
    timezone: 'Asia/Shanghai',
    destinations: [{ name: '西安' }],
    version: 1,
  },
  {
    id: '103',
    familyId: '10',
    title: '暑假 · 云南亲子环线',
    status: 'FINISHED',
    startDate: '2026-07-10',
    endDate: '2026-07-20',
    timezone: 'Asia/Shanghai',
    destinations: [{ name: '大理' }, { name: '丽江' }, { name: '香格里拉' }],
    version: 7,
  },
];

const WISHES: Wish[] = [
  {
    id: '201',
    familyId: '10',
    title: '带孩子赶海捡贝壳',
    note: '退潮时去，提前查潮汐表',
    votes: 4,
    votedByMe: true,
    status: 'OPEN',
    tags: ['亲子', '海边'],
  },
  {
    id: '202',
    familyId: '10',
    title: '住一次海景民宿',
    note: '要能看日出的朝向',
    votes: 3,
    votedByMe: false,
    status: 'OPEN',
    tags: ['住宿'],
  },
  {
    id: '203',
    familyId: '10',
    title: '吃一顿现捞海鲜',
    votes: 2,
    votedByMe: true,
    status: 'OPEN',
    tags: ['美食'],
  },
  {
    id: '204',
    familyId: '10',
    title: '崂山看日出',
    note: '要早起，考虑住山下',
    votes: 1,
    votedByMe: false,
    status: 'OPEN',
    tags: ['自然'],
  },
  {
    id: '205',
    familyId: '10',
    title: '拍一张全家福',
    votes: 5,
    votedByMe: true,
    status: 'ADOPTED',
    tags: ['纪念'],
  },
];

const ITINERARY: ItineraryItem[] = [
  {
    id: '301',
    tripId: '101',
    date: '2026-10-01',
    startTime: '09:30',
    title: '高铁出发 → 青岛',
    location: '北京南站',
    note: 'G179 次，09:30 发车',
    sortOrder: 1,
  },
  {
    id: '302',
    tripId: '101',
    date: '2026-10-01',
    startTime: '15:00',
    title: '入住海景民宿',
    location: '栈桥附近',
    sortOrder: 2,
  },
  {
    id: '303',
    tripId: '101',
    date: '2026-10-02',
    startTime: '08:00',
    title: '栈桥 + 八大关',
    location: '市南区',
    note: '步行游览，穿舒适鞋',
    sortOrder: 1,
  },
  {
    id: '304',
    tripId: '101',
    date: '2026-10-02',
    startTime: '17:30',
    title: '赶海捡贝壳',
    location: '燕儿岛山公园',
    sortOrder: 2,
  },
  {
    id: '305',
    tripId: '101',
    date: '2026-10-03',
    startTime: '07:00',
    title: '崂山一日游',
    location: '崂山区',
    note: '带足水和防晒',
    sortOrder: 1,
  },
];

const CHECKLIST: ChecklistItem[] = [
  { id: '401', scope: 'SHARED', title: '预订往返高铁票', done: true },
  { id: '402', scope: 'SHARED', title: '订海景民宿（3 晚）', done: false, assigneeName: '爸爸' },
  { id: '403', scope: 'SHARED', title: '查潮汐表（赶海用）', done: false, assigneeName: '妈妈' },
  { id: '404', scope: 'PERSONAL', title: '给孩子准备晕车药', done: false },
  { id: '405', scope: 'PERSONAL', title: '充电宝 + 数据线', done: true },
  { id: '406', scope: 'SHARED', title: '崂山门票预约', done: false, assigneeName: '爸爸' },
];

const EXPENSES: Expense[] = [
  {
    id: '501',
    tripId: '101',
    title: '高铁往返票',
    amount: '2160.00',
    currency: 'CNY',
    amountCny: '2160.00',
    payerName: '爸爸',
    spentAt: '2026-09-20',
    category: '交通',
  },
  {
    id: '502',
    tripId: '101',
    title: '海景民宿 3 晚',
    amount: '1980.00',
    currency: 'CNY',
    amountCny: '1980.00',
    payerName: '妈妈',
    spentAt: '2026-09-22',
    category: '住宿',
  },
  {
    id: '503',
    tripId: '101',
    title: '崂山门票 ×4',
    amount: '480.00',
    currency: 'CNY',
    amountCny: '480.00',
    payerName: '爸爸',
    spentAt: '2026-09-25',
    category: '门票',
  },
  {
    id: '504',
    tripId: '101',
    title: '海鲜晚餐',
    amount: '368.00',
    currency: 'CNY',
    amountCny: '368.00',
    payerName: '爷爷',
    spentAt: '2026-10-02',
    category: '餐饮',
  },
];

const EXPENSE_SUMMARY: ExpenseSummary = {
  totalCny: '4988.00',
  byMember: [
    { memberName: '爸爸', amountCny: '2640.00' },
    { memberName: '妈妈', amountCny: '1980.00' },
    { memberName: '爷爷', amountCny: '368.00' },
  ],
  byCategory: [
    { category: '交通', amountCny: '2160.00' },
    { category: '住宿', amountCny: '1980.00' },
    { category: '门票', amountCny: '480.00' },
    { category: '餐饮', amountCny: '368.00' },
  ],
};

/** 模拟网络延迟，让 loading 态真实可见 */
const delay = (ms = 180): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 统一按信封包装，保证与后端同形 */
async function respond<T>(data: T): Promise<T> {
  await delay();
  return unwrap({ code: 0, message: 'ok', data });
}

/** 可变的 Mock 状态（投票/勾选改这里，刷新后重置） */
const state = {
  wishes: [...WISHES],
  checklist: [...CHECKLIST],
};

export function createMockClient(): ApiClient {
  return {
    async login() {
      return respond(ME);
    },
    async me() {
      return respond(ME);
    },
    async listFamilies() {
      return respond([FAMILY]);
    },
    async listTrips(familyId) {
      const list = familyId ? TRIPS.filter((t) => t.familyId === familyId) : TRIPS;
      return respond(list);
    },
    async getTrip(id) {
      const t = TRIPS.find((x) => x.id === id);
      if (!t) throw new ApiError(404, '出行不存在');
      return respond(t);
    },
    async createTrip(input) {
      const t: Trip = {
        id: String(1000 + Math.floor(Math.random() * 9000)),
        familyId: input.familyId,
        title: input.title,
        status: 'DRAFT',
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        destinations: [],
        version: 0,
      };
      TRIPS.push(t);
      return respond(t);
    },
    async listWishes(familyId) {
      const list = familyId ? state.wishes.filter((w) => w.familyId === familyId) : state.wishes;
      return respond(list);
    },
    async voteWish(id) {
      const w = state.wishes.find((x) => x.id === id);
      if (!w) throw new ApiError(404, '心愿不存在');
      w.votedByMe = !w.votedByMe;
      w.votes += w.votedByMe ? 1 : -1;
      return respond(w);
    },
    async listItineraries(tripId) {
      const list = ITINERARY.filter((i) => i.tripId === tripId).sort(
        (a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder,
      );
      return respond(list);
    },
    async listChecklist(scope) {
      const list = scope ? state.checklist.filter((c) => c.scope === scope) : state.checklist;
      return respond(list);
    },
    async toggleChecklistItem(id) {
      const c = state.checklist.find((x) => x.id === id);
      if (!c) throw new ApiError(404, '清单项不存在');
      c.done = !c.done;
      return respond(c);
    },
    async listExpenses(tripId) {
      return respond(EXPENSES.filter((e) => e.tripId === tripId));
    },
    async expenseSummary() {
      return respond(EXPENSE_SUMMARY);
    },
  };
}
