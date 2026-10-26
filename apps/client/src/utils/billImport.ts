/**
 * 账单导入解析器 —— 微信支付 / 支付宝账单 CSV 与自由粘贴文本
 * ============================================================================
 * 为什么不「直接接入微信/支付宝的支付信息」：
 *   两家的账单 API 都是**商户侧**的（只能查商户自己收到的钱），个人消费流水
 *   没有开放接口可读，任何声称能直接拉取用户账单的方案都不成立。
 *   唯一合规路径是用户自己导出账单（微信：我→服务→钱包→账单→常见问题→
 *   下载账单→用于个人对账；支付宝：我的→账单→右上角→开具交易流水证明），
 *   再交给本解析器。所以这里的定位是「把导出的账单变成可提交的行」。
 *
 * 覆盖三种输入形态（同一份纯函数处理，便于单测）：
 *   1. 微信支付账单 CSV（逗号分隔，带表头行「交易时间,交易类型,交易对方,...」）
 *   2. 支付宝账单 CSV（交易号,商家订单号,交易创建时间,...,金额（元）,收/支,...）
 *   3. 自由粘贴：每行含一个日期 + 一个金额即可，其余文字当标题
 *
 * 🔴 纯函数、无副作用、不依赖 Taro —— 这样才能在 vitest 里直接跑，
 *    也才能在 H5 / 小程序两端共用（不 fork）。
 */

import type { BillImportRow } from '../api/types';

/** 识别出来的账单来源（仅用于界面提示，不参与业务判断） */
export type BillSource = 'WECHAT' | 'ALIPAY' | 'GENERIC';

export interface ParsedBill {
  rows: BillImportRow[];
  /** 被跳过的行数（收入行 / 缺金额 / 缺日期 / 表头注释行） */
  skipped: number;
  source: BillSource;
}

/** 各来源的表头特征词（命中即判定来源） */
const WECHAT_HEADER_HINT = ['交易时间', '交易对方', '收/支', '金额(元)', '当前状态'];
const ALIPAY_HEADER_HINT = ['交易号', '商家订单号', '交易创建时间', '金额（元）', '资金状态'];

const pad2 = (s: string): string => s.padStart(2, '0');

/**
 * YYYY-MM-DD 归一化。
 * 覆盖 2026-10-01 / 2026/10/1 / 2026年10月1日 / 10-01（无年份取今年）。
 */
export function normalizeDate(input: string): string | undefined {
  const s = input.trim();
  const full = /(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/.exec(s);
  if (full?.[1] !== undefined && full[2] !== undefined && full[3] !== undefined) {
    return `${full[1]}-${pad2(full[2])}-${pad2(full[3])}`;
  }
  const short = /(?:^|\s)(\d{1,2})\s*[-/月]\s*(\d{1,2})(?:\s|日|$)/.exec(s);
  if (short?.[1] !== undefined && short[2] !== undefined) {
    return `${new Date().getFullYear()}-${pad2(short[1])}-${pad2(short[2])}`;
  }
  return undefined;
}

/**
 * 金额归一化 → 主单位两位小数字符串。
 * 去掉货币符号/千分位/正号；负数与 0 视为无效（账单里负数是退款，不记支出）。
 */
export function normalizeAmount(input: string): string | undefined {
  const cleaned = input.replace(/[¥￥,，\s]/g, '');
  const m = /-?\d+(?:\.\d{1,2})?/.exec(cleaned);
  if (!m) return undefined;
  const n = Number(m[0]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n.toFixed(2);
}

/**
 * CSV 行拆分：兼容逗号与制表符、双引号包裹、`""` 转义。
 * 微信/支付宝导出的 CSV 里商品名含逗号是常态，不按引号处理会错位。
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** 分类关键词 → 记账类目（与 utils/constants 的 EXPENSE_CATEGORIES 对齐） */
const CATEGORY_RULES: Array<{ category: string; keywords: string[] }> = [
  {
    category: '交通',
    keywords: [
      '打车',
      '滴滴',
      '出租车',
      '地铁',
      '公交',
      '高铁',
      '火车',
      '机票',
      '航空',
      '加油',
      '停车',
      'etc',
      '过路',
      '车费',
      '12306',
      '携程',
      '顺风车',
    ],
  },
  {
    category: '住宿',
    keywords: ['酒店', '民宿', '宾馆', '住宿', '旅馆', '汉庭', '如家', 'airbnb', '客栈'],
  },
  {
    category: '餐饮',
    keywords: [
      '餐',
      '饭',
      '咖啡',
      '奶茶',
      '美团',
      '饿了么',
      '肯德基',
      '麦当劳',
      '星巴克',
      '外卖',
      '烘焙',
      '面馆',
      '火锅',
      '烧烤',
      '早餐',
      // 大排档 / 海鲜 / 小吃这类旅游账单里高频的写法（首轮验收里「海鲜大排档」
      // 就被猜成了「其他」，说明关键词要覆盖口语化商户名）
      '海鲜',
      '大排档',
      '小吃',
      '快餐',
      '食堂',
      '饮品',
      '茶馆',
      '酒吧',
    ],
  },
  {
    category: '门票',
    keywords: ['门票', '景区', '乐园', '公园', '博物馆', '展览', '演出', '索道', '温泉'],
  },
  {
    category: '购物',
    keywords: [
      '超市',
      '商场',
      '便利店',
      '淘宝',
      '天猫',
      '京东',
      '拼多多',
      '百货',
      '药房',
      '屈臣氏',
    ],
  },
];

/** 按标题 + 来源类型猜类目；猜不到给「其他」 */
export function guessCategory(title: string, typeHint = ''): string {
  const hay = `${title} ${typeHint}`.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => hay.includes(k))) return rule.category;
  }
  return '其他';
}

