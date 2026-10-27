/**
 * 行程长图：布局计算 + 绘制指令（多端共用，不 fork）
 * ============================================================================
 * 用户需求（2026-10-26）：
 *   「行程已结束可以分享行程（主要是行程的安排，做成一个长图分享，
 *     但不能再分享邀请码加入行程了）」
 *
 * 为什么要拆成「布局 / 绘制」两层：
 *   1. 小程序的 `Taro.createCanvasContext` 是老式 setter API（setFillStyle/…），
 *      H5 的 DOM canvas 是标准 2D API（fillStyle = …），两者不能直接用同一份代码；
 *      但**排版逻辑与绘制顺序**完全可以共用 —— 中间隔一层 `PosterPainter` 适配器。
 *   2. 布局（换行、分页高度）是纯计算，可以单测；canvas 只能人眼看，不该是唯一验收手段。
 *
 * 🔴 不画邀请码 / 不放加入链接：行程已结束，长图只承载「回忆」，不承载「招募」。
 */

/** 一条安排 */
export interface PosterItem {
  /** 时间文案（"09:30" / "09:30-11:00"），可空 */
  time?: string;
  title: string;
  /** 地点 / 交通方式等次要信息 */
  location?: string;
}

/** 一天的分组 */
export interface PosterDay {
  /** "Day 1" */
  label: string;
  /** "10月01日 周三" */
  date: string;
  items: PosterItem[];
}

export interface PosterData {
  title: string;
  /** 日期范围文案，如 "2026-10-01 ~ 2026-10-05 · 5 天" */
  dateText: string;
  /** 目的地文案，如 "青岛 · 栈桥 · 八大关" */
  destText: string;
  days: PosterDay[];
  /** 底部品牌行（默认「旅行管家AllInOne」） */
  brand?: string;
  /** 生成日期文案 */
  generatedAt: string;
}

/** 绘制适配器：两端各实现一次，绘制逻辑只写一份 */
export interface PosterPainter {
  /** 填充矩形 */
  rect(x: number, y: number, w: number, h: number, color: string): void;
  /** 文字（size 为字号，bold 是否粗体） */
  text(
    content: string,
    x: number,
    y: number,
    opts: { size: number; color: string; bold?: boolean },
  ): void;
  /** 测量文本宽度（用于换行） */
  measure(content: string, size: number, bold?: boolean): number;
  /** 水平线 */
  line(x1: number, y1: number, x2: number, y2: number, color: string, width: number): void;
}

/** 版面常量（宽度固定 750，是主流分享图规格） */
export const POSTER_WIDTH = 750;
const PAD = 48;
const CONTENT_W = POSTER_WIDTH - PAD * 2;

/** 色板（与 theme.css 的米纸底 + 深绿主色一致） */
const C = {
  bg: '#f5f0e4',
  card: '#fbf7ec',
  title: '#1e3a2f',
  text: '#2c2c2c',
  sub: '#7a7263',
  accent: '#1e5b45',
  line: '#ddd5c2',
  chip: '#e4ecdf',
} as const;

/** 字号 */
const F = {
  title: 38,
  sub: 22,
  dayLabel: 30,
  dayDate: 20,
  itemTime: 20,
  itemTitle: 25,
  itemLoc: 20,
  brand: 21,
} as const;

/** 行高系数 */
const LH = 1.5;

/** 单条安排在竖直方向占用的粗糙高度（用于估算总高）
 *  实测一行标题 + 一行地点 + 间距约 81px，取 100 留换行余量；
 *  早先取 112 会让画布底部空出四分之一（用户看到「下面一大片空白」）。 */
const ITEM_H = 100;
const DAY_HEAD_H = 56;

/** 最多画多少条安排 —— 超出会截断（长图不是通讯录，控制在能一眼看完的量级） */
export const MAX_ITEMS = 60;

/**
 * 按宽度折行（逐字符累加，中英文混排都能处理）。
 * 不依赖 canvas 的高级特性，measure 由适配器提供。
 */
export function wrapText(
  painter: PosterPainter,
  content: string,
  maxWidth: number,
  size: number,
  bold = false,
): string[] {
  const text = (content ?? '').trim();
  if (text === '') return [''];
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    const next = cur + ch;
    if (painter.measure(next, size, bold) > maxWidth && cur !== '') {
      lines.push(cur);
      cur = ch;
    } else {
      cur = next;
    }
  }
  if (cur !== '') lines.push(cur);
  return lines;
}

/** 数据裁剪：超量条目截断，返回「被丢掉的条数」供底部提示 */
export function clampItems(data: PosterData): { data: PosterData; dropped: number } {
  let seen = 0;
  let dropped = 0;
  const days = data.days.map((d) => {
    const keep: PosterItem[] = [];
    for (const it of d.items) {
      if (seen < MAX_ITEMS) {
        keep.push(it);
        seen += 1;
      } else {
        dropped += 1;
      }
    }
    return { ...d, items: keep };
  });
  return { data: { ...data, days }, dropped };
}

