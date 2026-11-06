/**
 * Mock API 实现 —— 原型阶段的数据来源
 * ============================================================================
 * 数据形状严格对齐后端契约（字段名/枚举值取自 apps/server 各域 schema）。
 * 时间用固定值而非 new Date()，保证每次打开界面一致，方便比对设计稿。
 *
 * M-Client-2 起，可变状态从「只有投票/勾选/上传」扩展为全域：
 *   families / members / trips / itinerary / checklist / expenses / items
 * 均可在会话内增删改；itinerary / item 更新走 E7 CAS（version 不匹配 → 409），
 * expenseSummary 由当前 expenses 动态重算（不再是写死的汇总常量）。
 */

import { ApiError, unwrap, type ApiClient } from './client';
import type {
  ApplyTemplateResult,
  BatchExpenseResult,
  ChecklistItem,
  ChecklistTemplate,
  TemplateSyncResult,
  Expense,
  ExpenseSummary,
  Family,
  FamilyDetail,
  FamilyMember,
  FxRate,
  ItineraryBlock,
  ItineraryItem,
  Item,
  JoinFamilyResult,
  JoinTripResult,
  MediaAsset,
  MemoryArchive,
  MemorySnapshot,
  PhotoMemoryGroup,
  PresignUploadResult,
  Trip,
  TripDetail,
  TripInvite,
  TripMember,
  TripUpdateInput,
  User,
  Wish,
} from './types';

/**
 * 当前登录用户（Mock 可变状态：updateMe 改昵称/头像后需整体换引用，
 * 让 useSyncExternalStore 的快照比较能观察到变化——原地改对象会被
 * Object.is 判为未变而跳过重渲染）。
 */
let ME: User = { id: '1', nickname: '小珂', avatarUrl: undefined, homeTimezone: 'Asia/Shanghai' };

const FAMILY: Family = {
  id: '10',
  name: '我们一家',
  ownerUserId: '1',
  memberCount: 4,
  // 建家庭时后端自动生成的 8 位邀请码（去易混字符字母表）
  inviteCode: 'QM2K7X9W',
};

/** 家庭成员种子（爸爸=户主；妈妈/爷爷/宝宝为无微信账号的虚拟成员） */
const MEMBERS: FamilyMember[] = [
  {
    id: '7001',
    familyId: '10',
    userId: '1',
    role: 'OWNER',
    isVirtual: false,
    managedBy: null,
    displayName: '爸爸',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '7002',
    familyId: '10',
    userId: null,
    role: 'MEMBER',
    isVirtual: true,
    managedBy: '7001',
    displayName: '妈妈',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '7003',
    familyId: '10',
    userId: null,
    role: 'MEMBER',
    isVirtual: true,
    managedBy: '7001',
    displayName: '爷爷',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: '7004',
    familyId: '10',
    userId: null,
    role: 'MEMBER',
    isVirtual: true,
    managedBy: '7001',
    displayName: '小珂',
    joinedAt: '2026-01-01T00:00:00.000Z',
  },
];

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
    // 2026-10-27：预算 ¥5000（最小单位「分」）。102/103 故意不设预算，
    // 用来看「未设预算」与「已设预算」两种形态。
    budgetMinor: '500000',
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

/** 出行成员种子（对齐后端 tripMember 行：create 时创建者自动为 LEADER） */
const TRIP_MEMBERS: TripMember[] = [
  {
    id: '9001',
    tripId: '101',
    userId: '1',
    role: 'LEADER',
    isExternal: false,
    accessLevel: 'ACTIVE',
    displayName: '爸爸',
    managedBy: null,
    joinedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: '9002',
    tripId: '101',
    userId: null,
    role: 'MEMBER',
    isExternal: false,
    accessLevel: 'ACTIVE',
    displayName: '妈妈',
    managedBy: '7001',
    joinedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    id: '9003',
    tripId: '101',
    userId: null,
    role: 'MEMBER',
    isExternal: false,
    accessLevel: 'ACTIVE',
    displayName: '爷爷',
    managedBy: '7001',
    joinedAt: '2026-09-01T00:00:00.000Z',
  },
  {
    // 已结束的出行：成员转 HISTORICAL_READONLY（B6 历史只读保留）
    id: '9004',
    tripId: '103',
    userId: '1',
    role: 'LEADER',
    isExternal: false,
    accessLevel: 'HISTORICAL_READONLY',
    displayName: '爸爸',
    managedBy: null,
    joinedAt: '2026-07-10T00:00:00.000Z',
  },
];

