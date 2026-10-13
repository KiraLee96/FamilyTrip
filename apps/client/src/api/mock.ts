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
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  PresignUploadResult,
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

/**
 * 预置媒体资产（云南行程的 3 张照片）。
 * Mock 没有真实图片字节，界面渲染占位卡（本地路径由上传时即时补齐）。
 */
const MEDIA: MediaAsset[] = [
  {
    id: '601',
    familyId: '10',
    tripId: '103',
    ownerId: '1',
    fileKey: 'f/10/20260712-a1b2c3d4.jpg',
    url: '',
    mimeType: 'image/jpeg',
    byteSize: '2345678',
    compressed: true,
    exifStripped: true,
    hadGps: false,
    storageClass: 'STANDARD',
    width: 4032,
    height: 3024,
    createdAt: '2026-07-12T10:20:00.000Z',
    updatedAt: '2026-07-12T10:20:00.000Z',
  },
  {
    id: '602',
    familyId: '10',
    tripId: '103',
    ownerId: '1',
    fileKey: 'f/10/20260715-e5f6a7b8.jpg',
    url: '',
    mimeType: 'image/jpeg',
    byteSize: '1987654',
    compressed: true,
    exifStripped: true,
    hadGps: false,
    storageClass: 'STANDARD',
    width: 4032,
    height: 3024,
    createdAt: '2026-07-15T08:40:00.000Z',
    updatedAt: '2026-07-15T08:40:00.000Z',
  },
  {
    id: '603',
    familyId: '10',
    tripId: '103',
    ownerId: '1',
    fileKey: 'f/10/20260719-c9d0e1f2.jpg',
    url: '',
    mimeType: 'image/jpeg',
    byteSize: '2876543',
    compressed: true,
    exifStripped: true,
    hadGps: true,
    storageClass: 'STANDARD',
    width: 4032,
    height: 3024,
    createdAt: '2026-07-19T17:05:00.000Z',
    updatedAt: '2026-07-19T17:05:00.000Z',
  },
];

/** 预置的云南行程回忆快照（对应 MemoryArchive '901'） */
const TRIP_MEMORY_SNAPSHOT: MemorySnapshot = {
  schemaVersion: 1,
  type: 'TRIP',
  year: 2026,
  familyId: '10',
  trip: {
    id: '103',
    title: '暑假 · 云南亲子环线',
    status: 'FINISHED',
    startDate: '2026-07-10',
    endDate: '2026-07-20',
    timezone: 'Asia/Shanghai',
    memberCount: 4,
    memberNames: ['爸爸', '妈妈', '爷爷', '小珂'],
  },
  itinerary: [
    { date: '2026-07-10', title: '飞抵昆明，逛滇池', location: '昆明' },
    { date: '2026-07-12', title: '高铁到大理，环洱海', location: '大理' },
    { date: '2026-07-15', title: '丽江古城 + 束河', location: '丽江' },
    { date: '2026-07-18', title: '香格里拉普达措', location: '香格里拉' },
  ],
  expenseSummary: {
    currency: 'CNY',
    totalMinor: '860000',
    pendingRateCount: 0,
    byCategory: { 交通: '320000', 住宿: '310000', 门票: '150000', 餐饮: '80000' },
  },
  mediaCount: 3,
  generatedAt: '2026-07-25T20:00:00.000Z',
};

/** 回忆快照单独存放（列表项不回传快照，与后端 toListItem 同构） */
const MEMORY_SNAPSHOTS: Record<string, MemorySnapshot> = {
  '901': TRIP_MEMORY_SNAPSHOT,
};

const MEMORIES: MemoryArchive[] = [
  {
    id: '901',
    familyId: '10',
    year: 2026,
    type: 'TRIP',
    refId: '103',
    createdAt: '2026-07-25T20:00:00.000Z',
    summary: {
      tripTitle: '暑假 · 云南亲子环线',
      memberCount: 4,
      itineraryCount: 4,
      totalMinor: '860000',
      pendingRateCount: 0,
      mediaCount: 3,
    },
  },
];