/** 是否为「支出」行：账单的收/支列；空值按支出处理（多数导出文件只有支出） */
function isExpenseRow(direction: string): boolean {
  const d = direction.trim();
  if (d === '') return true;
  if (d.includes('不计收支')) return false;
  if (d.includes('收入') || d === '收') return false;
  if (d.includes('支出') || d === '支') return true;
  return true;
}

/** 是否为「交易成功」行：退款/关闭/失败的行不该记账 */
function isSuccessRow(status: string): boolean {
  const s = status.trim();
  if (s === '') return true;
  if (/退款|关闭|失败|已撤销|已失效/.test(s)) return false;
  return true;
}

/** 表头列名定位（返回各字段的列下标，缺列给 -1） */
interface ColumnMap {
  time: number;
  counterparty: number;
  product: number;
  direction: number;
  amount: number;
  status: number;
  type: number;
  note: number;
}

function findColumn(header: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const idx = header.findIndex((h) => p.test(h));
    if (idx >= 0) return idx;
  }
  return -1;
}

function buildColumnMap(header: string[]): ColumnMap {
  return {
    time: findColumn(header, [/交易时间/, /交易创建时间/, /付款时间/, /^时间$/]),
    counterparty: findColumn(header, [/交易对方/, /^对方$/, /商户名称/]),
    product: findColumn(header, [/^商品/, /商品名称/, /^摘要$/]),
    direction: findColumn(header, [/收\/支/, /收支类型/, /^收支$/]),
    amount: findColumn(header, [/金额/]),
    status: findColumn(header, [/当前状态/, /交易状态/, /^状态$/]),
    type: findColumn(header, [/交易类型/, /^类型$/]),
    note: findColumn(header, [/^备注$/]),
  };
}

const cell = (row: string[], i: number): string => (i >= 0 ? (row[i] ?? '') : '');

/** 判断表头行：命中来源特征词 ≥3 个即认定 */
function detectSource(line: string): BillSource | undefined {
  const hits = (hints: string[]): number => hints.filter((h) => line.includes(h)).length;
  if (hits(WECHAT_HEADER_HINT) >= 3) return 'WECHAT';
  if (hits(ALIPAY_HEADER_HINT) >= 3) return 'ALIPAY';
  if (line.includes('金额') && (line.includes('收/支') || line.includes('交易'))) return 'WECHAT';
  return undefined;
}

/**
 * 主入口：把粘贴/导入的文本解析成可提交的账单行。
 * 任何解析不出的行都计入 skipped，绝不把半懂的数据塞进账本。
 */