/** 行程邀请码种子（与家庭邀请码同规则：8 位、去易混字符） */
const TRIP_INVITES: TripInvite[] = [
  { tripId: '101', inviteCode: 'TRIP7QM2', updatedAt: '2026-09-01T00:00:00.000Z' },
  { tripId: '103', inviteCode: 'TRIP4KX9', updatedAt: '2026-07-10T00:00:00.000Z' },
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

/**
 * 行程安排种子（青岛行程，带地图坐标与交通方式 —— 供地图标记/连线演示）。
 * 坐标取各地点大致位置（精度到演示足够，真后端由 chooseLocation 回传）。
 *
 * blocks 为 v2 富文本/图片正文（对齐 2026-10-14 参考截图的混排形态）：
 * 引用块（灰底多行）+ 代码块（逐字核对的车次/地址）+ 链接块 + 图片块。
 */
const ITINERARY: ItineraryItem[] = [
  {
    id: '301',
    tripId: '101',
    date: '2026-10-01',
    startTime: '09:30',
    endTime: '13:10',
    title: '高铁出发 → 青岛',
    location: '北京南站',
    note: 'G179 次，09:30 发车',
    blocks: [
      {
        type: 'code',
        text: 'G179 次 · 北京南 09:30 → 青岛 13:10\n检票口 G13-G15，提前 30 分钟进站',
      },
      { type: 'quote', text: '出发前 1 小时到站即可；带好身份证，儿童票需走人工通道核验。' },
      { type: 'link', text: '铁路 12306 行程详情', url: 'https://www.12306.cn/index/' },
    ],
    sortOrder: 1,
    version: 1,
    lat: 39.865,
    lng: 116.378,
    transport: 'TRAIN',
  },
  {
    id: '302',
    tripId: '101',
    date: '2026-10-01',
    startTime: '15:00',
    endTime: '16:00',
    title: '入住海景民宿',
    location: '栈桥附近',
    blocks: [
      {
        type: 'code',
        text: '青岛栈桥海景民宿\n市南区太平路 12 号 3 单元 801\n入住 15:00 后 · 退房 12:00 前',
      },
      { type: 'quote', text: '行李可先寄存前台；出示本文即可办理，无需打印凭证。' },
      { type: 'image', assetId: '505', caption: '民宿周边步行路线' },
    ],
    sortOrder: 2,
    version: 1,
    lat: 36.057,
    lng: 120.316,
    transport: 'CAR',
  },
  {
    id: '303',
    tripId: '101',
    date: '2026-10-02',
    startTime: '08:00',
    endTime: '11:30',
    title: '栈桥 + 八大关',
    location: '市南区',
    note: '步行游览，穿舒适鞋',
    blocks: [
      { type: 'text', text: '栈桥看海鸥 → 沿太平路步行至八大关，全程约 4 公里。' },
      { type: 'quote', text: '八大关部分院落周一闭馆，想进花石楼记得提前看开放时间。' },
    ],
    sortOrder: 1,
    version: 1,
    lat: 36.058,
    lng: 120.317,
    transport: 'WALK',
  },
  {
    id: '304',
    tripId: '101',
    date: '2026-10-02',
    startTime: '17:30',
    endTime: '19:00',
    title: '赶海捡贝壳',
    location: '燕儿岛山公园',
    sortOrder: 2,
    version: 1,
    lat: 36.055,
    lng: 120.412,
    transport: 'BUS',
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
    version: 1,
    lat: 36.12,
    lng: 120.6,
    transport: 'CAR',
  },
];

/** 清单种子（归属行程 101 —— 修复「清单默认是之前一个」的跨行程串数据问题） */
/**
 * 行程清单种子 —— 2026-10-27 起按 kind 分两类（需求③）：
 *   TODO = 要做的事（订票 / 订房 / 预约）
 *   PACK = 要带的东西（药 / 充电宝）
 * 演示数据两类都有，才能看出"两个进度条各算各的"。
 */
const CHECKLIST: ChecklistItem[] = [
  { id: '401', tripId: '101', scope: 'SHARED', title: '预订往返高铁票', done: true, kind: 'TODO' },
  {
    id: '402',
    tripId: '101',
    scope: 'SHARED',
    title: '订海景民宿（3 晚）',
    done: false,
    assigneeName: '爸爸',
    kind: 'TODO',
  },
  {
    id: '403',
    tripId: '101',
    scope: 'SHARED',
    title: '查潮汐表（赶海用）',
    done: false,
    assigneeName: '妈妈',
    kind: 'TODO',
  },
  {
    id: '404',
    tripId: '101',
    scope: 'PERSONAL',
    title: '给孩子准备晕车药',
    done: false,
    kind: 'PACK',
  },
  {
    id: '405',
    tripId: '101',
    scope: 'PERSONAL',
    title: '充电宝 + 数据线',
    done: true,
    kind: 'PACK',
  },
  {
    id: '406',
    tripId: '101',
    scope: 'SHARED',
    title: '崂山门票预约',
    done: false,
    assigneeName: '爸爸',
    kind: 'TODO',
  },
];

/**
 * 长期清单种子（模板）—— 与后端 checklistTemplate 同形。
 * ============================================================================
 * scope 决定域：SHARED = 家庭共享（familyId 有值，ownerId 为空）；
 * PERSONAL = 我的私人清单（ownerId = 本人，家庭成员互相看不见）。
 * 条目只有 name/quantity，与 createTemplateSchema.items 的口径一致。
 */
const TEMPLATES: ChecklistTemplate[] = [
  {
    id: '501',
    familyId: '10',
    scope: 'SHARED',
    ownerId: null,
    name: '家庭出行常用',
    version: 1,
    updatedAt: '2026-10-01T00:00:00.000Z',
    items: [
      { name: '身份证（全家 4 人）', quantity: 4, category: '证件' },
      { name: '充电宝 + 数据线', quantity: 2, category: '电子' },
      { name: '常备药（晕车 / 感冒 / 腹泻）', quantity: 1, category: '药品' },
      { name: '雨伞 / 一次性雨衣', quantity: 2, category: '其他' },
      { name: '纸巾 + 湿巾', quantity: 2, category: '洗护' },
      { name: '水杯（儿童保温杯）', quantity: 2, category: '母婴' },
    ],
  },
  {
    id: '502',
    familyId: '10',
    scope: 'SHARED',
    ownerId: null,
    name: '海边赶海专项',
    version: 1,
    updatedAt: '2026-09-20T00:00:00.000Z',
    items: [
      { name: '防晒霜 SPF50+', quantity: 1, category: '洗护' },
      { name: '赶海小桶 + 铲子', quantity: 2, category: '其他' },
      { name: '凉拖 / 溯溪鞋', quantity: 4, category: '衣物' },
      { name: '防水手机袋', quantity: 2, category: '电子' },
    ],
  },
  {
    id: '503',
    familyId: '10',
    scope: 'PERSONAL',
    ownerId: '1',
    name: '我的随身清单',
    version: 1,
    updatedAt: '2026-10-05T00:00:00.000Z',
    items: [
      { name: '常用药（个人处方药）', quantity: 1, category: '药品' },
      { name: '隐形眼镜 + 护理液', quantity: 1, category: '洗护' },
      { name: 'kindle', quantity: 1, category: '电子' },
      { name: '耳机', quantity: 1, category: '电子' },
    ],
  },
];

/** 个人物品库种子（PRIVATE 域；分类整理 + 必带物品用 category/note 承载） */
const ITEMS: Item[] = [
  {
    id: '801',
    familyId: '10',
    name: '身份证（全家 4 人）',
    category: '证件',
    quantity: 4,
    note: '每次出行必带，出发前一晚再确认',
    version: 1,
  },
  {
    id: '802',
    familyId: '10',
    name: '充电宝 + 数据线',
    category: '电子',
    quantity: 2,
    version: 1,
  },
  {
    id: '803',
    familyId: '10',
    name: '常备药（晕车 / 感冒 / 腹泻）',
    category: '药品',
    quantity: 1,
    note: '孩子晕车药必带',
    version: 1,
  },
  {
    id: '804',
    familyId: '10',
    name: '防晒霜 + 墨镜',
    category: '洗护',
    quantity: 2,
    version: 1,
  },
  {
    id: '805',
    familyId: '10',
    name: '孩子安抚玩具',
    category: '母婴',
    quantity: 1,
    version: 1,
  },
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
    note: '退潮后现捞，味道不错',
  },
];

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
  {
    // 青岛行程（101）里被「入住海景民宿」的图片块引用的资产。
    // Mock 无真实字节 → url 空串，卡片按占位图 + 图注降级；
    // 走真实上传路径进来的图会用本会话本地路径即时渲染（见 ItineraryContent）。
    id: '505',
    familyId: '10',
    tripId: '101',
    ownerId: '1',
    fileKey: 'f/10/20260928-7a1b2c3d.jpg',
    url: '',
    mimeType: 'image/jpeg',
    byteSize: '1245678',
    compressed: true,
    exifStripped: true,
    hadGps: false,
    storageClass: 'STANDARD',
    width: 1080,
    height: 1920,
    createdAt: '2026-09-28T09:12:00.000Z',
    updatedAt: '2026-09-28T09:12:00.000Z',
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

/**
 * Mock 汇率表（1 CNY = X 外币），2026-10 的近似值。
 *
 * 只服务界面预览；真实数据一律走 `GET /fx/rate`。
 * 非 CNY 基准用交叉汇率现算：rate(base→quote) = (CNY→quote) ÷ (CNY→base)。
 * 🔴 别把这里的数字当真实汇率 —— 它们连中间价都不是，纯为了让界面有数可渲染。
 */
const MOCK_FX_CNY_BASE: Record<string, string> = {
  CNY: '1',
  JPY: '20.85000000',
  USD: '0.14020000',
  EUR: '0.12840000',
  GBP: '0.10960000',
  HKD: '1.09100000',
  KRW: '195.30000000',
  THB: '4.62000000',
  SGD: '0.18530000',
  AUD: '0.21400000',
  TWD: '4.48000000',
  MYR: '0.62900000',
};

/** 交叉汇率；币种不在表内返回 undefined（由调用方决定怎么降级） */
function mockRateOf(base: string, quote: string): string | undefined {
  if (base === quote) return '1';
  const toQuote = MOCK_FX_CNY_BASE[quote];
  const toBase = MOCK_FX_CNY_BASE[base];
  if (toQuote === undefined || toBase === undefined) return undefined;
  const v = Number(toQuote) / Number(toBase);
  return Number.isFinite(v) && v > 0 ? v.toFixed(8) : undefined;
}

/** 模拟网络延迟，让 loading 态真实可见 */
const delay = (ms = 180): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 统一按信封包装，保证与后端同形 */
async function respond<T>(data: T): Promise<T> {
  await delay();
  return unwrap({ code: 0, message: 'ok', data });
}

/** 各域自增 id 计数器（初值 = 种子最大 id，保证新 id 不与种子碰撞） */
const seq = {
  family: 10,
  member: 7004,
  trip: 103,
  tripMember: 9004,
  wish: 205,
  itinerary: 305,
  checklist: 406,
  template: 503,
  expense: 504,
  item: 805,
  media: 603,
  memory: 901,
};

function nextId(key: keyof typeof seq): string {
  seq[key] += 1;
  return String(seq[key]);
}

/** 8 位邀请码（去易混字符：0/O、1/I/L 不入库） */
function genInviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (state.families.some((f) => f.inviteCode === code));
  return code;
}

