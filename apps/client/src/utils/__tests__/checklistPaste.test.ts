/**
 * 粘贴清洗的回归基线（反馈 1.1「物品清单允许粘贴」）
 * ============================================================================
 * 锁三件事：
 *   1. 行首列表符号要剥干净（用户从群公告/备忘录复制的清单全带符号）；
 *   2. 数量标记要能认出来，且「袜子」这类纯文本不会被当成数量；
 *   3. 同名去重（保留较大数量），数量非法回落 1，名称超长截断到 64。
 */

import { describe, expect, it } from 'vitest';

import { parsePastedItems } from '../checklistPaste';

describe('parsePastedItems · 粘贴清洗', () => {
  it('一行一条，剥掉行首列表符号', () => {
    expect(parsePastedItems('- 身份证\n· 充电宝\n1. 雨伞\n① 纸巾')).toEqual([
      { name: '身份证', quantity: 1 },
      { name: '充电宝', quantity: 1 },
      { name: '雨伞', quantity: 1 },
      { name: '纸巾', quantity: 1 },
    ]);
  });

  it('识别行尾数量标记（x / × / * / 括号 / 空格）', () => {
    expect(parsePastedItems('袜子 x3\n充电宝*2\n矿泉水（4）\n口罩 5')).toEqual([
      { name: '袜子', quantity: 3 },
      { name: '充电宝', quantity: 2 },
      { name: '矿泉水', quantity: 4 },
      { name: '口罩', quantity: 5 },
    ]);
  });

  it('纯文本名称不会被误判成数量', () => {
    expect(parsePastedItems('晕车药')).toEqual([{ name: '晕车药', quantity: 1 }]);
  });

  it('同名去重并保留较大数量', () => {
    expect(parsePastedItems('充电宝\n充电宝 x2')).toEqual([{ name: '充电宝', quantity: 2 }]);
  });

  it('忽略空行与纯符号行', () => {
    expect(parsePastedItems('\n\n---\n\n')).toEqual([]);
  });

  it('名称超长截断到 64 字（对齐后端 schema）', () => {
    const long = '很长的物品名称'.repeat(20);
    const out = parsePastedItems(long);
    expect(out).toHaveLength(1);
    expect(out[0]?.name.length).toBe(64);
  });

  it('超出上限的行被丢弃（默认 200）', () => {
    const raw = Array.from({ length: 210 }, (_, i) => `物品${i}`).join('\n');
    expect(parsePastedItems(raw)).toHaveLength(200);
  });
});