export function parseBillText(raw: string): ParsedBill {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

  let skipped = 0;
  let source: BillSource = 'GENERIC';

  // ① 找表头（账单文件前几行是导出说明，不能当数据）
  let headerIdx = -1;
  let cols: ColumnMap | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const detected = detectSource(line);
    if (detected !== undefined) {
      source = detected;
      headerIdx = i;
      cols = buildColumnMap(splitCsvLine(line));
      break;
    }
  }

  const rows: BillImportRow[] = [];

  if (headerIdx >= 0 && cols !== undefined) {
    // ② 表头模式：按列名取字段
    for (let i = headerIdx + 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i] as string);
      if (cells.length < 2) {
        skipped += 1;
        continue;
      }
      const amount = normalizeAmount(cell(cells, cols.amount));
      const spentAt = normalizeDate(cell(cells, cols.time));
      const direction = cell(cells, cols.direction);
      const status = cell(cells, cols.status);
      if (
        amount === undefined ||
        spentAt === undefined ||
        !isExpenseRow(direction) ||
        !isSuccessRow(status)
      ) {
        skipped += 1;
        continue;
      }
      const counterparty = cell(cells, cols.counterparty);
      const product = cell(cells, cols.product);
      const typeHint = cell(cells, cols.type);
      const note = cell(cells, cols.note);
      const title = [counterparty, product].filter((s) => s !== '').join(' · ');
      rows.push({
        title: title === '' ? '账单支出' : title,
        amount,
        spentAt,
        category: guessCategory(title, typeHint),
        ...(note !== '' ? { note } : {}),
      });
    }
  } else {
    // ③ 自由文本模式：每行找「日期 + 金额」，其余当标题
    for (const line of lines) {
      // 跳过明显的说明/分隔行，别把它们算进 skipped 干扰用户
      if (/^[-=*]{3,}/.test(line) || /微信支付账单|支付宝|导出|详情/.test(line)) continue;
      const spentAt = normalizeDate(line);
      const amountMatch = /[¥￥]?\s*(\d+(?:\.\d{1,2})?)(?:\s*元)?/.exec(
        line.replace(/\d{4}\s*[-/]\s*\d{1,2}\s*[-/]\s*\d{1,2}/, ''),
      );
      const amount = amountMatch?.[1] !== undefined ? normalizeAmount(amountMatch[1]) : undefined;
      if (spentAt === undefined || amount === undefined) {
        skipped += 1;
        continue;
      }
      // 标题 = 去掉日期与金额后的剩余文本（分隔符归一化）
      const title = line
        .replace(/\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?/, '')
        .replace(/[¥￥]?\s*\d+(?:\.\d{1,2})?\s*元?/, '')
        .replace(/^[\s,，\-|:：]+|[\s,，\-|:：]+$/g, '')
        .trim();
      rows.push({
        title: title === '' ? '账单支出' : title,
        amount,
        spentAt,
        category: guessCategory(title),
      });
    }
  }

  return { rows, skipped, source };
}

/** 导入弹层里展示的「怎么导出账单」指引（与 utils/clipboard 同层，避免散落文案） */
export const BILL_EXPORT_HELP: string[] = [
  '微信：我 → 服务 → 钱包 → 账单 → 常见问题 → 下载账单 → 用于个人对账，账单会发到邮箱，解压得到 CSV',
  '支付宝：我的 → 账单 → 右上角「…」→ 开具交易流水证明 → 选择时间段，导出 CSV',
  '拿到 CSV 后：小程序里先发到「文件传输助手」再从这里选文件；网页版直接选文件即可',
];

/**
 * 账单文件字节 → 文本。
 * ============================================================================
 * 🔴 编码是这里最容易翻车的地方：微信账单 CSV 是 UTF-8(带 BOM)，
 *    **支付宝导出的是 GBK**。只按 UTF-8 读会把中文商户名读成 `����`，
 *    于是分类猜不出来、标题全是乱码 —— 用户只会说「导入是坏的」。
 *
 * 策略：先按 UTF-8 严格解码（fatal），失败再试 GBK，都不行退宽松 UTF-8。
 * TextDecoder 在小程序老基础库可能缺失，此时直接按 UTF-8 宽松解码（
 * 至少 ASCII 的金额/日期是对的，中文由用户自己看预览改）。
 */
export function decodeBillBytes(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  // 剥 UTF-8 BOM，否则首列表头名会带上不可见字符，列定位失配
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const body = bytes.subarray(start);

  const TD = typeof TextDecoder === 'undefined' ? undefined : TextDecoder;
  if (TD === undefined) {
    // 无 TextDecoder：逐字节按 Latin-1 解码，至少保证 ASCII 部分（金额/日期）正确
    let out = '';
    for (const b of body) out += String.fromCharCode(b);
    return out;
  }

  try {
    return new TD('utf-8', { fatal: true }).decode(body);
  } catch {
    // UTF-8 严格解码失败 → 大概率是 GBK（支付宝账单）
  }
  try {
    return new TD('gbk').decode(body);
  } catch {
    return new TD('utf-8').decode(body);
  }
}