/** 行程邀请码：同一字母表，唯一性在行程域内校验 */
function genTripInviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  } while (state.tripInvites.some((t) => t.inviteCode === code));
  return code;
}

/** 今日日期 YYYY-MM-DD（本地时区） */
function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 金额汇总（分两组：按垫付人 / 按分类；未分类归「未分类」） */
function summarizeExpenses(list: Expense[]): ExpenseSummary {
  const byMember = new Map<string, number>();
  const byCategory = new Map<string, number>();
  let total = 0;
  for (const e of list) {
    const v = Number(e.amountCny ?? e.amount);
    total += v;
    byMember.set(e.payerName, (byMember.get(e.payerName) ?? 0) + v);
    const cat = e.category ?? '未分类';
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + v);
  }
  const fmt = (n: number): string => n.toFixed(2);
  return {
    totalCny: fmt(total),
    byMember: [...byMember].map(([memberName, v]) => ({ memberName, amountCny: fmt(v) })),
    byCategory: [...byCategory].map(([category, v]) => ({ category, amountCny: fmt(v) })),
  };
}

/** 可变的 Mock 状态（全域增删改 + 投票/勾选/上传均改这里，刷新后重置） */
const state = {
  families: [{ ...FAMILY }],
  members: [...MEMBERS],
  trips: [...TRIPS],
  tripMembers: [...TRIP_MEMBERS],
  tripInvites: [...TRIP_INVITES],
  wishes: [...WISHES],
  itinerary: [...ITINERARY],
  checklist: [...CHECKLIST],
  templates: [...TEMPLATES],
  expenses: [...EXPENSES],
  items: [...ITEMS],
  media: [...MEDIA],
  memories: [...MEMORIES],
  memorySnapshots: { ...MEMORY_SNAPSHOTS },
};

/**
 * 回填图片块的 url（服务端方案 A 的 Mock 等价实现）。
 * ============================================================================
 * 真后端在读接口里把 image 块的 assetId 解析成可访问 URL；Mock 没有对象存储，
 * 只能查内存 media 表：命中且 url 非空则回填，命中但 url 为空（Mock 均为空）
 * 则保留空串交由界面降级成占位卡 + 图注。**绝不自造 URL**，避免 Mock 行为
 * 与真后端不一致（界面在两种模式下走的都是同一条「url 为空 → 占位」分支）。
 * 引用不存在的 assetId（越权/已删）同样降级，不抛错、不破卡。
 */
function withResolvedBlocks(item: ItineraryItem): ItineraryItem {
  if (item.blocks === undefined || item.blocks.length === 0) return item;
  const blocks: ItineraryBlock[] = item.blocks.map((b) => {
    if (b.type !== 'image') return b;
    if (b.assetId === undefined) return b;
    const asset = state.media.find((m) => m.id === b.assetId);
    return asset !== undefined && asset.url !== '' ? { ...b, url: asset.url } : { ...b, url: '' };
  });
  return { ...item, blocks };
}

/**
 * 给行程行补 `memberCount`（本趟同行人数）。
 * 与后端 `trip.service` 的 list/detail 同口径：`tripMember` 里未删行数。
 * 🔴 注意不是 `family.memberCount` —— 家庭 4 人、本趟只去 3 人时两者不同，
 *    列表显示错数字就是从这里来的。
 */
function withMemberCount(t: Trip): Trip {
  return { ...t, memberCount: state.tripMembers.filter((m) => m.tripId === t.id).length };
}