/** 模拟网络延迟，让 loading 态真实可见 */
const delay = (ms = 180): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 统一按信封包装，保证与后端同形 */
async function respond<T>(data: T): Promise<T> {
  await delay();
  return unwrap({ code: 0, message: 'ok', data });
}

/** 可变的 Mock 状态（投票/勾选/上传改这里，刷新后重置） */
const state = {
  wishes: [...WISHES],
  checklist: [...CHECKLIST],
  media: [...MEDIA],
  memories: [...MEMORIES],
  memorySnapshots: { ...MEMORY_SNAPSHOTS },
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
    async createChecklistItem(input) {
      const item: ChecklistItem = {
        id: `c${Date.now().toString(36)}`,
        scope: input.scope ?? 'SHARED',
        title: input.name,
        done: false,
      };
      state.checklist.push(item);
      return respond(item);
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
    // ---- media ----
    async presignUpload(input) {
      // Mock 无对象存储：uploadUrl 置空即「跳过直传」（上传工具依此判断），
      // fileKey 仍按后端规则生成，保证 confirm 链路形状一致。
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(input.fileName)?.[0].toLowerCase() ?? '';
      const fileKey = `f/${FAMILY.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      return respond<PresignUploadResult>({ uploadUrl: '', expiresIn: 0, fileKey });
    },
    async confirmMediaAsset(input) {
      const asset: MediaAsset = {
        id: `m${Date.now().toString(36)}`,
        familyId: FAMILY.id,
        tripId: input.tripId ?? null,
        ownerId: ME.id,
        fileKey: input.fileKey,
        url: '',
        mimeType: input.mimeType,
        byteSize: String(input.byteSize),
        compressed: true,
        // Mock 不做真实 EXIF 处理，统一按已剥离登记（真后端以 stripExif 结果为准）
        exifStripped: true,
        hadGps: false,
        storageClass: 'STANDARD',
        width: input.width ?? null,
        height: input.height ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.media.unshift(asset);
      return respond(asset);
    },
    async listMedia(query) {
      let list = state.media;
      if (query?.tripId !== undefined) list = list.filter((m) => m.tripId === query.tripId);
      if (query?.mimePrefix !== undefined)
        list = list.filter((m) => m.mimeType.startsWith(query.mimePrefix!));
      return respond([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    },
    async deleteMediaAsset(id) {
      const i = state.media.findIndex((m) => m.id === id);
      if (i < 0) throw new ApiError(404, '资产不存在');
      state.media.splice(i, 1);
      await delay();
    },
    // ---- memory ----
    async listMemories(query) {
      let list = state.memories;
      if (query?.type !== undefined) list = list.filter((m) => m.type === query.type);
      if (query?.year !== undefined) list = list.filter((m) => m.year === query.year);
      // 年 desc + id desc，与后端排序口径一致
      return respond([...list].sort((a, b) => b.year - a.year || b.id.localeCompare(a.id)));
    },
    async getMemory(id) {
      const memory = state.memories.find((m) => m.id === id);
      if (!memory) throw new ApiError(404, '回忆不存在');
      const snapshot = state.memorySnapshots[id];
      if (!snapshot) throw new ApiError(404, '回忆快照不存在');
      return respond({ memory, snapshot });
    },
    async generateTripMemory(tripId) {
      const trip = TRIPS.find((t) => t.id === tripId);
      if (!trip) throw new ApiError(404, '出行不存在');
      const year =
        Number((trip.endDate ?? trip.startDate ?? '').slice(0, 4)) || new Date().getFullYear();

      // 幂等：同年 TRIP 回忆已存在 → 直接返回既有快照，不覆盖
      const existing = state.memories.find((m) => m.type === 'TRIP' && m.year === year);
      if (existing) {
        const snapshot = state.memorySnapshots[existing.id];
        if (!snapshot) throw new ApiError(500, '回忆快照缺失');
        return respond({ memory: existing, snapshot, created: false });
      }

      const itinerary = ITINERARY.filter((i) => i.tripId === tripId);
      const expenses = EXPENSES.filter((e) => e.tripId === tripId);
      const totalMinor = expenses
        .reduce((sum, e) => sum + Math.round(Number(e.amountCny ?? e.amount) * 100), 0)
        .toString();
      const snapshot: MemorySnapshot = {
        schemaVersion: 1,
        type: 'TRIP',
        year,
        familyId: trip.familyId,
        trip: {
          id: trip.id,
          title: trip.title,
          status: trip.status,
          startDate: trip.startDate ?? null,
          endDate: trip.endDate ?? null,
          timezone: trip.timezone ?? 'Asia/Shanghai',
          memberCount: 4,
          memberNames: ['爸爸', '妈妈', '爷爷', '小珂'],
        },
        itinerary: itinerary.map((i) => ({
          date: i.date,
          title: i.title,
          location: i.location ?? null,
        })),
        expenseSummary: {
          currency: 'CNY',
          totalMinor,
          pendingRateCount: 0,
          byCategory: {},
        },
        mediaCount: state.media.filter((m) => m.tripId === tripId).length,
        generatedAt: new Date().toISOString(),
      };
      const memory: MemoryArchive = {
        id: `r${Date.now().toString(36)}`,
        familyId: trip.familyId,
        year,
        type: 'TRIP',
        refId: tripId,
        createdAt: snapshot.generatedAt,
        summary: {
          tripTitle: snapshot.trip?.title ?? null,
          memberCount: snapshot.trip?.memberCount ?? null,
          itineraryCount: snapshot.itinerary?.length ?? 0,
          totalMinor,
          pendingRateCount: 0,
          mediaCount: snapshot.mediaCount ?? 0,
        },
      };
      state.memories.unshift(memory);
      state.memorySnapshots[memory.id] = snapshot;
      return respond({ memory, snapshot, created: true });
    },
    async generateAnnualMemory(year) {
      const existing = state.memories.find((m) => m.type === 'ANNUAL' && m.year === year);
      if (existing) {
        const snapshot = state.memorySnapshots[existing.id];
        if (!snapshot) throw new ApiError(500, '回忆快照缺失');
        return respond({ memory: existing, snapshot, created: false });
      }
      const trips = TRIPS.filter(
        (t) => t.familyId === FAMILY.id && (t.startDate ?? '').startsWith(String(year)),
      );
      const expenses = EXPENSES.filter((e) => e.spentAt.startsWith(String(year)));
      const totalMinor = expenses
        .reduce((sum, e) => sum + Math.round(Number(e.amountCny ?? e.amount) * 100), 0)
        .toString();
      const snapshot: MemorySnapshot = {
        schemaVersion: 1,
        type: 'ANNUAL',
        year,
        familyId: FAMILY.id,
        itinerary: trips.map((t) => ({
          date: t.startDate ?? null,
          title: t.title,
          location: t.destinations?.[0]?.name ?? null,
        })),
        expenseSummary: { currency: 'CNY', totalMinor, pendingRateCount: 0, byCategory: {} },
        mediaCount: state.media.length,
        generatedAt: new Date().toISOString(),
      };
      const memory: MemoryArchive = {
        id: `r${Date.now().toString(36)}`,
        familyId: FAMILY.id,
        year,
        type: 'ANNUAL',
        refId: null,
        createdAt: snapshot.generatedAt,
        summary: {
          tripTitle: null,
          memberCount: null,
          itineraryCount: snapshot.itinerary?.length ?? 0,
          totalMinor,
          pendingRateCount: 0,
          mediaCount: snapshot.mediaCount ?? 0,
        },
      };
      state.memories.unshift(memory);
      state.memorySnapshots[memory.id] = snapshot;
      return respond({ memory, snapshot, created: true });
    },
  };
}