/** 估算画布高度（绘制前必须先定高，故用保守估算 + 上下界夹紧） */
export function estimateHeight(data: PosterData): number {
  const head = 300; // 标题区（标题最多两行 + 日期 + 目的地 + 分隔线）
  const body = data.days.reduce(
    (sum, d) => sum + DAY_HEAD_H + Math.max(1, d.items.length) * ITEM_H,
    0,
  );
  const foot = 130;
  return Math.min(6000, Math.max(900, head + body + foot));
}

/**
 * 绘制整张长图。返回实际使用的总高度（可能小于 canvas 高度，底部留白用卡片色补齐）。
 *
 * 调用方职责：先按 `estimateHeight` 定 canvas 高度 → 再调本函数 → 导出图片。
 */
export function drawPoster(painter: PosterPainter, data: PosterData): number {
  const H = estimateHeight(data);

  // 背景
  painter.rect(0, 0, POSTER_WIDTH, H, C.bg);

  let y = PAD;

  // ── 顶部色条（视觉锚点，纯装饰）──
  painter.rect(PAD, y, 64, 8, C.accent);
  y += 34;

  // ── 标题（最多两行）──
  const titleLines = wrapText(painter, data.title, CONTENT_W, F.title, true).slice(0, 2);
  for (const ln of titleLines) {
    painter.text(ln, PAD, y + F.title, { size: F.title, color: C.title, bold: true });
    y += F.title * 1.24;
  }
  y += 8;

  // ── 日期 / 人数 ──
  painter.text(data.dateText, PAD, y + F.sub, { size: F.sub, color: C.sub });
  y += F.sub * LH;

  // ── 目的地（有才画）──
  if (data.destText !== '') {
    y += 4;
    const destLines = wrapText(painter, data.destText, CONTENT_W, F.sub).slice(0, 2);
    for (const ln of destLines) {
      painter.text(ln, PAD, y + F.sub, { size: F.sub, color: C.accent });
      y += F.sub * LH;
    }
    y += 4;
  }

  y += 16;
  painter.line(PAD, y, POSTER_WIDTH - PAD, y, C.line, 2);
  y += 34;

  // ── 每天 ──
  for (const day of data.days) {
    // Day 标签 + 日期同一行
    painter.text(day.label, PAD, y + F.dayLabel, {
      size: F.dayLabel,
      color: C.accent,
      bold: true,
    });
    const labelW = painter.measure(day.label, F.dayLabel, true);
    painter.text(day.date, PAD + labelW + 16, y + F.dayLabel, { size: F.dayDate, color: C.sub });
    y += F.dayLabel * 1.3;

    if (day.items.length === 0) {
      painter.text('这一天还没有安排', PAD + 12, y + F.itemLoc, { size: F.itemLoc, color: C.sub });
      y += ITEM_H * 0.7;
    }

    for (const it of day.items) {
      // 左侧竖线（时间轴感）
      painter.rect(PAD + 2, y + 4, 3, 46, C.chip);

      const textX = PAD + 22;
      const timeW =
        it.time !== undefined && it.time !== '' ? painter.measure(it.time, F.itemTime) + 12 : 0;
      if (timeW > 0) {
        painter.text(it.time!, textX, y + F.itemTime, { size: F.itemTime, color: C.accent });
      }

      // 标题：只在首行右侧起排，折行后回到左边界，避免缩进累积
      const titleLines = wrapText(painter, it.title, CONTENT_W - 22 - timeW, F.itemTitle);
      titleLines.forEach((ln, i) => {
        painter.text(ln, i === 0 ? textX + timeW : textX, y + F.itemTitle, {
          size: F.itemTitle,
          color: C.text,
          bold: true,
        });
        if (i < titleLines.length - 1) y += F.itemTitle * 1.3;
      });
      y += F.itemTitle * 1.3;

      if (it.location !== undefined && it.location !== '') {
        const locLines = wrapText(painter, it.location, CONTENT_W - 22, F.itemLoc).slice(0, 2);
        for (const ln of locLines) {
          painter.text(ln, textX, y + F.itemLoc, { size: F.itemLoc, color: C.sub });
          y += F.itemLoc * 1.45;
        }
      }
      y += 20; // 条目间距
    }
    y += 12;
  }

  // ── 底部 ──
  const footY = Math.min(y + 18, H - 78);
  painter.line(PAD, footY, POSTER_WIDTH - PAD, footY, C.line, 1);
  painter.text(data.brand ?? '旅行管家AllInOne', PAD, footY + 34, {
    size: F.brand,
    color: C.sub,
  });
  const stamp = data.generatedAt;
  const stampW = painter.measure(stamp, F.brand);
  painter.text(stamp, POSTER_WIDTH - PAD - stampW, footY + 34, {
    size: F.brand,
    color: C.sub,
  });

  return Math.max(y + 90, footY + 60);
}