export function createMockClient(): ApiClient {
  return {
    async login() {
      return respond(ME);
    },
    async me() {
      return respond(ME);
    },
    async updateMe(input) {
      // 与后端 updateProfile 同口径：仅更新传入字段；整体换引用（见 ME 注释）
      ME = {
        ...ME,
        ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
      };
      return respond(ME);
    },
    // ---- family ----
    async listFamilies() {
      return respond([...state.families]);
    },
    async getFamily(id) {
      const family = state.families.find((f) => f.id === id);
      if (!family) throw new ApiError(404, '家庭不存在');
      const detail: FamilyDetail = {
        family,
        members: state.members.filter((m) => m.familyId === id),
      };
      return respond(detail);
    },
    async createFamily(input) {
      const family: Family = {
        id: nextId('family'),
        name: input.name,
        ownerUserId: ME.id,
        memberCount: 1,
        inviteCode: genInviteCode(),
      };
      state.families.push(family);
      // 创建者自动成为户主（与后端 createFamily 同行为）
      state.members.push({
        id: nextId('member'),
        familyId: family.id,
        userId: ME.id,
        role: 'OWNER',
        isVirtual: false,
        managedBy: null,
        displayName: ME.nickname,
        joinedAt: new Date().toISOString(),
      });
      return respond(family);
    },
    async updateFamily(id, input) {
      const family = state.families.find((f) => f.id === id);
      if (!family) throw new ApiError(404, '家庭不存在');
      // timezone 客户端模型不承载（后端存储）；Mock 只改 name
      if (input.name !== undefined) family.name = input.name;
      return respond(family);
    },
    async dissolveFamily(id) {
      const i = state.families.findIndex((f) => f.id === id);
      if (i < 0) throw new ApiError(404, '家庭不存在');
      state.families.splice(i, 1);
      for (let j = state.members.length - 1; j >= 0; j--) {
        if (state.members[j]!.familyId === id) state.members.splice(j, 1);
      }
      await delay();
    },
    async joinFamily(input) {
      const family = state.families.find((f) => f.inviteCode === input.inviteCode);
      if (!family) throw new ApiError(404, '邀请码无效，请核对后重试');
      // 幂等：已是成员直接返回，不重复插入
      const mine = state.members.find((m) => m.familyId === family.id && m.userId === ME.id);
      if (mine) {
        const dup: JoinFamilyResult = { family, alreadyMember: true };
        return respond(dup);
      }
      const member: FamilyMember = {
        id: nextId('member'),
        familyId: family.id,
        userId: ME.id,
        role: 'MEMBER',
        isVirtual: false,
        managedBy: null,
        displayName: input.displayName ?? ME.nickname,
        joinedAt: new Date().toISOString(),
      };
      state.members.push(member);
      family.memberCount += 1;
      const result: JoinFamilyResult = { family, alreadyMember: false };
      return respond(result);
    },
    async addFamilyMember(familyId, input) {
      const family = state.families.find((f) => f.id === familyId);
      if (!family) throw new ApiError(404, '家庭不存在');
      const isVirtual = input.isVirtual ?? true;
      const owner = state.members.find((m) => m.familyId === familyId && m.role === 'OWNER');
      const memberId = nextId('member');
      const member: FamilyMember = {
        id: memberId,
        familyId,
        // Mock 无法真实注册微信账号：非虚拟成员用占位 userId（真后端走 openid 绑定）
        userId: isVirtual ? null : `wx_${memberId}`,
        role: 'MEMBER',
        isVirtual,
        // 虚拟成员必须有所属代管人（户主）；真实成员为 null
        managedBy: isVirtual ? (owner?.id ?? null) : null,
        displayName: input.displayName,
        joinedAt: new Date().toISOString(),
      };
      state.members.push(member);
      family.memberCount += 1;
      return respond(member);
    },
    async removeFamilyMember(memberId) {
      const i = state.members.findIndex((m) => m.id === memberId);
      if (i < 0) throw new ApiError(404, '成员不存在');
      const [removed] = state.members.splice(i, 1);
      const family = state.families.find((f) => f.id === removed!.familyId);
      if (family) family.memberCount = Math.max(1, family.memberCount - 1);
      await delay();
    },
    // ---- trip ----
    async listTrips(familyId) {
      const list = familyId ? state.trips.filter((t) => t.familyId === familyId) : state.trips;
      // 与后端同口径：列表带 memberCount（本趟人数，不是家庭人数）
      return respond(list.map((t) => withMemberCount(t)));
    },
    async getTrip(id) {
      const t = state.trips.find((x) => x.id === id);
      if (!t) throw new ApiError(404, '出行不存在');
      return respond(withMemberCount(t));
    },
    async getTripDetail(id) {
      const t = state.trips.find((x) => x.id === id);
      if (!t) throw new ApiError(404, '出行不存在');
      const members = state.tripMembers.filter((m) => m.tripId === id);
      const mine = members.find((m) => m.userId === ME.id);
      const detail: TripDetail = {
        trip: t,
        members,
        myRole: mine?.role ?? null,
        myAccessLevel: mine?.accessLevel ?? null,
      };
      return respond(detail);
    },
    async createTrip(input) {
      const t: Trip = {
        id: nextId('trip'),
        familyId: input.familyId,
        title: input.title,
        status: 'DRAFT',
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        destinations: input.destinations ?? [],
        // 2026-10-27 需求③：预算随创建一起写；不传 = 未设预算（null），不是 0
        ...(input.budgetMinor !== undefined ? { budgetMinor: input.budgetMinor } : {}),
        version: 1,
      };
      state.trips.push(t);
      // 与后端 create 同行为：创建者自动成为 LEADER 成员 + 生成行程邀请码
      state.tripMembers.push({
        id: nextId('tripMember'),
        tripId: t.id,
        userId: ME.id,
        role: 'LEADER',
        isExternal: false,
        accessLevel: 'ACTIVE',
        displayName: ME.nickname,
        managedBy: null,
        joinedAt: new Date().toISOString(),
      });
      state.tripInvites.push({
        tripId: t.id,
        inviteCode: genTripInviteCode(),
        updatedAt: new Date().toISOString(),
      });
      return respond(t);
    },
    /**
     * PATCH /trips/:id —— 改标题 / 起止日期 / 目的地（E7 CAS）。
     * 与后端 updateTrip 同口径：
     *   · version 必需且必须等于当前值，否则 409（界面提示刷新重试）；
     *   · startDate/endDate 传 null 表示清空；destinations 整体替换；
     *   · 改完 version +1，返回更新后的完整行程。
     */
    async updateTrip(id, input: TripUpdateInput) {
      const t = state.trips.find((x) => x.id === id);
      if (!t) throw new ApiError(404, '出行不存在');
      if (t.version !== input.version) throw new ApiError(409, '版本冲突，请刷新后重试');
      if (input.title !== undefined) t.title = input.title;
      if (input.startDate !== undefined) t.startDate = input.startDate;
      if (input.endDate !== undefined) t.endDate = input.endDate;
      if (input.destinations !== undefined) t.destinations = input.destinations;
      // 预算：null = 取消预算；undefined = 不改（与后端 patch 同口径）
      if (input.budgetMinor !== undefined) t.budgetMinor = input.budgetMinor;
      t.version += 1;
      await delay();
      return respond({ ...t });
    },
    /**
     * DELETE /trips/:id —— 删除整场行程。
     * 后端为软删 + 关联数据（成员/邀请码）一并失效；Mock 直接摘除并清理
     * 该行程的成员与邀请码，保证列表/详情/加入链路不留下悬挂引用。
     */
    async deleteTrip(id) {
      const i = state.trips.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '出行不存在');
      state.trips.splice(i, 1);
      state.tripMembers = state.tripMembers.filter((m) => m.tripId !== id);
      state.tripInvites = state.tripInvites.filter((v) => v.tripId !== id);
      state.itinerary = state.itinerary.filter((it) => it.tripId !== id);
      await delay();
    },
    async finishTrip(id, version) {
      const t = state.trips.find((x) => x.id === id);
      if (!t) throw new ApiError(404, '出行不存在');
      // 与后端 finish 同口径：CAS + 全员转历史只读
      if (t.version !== version) {
        throw new ApiError(409, '行程已被他人修改，请刷新后重试');
      }
      t.status = 'FINISHED';
      t.version += 1;
      for (const m of state.tripMembers) {
        if (m.tripId === id) m.accessLevel = 'HISTORICAL_READONLY';
      }
      return respond(t);
    },
    async addTripMember(tripId, input) {
      const trip = state.trips.find((t) => t.id === tripId);
      if (!trip) throw new ApiError(404, '出行不存在');
      // 与后端同规则：未传 userId 即虚拟成员；虚拟成员必须带 displayName
      const isVirtual = (input.isVirtual ?? false) || input.userId === undefined;
      if (isVirtual && !input.displayName) {
        throw new ApiError(400, '虚拟成员必须提供 displayName');
      }
      if (!isVirtual && input.userId !== undefined) {
        const dup = state.tripMembers.find((m) => m.tripId === tripId && m.userId === input.userId);
        if (dup) throw new ApiError(409, '该用户已在出行中');
      }
      const member: TripMember = {
        id: nextId('tripMember'),
        tripId,
        userId: isVirtual ? null : (input.userId ?? null),
        role: 'MEMBER',
        isExternal: input.isExternal ?? false,
        accessLevel: input.accessLevel ?? 'ACTIVE',
        displayName: input.displayName ?? '同行者',
        managedBy: isVirtual ? (input.managedBy ?? null) : null,
        joinedAt: new Date().toISOString(),
      };
      state.tripMembers.push(member);
      return respond(member);
    },
    async updateTripMember(id, input) {
      const m = state.tripMembers.find((x) => x.id === id);
      if (!m) throw new ApiError(404, '成员不存在');
      if (input.role !== undefined) m.role = input.role;
      if (input.accessLevel !== undefined) m.accessLevel = input.accessLevel;
      if (input.displayName !== undefined) m.displayName = input.displayName;
      if (input.managedBy !== undefined) m.managedBy = input.managedBy;
      return respond({ ...m });
    },
    async removeTripMember(id) {
      const i = state.tripMembers.findIndex((m) => m.id === id);
      if (i < 0) throw new ApiError(404, '成员不存在');
      state.tripMembers.splice(i, 1);
      await delay();
    },
    async getTripInvite(tripId) {
      // 建行程时已生成；兜底按需补发（与后端「没有则生成」语义一致）
      let inv = state.tripInvites.find((x) => x.tripId === tripId);
      if (!inv) {
        inv = {
          tripId,
          inviteCode: genTripInviteCode(),
          updatedAt: new Date().toISOString(),
        };
        state.tripInvites.push(inv);
      }
      return respond({ ...inv });
    },
    async resetTripInvite(tripId) {
      let inv = state.tripInvites.find((x) => x.tripId === tripId);
      if (!inv) {
        inv = {
          tripId,
          inviteCode: genTripInviteCode(),
          updatedAt: new Date().toISOString(),
        };
        state.tripInvites.push(inv);
      } else {
        // 重置即作废旧码（后端唯一索引约束由 gen 内校验保证）
        inv.inviteCode = genTripInviteCode();
        inv.updatedAt = new Date().toISOString();
      }
      return respond({ ...inv });
    },
    async joinTrip(input) {
      const inv = state.tripInvites.find((x) => x.inviteCode === input.inviteCode);
      if (!inv) throw new ApiError(404, '邀请码无效，请核对后重试');
      const trip = state.trips.find((t) => t.id === inv.tripId);
      if (!trip) throw new ApiError(404, '出行不存在');
      // GRP-08：已结束/取消的出行不再接受加入（历史记录对既有成员只读保留）
      if (trip.status === 'FINISHED' || trip.status === 'CANCELLED') {
        throw new ApiError(409, '该出行已结束，无法加入');
      }
      // 幂等：已是成员直接返回，不重复插入
      const mine = state.tripMembers.find((m) => m.tripId === trip.id && m.userId === ME.id);
      if (mine) {
        const dup: JoinTripResult = { trip, member: mine, alreadyMember: true };
        return respond(dup);
      }
      const member: TripMember = {
        id: nextId('tripMember'),
        tripId: trip.id,
        userId: ME.id,
        role: 'MEMBER',
        // 外部同行者：不属本家庭，仅可访问该次出行（PRD §2.6）
        isExternal: true,
        accessLevel: 'ACTIVE',
        displayName: input.displayName ?? ME.nickname,
        managedBy: null,
        joinedAt: new Date().toISOString(),
      };
      state.tripMembers.push(member);
      const result: JoinTripResult = { trip, member, alreadyMember: false };
      return respond(result);
    },
    async listWishes(familyId) {
      const list = familyId ? state.wishes.filter((w) => w.familyId === familyId) : state.wishes;
      return respond(list);
    },
    /**
     * POST /wishes —— 提心愿（与后端 createWish 同口径）
     * 新心愿默认 status=OPEN / votes=0 / 未投票；tags 不参与写入（服务端无该字段），
     * 客户端只做展示兜底，不在 Mock 里凭空造标签。
     */
    async createWish(input) {
      const w: Wish = {
        id: nextId('wish'),
        familyId: input.familyId,
        ...(input.tripId !== undefined ? { tripId: input.tripId } : {}),
        title: input.title,
        ...(input.description !== undefined && input.description !== ''
          ? { note: input.description }
          : {}),
        votes: 0,
        votedByMe: false,
        status: 'OPEN',
      };
      // 新提的排最前：用户可以立刻看到自己刚写的那条（列表按创建倒序更符合预期）
      state.wishes.unshift(w);
      return respond(w);
    },
    async voteWish(id) {
      const w = state.wishes.find((x) => x.id === id);
      if (!w) throw new ApiError(404, '心愿不存在');
      w.votedByMe = !w.votedByMe;
      w.votes += w.votedByMe ? 1 : -1;
      // 与真后端同契约：只回计票结果（http 适配层把 voteCount 映射成 votes）
      return respond({ votes: w.votes, votedByMe: w.votedByMe });
    },
    // ---- itinerary ----
    async listItineraries(tripId) {
      const list = state.itinerary
        .filter((i) => i.tripId === tripId)
        .sort((a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder);
      return respond(list.map((i) => withResolvedBlocks(i)));
    },
    async createItineraryItem(input) {
      // startAt 为本地时间 YYYY-MM-DDTHH:mm → 拆出 date/startTime（与后端落库口径一致）
      const sameDay = state.itinerary.filter(
        (i) => i.tripId === input.tripId && i.date === input.startAt.slice(0, 10),
      );
      const item: ItineraryItem = {
        id: nextId('itinerary'),
        tripId: input.tripId,
        date: input.startAt.slice(0, 10),
        ...(input.startAt.length >= 16 ? { startTime: input.startAt.slice(11, 16) } : {}),
        ...(input.endAt !== undefined && input.endAt.length >= 16
          ? { endTime: input.endAt.slice(11, 16) }
          : {}),
        title: input.title,
        ...(input.location !== undefined ? { location: input.location } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.blocks !== undefined && input.blocks.length > 0 ? { blocks: input.blocks } : {}),
        // 未显式指定 sort 时追加到当日末尾
        sortOrder: input.sort ?? sameDay.reduce((m, i) => Math.max(m, i.sortOrder), 0) + 1,
        version: 1,
        ...(input.lat !== undefined ? { lat: input.lat } : {}),
        ...(input.lng !== undefined ? { lng: input.lng } : {}),
        ...(input.transport !== undefined ? { transport: input.transport } : {}),
      };
      state.itinerary.push(item);
      return respond(withResolvedBlocks(item));
    },
    async updateItineraryItem(id, input) {
      const it = state.itinerary.find((x) => x.id === id);
      if (!it) throw new ApiError(404, '安排不存在');
      // E7 CAS：version 不匹配 → 409，界面提示刷新重试
      if (it.version !== input.version) throw new ApiError(409, '版本冲突，请刷新后重试');
      if (input.startAt !== undefined) {
        it.date = input.startAt.slice(0, 10);
        if (input.startAt.length >= 16) it.startTime = input.startAt.slice(11, 16);
      }
      // endAt：传空串/null 视为清除结束时间（与 location/note 同口径）
      if (input.endAt !== undefined) {
        it.endTime =
          input.endAt !== null && input.endAt.length >= 16 ? input.endAt.slice(11, 16) : undefined;
      }
      if (input.title !== undefined) it.title = input.title;
      if (input.location !== undefined) it.location = input.location ?? undefined;
      if (input.note !== undefined) it.note = input.note ?? undefined;
      // blocks 整体替换语义：传 [] 即清空正文块（与 destinations 同口径，不做增量合并）
      if (input.blocks !== undefined) {
        it.blocks = input.blocks.length > 0 ? input.blocks : undefined;
      }
      if (input.sort !== undefined) it.sortOrder = input.sort;
      if (input.lat !== undefined) it.lat = input.lat ?? undefined;
      if (input.lng !== undefined) it.lng = input.lng ?? undefined;
      if (input.transport !== undefined) it.transport = input.transport ?? undefined;
      it.version += 1;
      return respond(withResolvedBlocks(it));
    },
    async deleteItineraryItem(id) {
      const i = state.itinerary.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '安排不存在');
      state.itinerary.splice(i, 1);
      await delay();
    },
    // ---- checklist ----
    async listChecklist(scope) {
      const list = scope ? state.checklist.filter((c) => c.scope === scope) : state.checklist;
      return respond(list);
    },
    async createChecklistItem(input) {
      // tripId 必须落库：修复「清单默认是之前一个」的跨行程串数据问题
      const item: ChecklistItem = {
        id: nextId('checklist'),
        tripId: input.tripId,
        scope: input.scope ?? 'SHARED',
        title: input.name,
        done: false,
        // 2026-10-27 需求③：待办 / 打包分两类，缺省 PACK（与后端 schema 默认值一致）
        kind: input.kind ?? 'PACK',
      };
      state.checklist.push(item);
      return respond(item);
    },
    async toggleChecklistItem(id, checked) {
      const c = state.checklist.find((x) => x.id === id);
      if (!c) throw new ApiError(404, '清单项不存在');
      // checked 显式传入 → 置位（连点幂等）；不传 → 取反（老行为）
      c.done = checked ?? !c.done;
      // CAS 版本递增，与后端 toggle 的 version+1 一致
      c.version = (c.version ?? 0) + 1;
      return respond(c);
    },
    async listTripChecklist(tripId, scope) {
      const list = state.checklist.filter(
        (c) => c.tripId === tripId && (scope === undefined || c.scope === scope),
      );
      return respond(list);
    },
    async deleteChecklistItem(id) {
      const i = state.checklist.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '清单项不存在');
      state.checklist.splice(i, 1);
      await delay();
    },

    // ---- checklist 模板（长期清单）----
    async listChecklistTemplates(familyId) {
      // 与后端同口径：共享模板按家庭过滤，私有模板只回本人的
      const list = state.templates.filter((t) => {
        if (t.scope === 'PERSONAL') return t.ownerId === ME.id;
        return familyId === undefined || t.familyId === familyId || t.familyId === null;
      });
      return respond(list);
    },
    async createChecklistTemplate(input) {
      const tpl: ChecklistTemplate = {
        id: nextId('template'),
        familyId: input.familyId ?? null,
        scope: input.scope,
        // PERSONAL 必须落 ownerId（后端 refine 要求，缺省补当前用户）
        ownerId: input.scope === 'PERSONAL' ? (input.ownerId ?? ME.id) : null,
        name: input.name,
        items: input.items.map((it) => ({
          name: it.name,
          quantity: Math.max(1, it.quantity ?? 1),
        })),
        version: 0,
        updatedAt: new Date().toISOString(),
      };
      state.templates.push(tpl);
      return respond(tpl);
    },
    async updateChecklistTemplate(id, input) {
      const tpl = state.templates.find((x) => x.id === id);
      if (!tpl) throw new ApiError(404, '清单不存在');
      // CAS：与后端一致，版本不一致回 409 语义
      if (input.version !== tpl.version) {
        throw new ApiError(409, '该清单已被他人修改，请刷新后重试');
      }
      if (input.name !== undefined) tpl.name = input.name;

      /**
       * 条目同步（对齐后端 syncTemplateToOpenTrips 的口径）：
       * 改条目时把变更同步到「引用过它、且尚未成行」的行程清单项。
       * 已归档（FINISHED/CANCELLED）的行程不动 —— 历史快照。
       * Mock 也照这套走，否则界面在 Mock 下看不到同步提示，等于验收漏一半。
       *
       * ⚠️ Mock 只模拟「增/删」两个动作，不模拟「数量变更」：
       *    `ChecklistItem` 契约里没有 quantity（行程清单项不带数量），
       *    数量同步只存在于模板条目与后端的 trip_checklist_item 之间。
       */
      let synced: TemplateSyncResult | undefined;
      if (input.items !== undefined) {
        const next = input.items.map((it) => ({
          name: it.name,
          quantity: Math.max(1, it.quantity ?? 1),
        }));
        const result: TemplateSyncResult = {
          trips: 0,
          created: 0,
          updated: 0,
          removed: 0,
          keptChecked: 0,
        };
        const tplByName = new Map(next.map((it) => [it.name, it]));

        const openTripIds = [
          ...new Set(
            state.checklist
              .filter((c) => c.templateId === id)
              .map((c) => c.tripId)
              .filter((v): v is string => typeof v === 'string'),
          ),
        ];

        for (const tripId of openTripIds) {
          const trip = state.trips.find((t) => t.id === tripId);
          if (!trip) continue;
          if (trip.status === 'FINISHED' || trip.status === 'CANCELLED') continue;
          result.trips += 1;

          const live = state.checklist.filter((c) => c.tripId === tripId && c.templateId === id);
          const liveByName = new Map(live.map((c) => [c.title, c]));

          // ① 模板里没有的：未勾选删掉，已勾选保留
          for (const c of live) {
            if (tplByName.has(c.title)) continue;
            if (c.done) {
              result.keptChecked += 1;
              continue;
            }
            state.checklist = state.checklist.filter((x) => x.id !== c.id);
            result.removed += 1;
          }

          // ② 模板里有的：缺的补上
          for (const it of next) {
            if (liveByName.has(it.name)) continue;
            state.checklist.push({
              id: nextId('checklist'),
              tripId,
              scope: tpl.scope,
              title: it.name,
              done: false,
              version: 0,
              templateId: id,
            });
            result.created += 1;
          }
        }

        tpl.items = next;
        synced = result;
      }

      tpl.version += 1;
      tpl.updatedAt = new Date().toISOString();
      return respond({ template: tpl, ...(synced !== undefined ? { synced } : {}) });
    },
    async deleteChecklistTemplate(id) {
      const i = state.templates.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '清单不存在');
      state.templates.splice(i, 1);
      await delay();
    },
    async applyChecklistTemplate(input) {
      const tpl = state.templates.find((x) => x.id === input.templateId);
      if (!tpl) throw new ApiError(404, '清单不存在');
      const trip = state.trips.find((x) => x.id === input.tripId);
      if (!trip) throw new ApiError(404, '出行不存在');
      // 私有模板只能引用给自己（与后端 applyTemplate 的 404 同形策略一致）
      if (tpl.scope === 'PERSONAL' && tpl.ownerId !== ME.id) {
        throw new ApiError(404, '清单不存在');
      }

      // 幂等：同 (templateId, tripId) 已引用过就不重复插入
      const existing = state.checklist.filter(
        (c) => c.tripId === input.tripId && c.templateId === input.templateId,
      );
      if (existing.length > 0) {
        const dup: ApplyTemplateResult = {
          created: 0,
          skipped: existing.length,
          alreadyApplied: true,
        };
        return respond(dup);
      }

      for (const it of tpl.items) {
        // 与后端 applyTemplate 一致：模板一条 → 行程一条（数量落在 quantity，不拆行）
        state.checklist.push({
          id: nextId('checklist'),
          tripId: input.tripId,
          scope: tpl.scope,
          title: it.name,
          done: false,
          quantity: Math.max(1, it.quantity),
          version: 0,
          templateId: tpl.id,
        });
      }
      const result: ApplyTemplateResult = {
        created: tpl.items.length,
        skipped: 0,
        alreadyApplied: false,
      };
      return respond(result);
    },
    // ---- expense ----
    async listExpenses(tripId) {
      return respond(state.expenses.filter((e) => e.tripId === tripId));
    },
    async expenseSummary(tripId) {
      // 动态重算：增删花销后汇总即时跟随（不再是写死的常量）
      return respond(summarizeExpenses(state.expenses.filter((e) => e.tripId === tripId)));
    },
    async createExpense(input) {
      const e: Expense = {
        id: nextId('expense'),
        tripId: input.tripId,
        title: input.title,
        amount: input.amount,
        currency: input.currency ?? 'CNY',
        // Mock 不做汇率折算：amountCny 直接等同主币种金额（真后端走 fx 域）
        amountCny: input.amount,
        // 垫付人缺省 = 当前操作者（后端同口径）
        payerName: ME.nickname,
        spentAt: input.spentAt ?? today(),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      state.expenses.push(e);
      return respond(e);
    },
    async updateExpense(id, input) {
      const e = state.expenses.find((x) => x.id === id);
      if (!e) throw new ApiError(404, '花销不存在');
      if (input.title !== undefined) e.title = input.title;
      if (input.amount !== undefined) {
        e.amount = input.amount;
        if ((input.currency ?? e.currency) === 'CNY') e.amountCny = input.amount;
      }
      if (input.currency !== undefined) e.currency = input.currency;
      if (input.category !== undefined) e.category = input.category ?? undefined;
      if (input.spentAt !== undefined) e.spentAt = input.spentAt ?? today();
      if (input.note !== undefined) e.note = input.note ?? undefined;
      return respond(e);
    },
    async deleteExpense(id) {
      const i = state.expenses.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '花销不存在');
      state.expenses.splice(i, 1);
      await delay();
    },
    async createExpensesBatch(input, rows) {
      let created = 0;
      const errors: string[] = [];
      for (const row of rows) {
        // 与 http 实现同口径：逐行落库，失败行不阻塞其余行
        if (row.title.trim() === '' || !(Number(row.amount) > 0)) {
          if (errors.length < 5) errors.push(`${row.title || '(无名称)'}：金额或名称非法`);
          continue;
        }
        state.expenses.push({
          id: nextId('expense'),
          tripId: input.tripId,
          title: row.title.trim(),
          amount: row.amount,
          currency: row.currency ?? 'CNY',
          amountCny: row.amount,
          payerName: ME.nickname,
          spentAt: row.spentAt ?? today(),
          ...(row.category !== undefined ? { category: row.category } : {}),
          ...(row.note !== undefined ? { note: row.note } : {}),
        });
        created += 1;
      }
      const result: BatchExpenseResult = { created, failed: rows.length - created, errors };
      await delay();
      return result;
    },

    // ---- fx（汇率） ----
    async getFxRate(input) {
      if (input.tier !== undefined && input.tier !== 'SPOT_SELL') {
        throw new ApiError(400, `档位 ${input.tier} 本期未启用（唯一口径 SPOT_SELL）`);
      }
      const base = input.base.toUpperCase();
      const quote = input.quote.toUpperCase();
      const rate = mockRateOf(base, quote);
      if (rate === undefined) {
        // 对齐后端：缺汇率回 5006，界面据此提示「暂无汇率」，绝不 1:1 兜底
        throw new ApiError(5006, `汇率 ${base}→${quote} ${input.date} 缺失`);
      }
      return respond<FxRate>({
        base,
        quote,
        rate,
        rateDate: input.date,
        tier: 'SPOT_SELL',
        rateTime: new Date().toISOString(),
        source: 'MOCK',
        fromCache: false,
      });
    },
    // ---- item（个人物品库，PRIVATE 域） ----
    async listItems(query) {
      let list = state.items;
      if (query?.category !== undefined) list = list.filter((i) => i.category === query.category);
      // Mock 数据全部归属本人（PRIVATE 域无他人数据），mineOnly 真假结果一致
      return respond([...list]);
    },
    async createItem(input) {
      const item: Item = {
        id: nextId('item'),
        familyId: input.familyId,
        name: input.name,
        ...(input.category !== undefined ? { category: input.category } : {}),
        quantity: input.quantity ?? 1,
        ...(input.note !== undefined ? { note: input.note } : {}),
        version: 1,
      };
      state.items.push(item);
      return respond(item);
    },
    async updateItem(id, input) {
      const it = state.items.find((x) => x.id === id);
      if (!it) throw new ApiError(404, '物品不存在');
      // E7 CAS：version 不匹配 → 409
      if (it.version !== input.version) throw new ApiError(409, '版本冲突，请刷新后重试');
      if (input.name !== undefined) it.name = input.name;
      if (input.category !== undefined) it.category = input.category ?? undefined;
      if (input.quantity !== undefined) it.quantity = input.quantity;
      if (input.note !== undefined) it.note = input.note ?? undefined;
      it.version += 1;
      return respond(it);
    },
    async deleteItem(id) {
      const i = state.items.findIndex((x) => x.id === id);
      if (i < 0) throw new ApiError(404, '物品不存在');
      state.items.splice(i, 1);
      await delay();
    },
    // ---- media ----
    async presignUpload(input) {
      // Mock 无对象存储：uploadUrl 置空即「跳过直传」（上传工具依此判断），
      // fileKey 仍按后端规则生成，保证 confirm 链路形状一致。
      const ext = /\.[A-Za-z0-9]{1,8}$/.exec(input.fileName)?.[0].toLowerCase() ?? '';
      // AVATAR 用途走用户维度前缀（对齐派发单 D-2026-10-16-01 建议口径 a/<userId>/），
      // 与家庭媒体 f/<familyId>/ 区分——头像不是家庭照片，不进照片墙
      const prefix =
        input.purpose === 'AVATAR' ? `a/${ME.id}` : `f/${state.families[0]?.id ?? FAMILY.id}`;
      const fileKey = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
      return respond<PresignUploadResult>({ uploadUrl: '', expiresIn: 0, fileKey });
    },
    async confirmMediaAsset(input) {
      // AVATAR 用途不落家庭媒体池（头像是用户资产），返回一个轻量资产行供
      // 上传链路解链；url 恒为空串，界面按本地路径降级。
      // 2026-11-05：familyId 与真后端一致置 null（media_asset.family_id 已放宽可空）。
      if (input.purpose === 'AVATAR') {
        const avatarAsset: MediaAsset = {
          id: nextId('media'),
          familyId: null,
          tripId: null,
          ownerId: ME.id,
          fileKey: input.fileKey,
          url: '',
          mimeType: input.mimeType,
          byteSize: String(input.byteSize),
          compressed: true,
          exifStripped: true,
          hadGps: false,
          storageClass: 'STANDARD',
          width: input.width ?? null,
          height: input.height ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        return respond(avatarAsset);
      }
      const asset: MediaAsset = {
        id: nextId('media'),
        familyId: state.families[0]?.id ?? FAMILY.id,
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
    /**
     * 照片回忆聚合（对齐后端 /media/memories 口径）：
     * 有 tripId 的按行程成组、无 tripId 的按月份成组，按组内最新照片时间倒序。
     * **排除头像池**（fileKey 以 `a/` 开头），否则换过的头像会混进旅行回忆。
     */
    async listPhotoMemories(query) {
      const limit = query?.limit ?? 12;
      const previewSize = Math.min(9, query?.previewSize ?? 9);

      const images = state.media.filter(
        (m) => m.mimeType.startsWith('image/') && !m.fileKey.startsWith('a/'),
      );

      type Group = {
        kind: 'TRIP' | 'MONTH';
        tripId: string | null;
        month: string | null;
        rows: typeof images;
      };
      const groups = new Map<string, Group>();

      for (const m of images) {
        if (m.tripId !== null && m.tripId !== undefined) {
          const key = `T:${m.tripId}`;
          const g = groups.get(key) ?? {
            kind: 'TRIP' as const,
            tripId: m.tripId,
            month: null,
            rows: [],
          };
          g.rows.push(m);
          groups.set(key, g);
          continue;
        }
        const month = m.createdAt.slice(0, 7);
        const key = `M:${month}`;
        const g = groups.get(key) ?? { kind: 'MONTH' as const, tripId: null, month, rows: [] };
        g.rows.push(m);
        groups.set(key, g);
      }

      const out: PhotoMemoryGroup[] = [];
      for (const g of groups.values()) {
        const sorted = [...g.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const photos = sorted.slice(0, previewSize).map((m) => m.url);
        const lastAt = sorted[0]?.createdAt ?? '';

        if (g.kind === 'TRIP' && g.tripId !== null) {
          const trip = state.trips.find((t) => t.id === g.tripId);
          if (trip === undefined) continue;
          const range =
            trip.startDate !== undefined && trip.endDate !== undefined
              ? `${trip.startDate} ~ ${trip.endDate}`
              : `${sorted.length} 张照片`;
          out.push({
            kind: 'TRIP',
            tripId: g.tripId,
            month: null,
            title: trip.title,
            subtitle: range,
            cover: photos[0] ?? '',
            photoCount: sorted.length,
            photos,
            lastAt,
          });
          continue;
        }

        const month = g.month ?? '';
        const mm = /^(\d{4})-(\d{2})$/.exec(month);
        out.push({
          kind: 'MONTH',
          tripId: null,
          month,
          title: mm !== null ? `${mm[1]} 年 ${Number(mm[2])} 月` : '未分类照片',
          // 与后端同口径：张数由前端统一拼，这里留空避免「N 张照片 · N 张」
          subtitle: '',
          cover: photos[0] ?? '',
          photoCount: sorted.length,
          photos,
          lastAt,
        });
      }

      out.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
      await delay();
      return out.slice(0, limit);
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
      const trip = state.trips.find((t) => t.id === tripId);
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

      const itinerary = state.itinerary.filter((i) => i.tripId === tripId);
      const summary = summarizeExpenses(state.expenses.filter((e) => e.tripId === tripId));
      const totalMinor = String(Math.round(Number(summary.totalCny) * 100));
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
          memberCount: state.members.filter((m) => m.familyId === trip.familyId).length,
          memberNames: state.members
            .filter((m) => m.familyId === trip.familyId)
            .map((m) => m.displayName),
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
          byCategory: Object.fromEntries(
            summary.byCategory.map((c) => [
              c.category,
              String(Math.round(Number(c.amountCny) * 100)),
            ]),
          ),
        },
        mediaCount: state.media.filter((m) => m.tripId === tripId).length,
        generatedAt: new Date().toISOString(),
      };
      const memory: MemoryArchive = {
        id: nextId('memory'),
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
      const familyId = state.families[0]?.id ?? FAMILY.id;
      const trips = state.trips.filter(
        (t) => t.familyId === familyId && (t.startDate ?? '').startsWith(String(year)),
      );
      const summary = summarizeExpenses(
        state.expenses.filter((e) => e.spentAt.startsWith(String(year))),
      );
      const totalMinor = String(Math.round(Number(summary.totalCny) * 100));
      const snapshot: MemorySnapshot = {
        schemaVersion: 1,
        type: 'ANNUAL',
        year,
        familyId,
        itinerary: trips.map((t) => ({
          date: t.startDate ?? null,
          title: t.title,
          location: t.destinations?.[0]?.name ?? null,
        })),
        expenseSummary: {
          currency: 'CNY',
          totalMinor,
          pendingRateCount: 0,
          byCategory: Object.fromEntries(
            summary.byCategory.map((c) => [
              c.category,
              String(Math.round(Number(c.amountCny) * 100)),
            ]),
          ),
        },
        mediaCount: state.media.length,
        generatedAt: new Date().toISOString(),
      };
      const memory: MemoryArchive = {
        id: nextId('memory'),
        familyId,
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
