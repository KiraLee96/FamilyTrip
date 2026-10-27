/**
 * 行程长图布局单测
 * ============================================================================
 * 为什么测这个：长图只能人眼看，出问题（文字溢出/截断/高度算错）在 CI 里完全隐形。
 * 把「排版计算」抽成纯函数后，换行、截断、高度估算都可以在这里锁住。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_ITEMS,
  POSTER_WIDTH,
  clampItems,
  estimateHeight,
  wrapText,
  drawPoster,
  type PosterData,
  type PosterPainter,
} from '../tripPoster';

/** 假绘制器：按「每字 size 宽」估算，便于断言换行结果（不依赖 canvas） */
function fakePainter(): PosterPainter & { texts: string[]; rects: number } {
  const texts: string[] = [];
  let rectCount = 0;
  const p = {
    rect: () => {
      rectCount += 1;
    },
    text: (content: string) => {
      texts.push(content);
    },
    // 中文按 1 字 = size 宽（真实字体约 0.9~1.0，用于测试足够）
    measure: (content: string, size: number) => content.length * size,
    line: () => undefined,
    // texts / rects 由下面的 defineProperty 以 getter 形式挂上，故此处先断言为 unknown
  } as unknown as PosterPainter & { texts: string[]; rects: number };
  // 🔴 必须用 getter：Object.assign 复制的是当时的「值」，后续自增不会反映出来
  Object.defineProperty(p, 'texts', { get: () => texts });
  Object.defineProperty(p, 'rects', { get: () => rectCount });
  return p;
}

function makeData(itemCount: number, title = '国庆 · 青岛看海'): PosterData {
  return {
    title,
    dateText: '2026-10-01 ~ 2026-10-03',
    destText: '青岛 · 栈桥',
    days: [
      {
        label: 'Day 1',
        date: '10-01 周三',
        items: Array.from({ length: itemCount }, (_, i) => ({
          time: '09:00',
          title: `安排 ${i + 1}`,
          location: '栈桥海边',
        })),
      },
    ],
    generatedAt: '生成于 2026-10-26',
  };
}

describe('wrapText 换行', () => {
  it('空串返回单个空行，不抛错', () => {
    expect(wrapText(fakePainter(), '', 100, 20)).toEqual(['']);
  });

  it('放得下时只有一行', () => {
    const lines = wrapText(fakePainter(), '去海边', 1000, 20);
    expect(lines).toEqual(['去海边']);
  });

  it('超宽时按字符折行且不丢字', () => {
    const painter = fakePainter();
    // 宽度 100，字号 20 → 每行 5 字
    const text = '一二三四五六七八九十';
    const lines = wrapText(painter, text, 100, 20);
    expect(lines.join('')).toBe(text);
    expect(lines.every((l) => l.length <= 5)).toBe(true);
    expect(lines.length).toBe(2);
  });

  it('长标题只在首行缩进不影响换行（wrapText 本身不处理缩进）', () => {
    const painter = fakePainter();
    const lines = wrapText(painter, 'A'.repeat(30), 200, 20);
    expect(lines.length).toBe(3);
  });
});

describe('clampItems 截断', () => {
  it('未超上限时原样返回且 dropped=0', () => {
    const { data, dropped } = clampItems(makeData(5));
    expect(dropped).toBe(0);
    expect(data.days[0]!.items.length).toBe(5);
  });

  it('超上限时截到 MAX_ITEMS 并如实报告丢弃数', () => {
    const over = 8;
    const { data, dropped } = clampItems(makeData(MAX_ITEMS + over));
    expect(data.days[0]!.items.length).toBe(MAX_ITEMS);
    expect(dropped).toBe(over);
  });

  it('跨天也按总数截断（不是每天各自截断）', () => {
    const data: PosterData = {
      ...makeData(0),
      days: [
        {
          label: 'Day 1',
          date: 'd1',
          items: Array.from({ length: 40 }, (_, i) => ({ title: `a${i}` })),
        },
        {
          label: 'Day 2',
          date: 'd2',
          items: Array.from({ length: 40 }, (_, i) => ({ title: `b${i}` })),
        },
      ],
    };
    const { data: out, dropped } = clampItems(data);
    const total = out.days.reduce((s, d) => s + d.items.length, 0);
    expect(total).toBe(MAX_ITEMS);
    expect(dropped).toBe(80 - MAX_ITEMS);
  });
});

describe('estimateHeight 高度估算', () => {
  it('至少 900（短行程也不出薄片）', () => {
    expect(estimateHeight(makeData(0))).toBeGreaterThanOrEqual(900);
  });

  it('条目越多越高', () => {
    const h1 = estimateHeight(makeData(3));
    const h2 = estimateHeight(makeData(20));
    expect(h2).toBeGreaterThan(h1);
  });

  it('有上界（防止极端数据把画布顶爆）', () => {
    const huge: PosterData = {
      ...makeData(0),
      days: Array.from({ length: 200 }, (_, i) => ({
        label: `Day ${i}`,
        date: 'd',
        items: Array.from({ length: 60 }, () => ({ title: 'x' })),
      })),
    };
    expect(estimateHeight(huge)).toBeLessThanOrEqual(6000);
  });
});

describe('drawPoster 绘制', () => {
  it('画出标题与每条安排的标题（不吞内容）', () => {
    const painter = fakePainter();
    drawPoster(painter, makeData(3));
    const all = painter.texts.join('|');
    expect(all).toContain('国庆 · 青岛看海');
    expect(all).toContain('安排 1');
    expect(all).toContain('安排 3');
    expect(all).toContain('Day 1');
  });

  it('空安排的一天给出占位文案而不是留白', () => {
    const painter = fakePainter();
    drawPoster(painter, makeData(0));
    expect(painter.texts.join('|')).toContain('这一天还没有安排');
  });

  it('不绘制任何邀请码/加入链接（结束的行程不招募）', () => {
    const painter = fakePainter();
    drawPoster(painter, makeData(2));
    const all = painter.texts.join('|');
    expect(all).not.toContain('邀请');
    expect(all).not.toContain('加入');
    expect(all).not.toMatch(/https?:\/\//);
  });

  it('返回实际占用高度，且宽高都不为 0', () => {
    const painter = fakePainter();
    const used = drawPoster(painter, makeData(2));
    expect(used).toBeGreaterThan(0);
    expect(POSTER_WIDTH).toBe(750);
    expect(painter.rects).toBeGreaterThan(0);
  });
});
