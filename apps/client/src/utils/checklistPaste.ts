/**
 * 粘贴清洗 —— 把「一大段物品清单文本」变成条目数组
 * ============================================================================
 * 场景（反馈 1.1「物品清单允许粘贴」）：家长群里发来的打包清单、备忘录里积攒的
 * 必带物品，通常是一行一条，偶尔带数量（「袜子 x3」「充电宝*2」「矿泉水 4」）。
 * 手工一条条敲是最劝退的一步，所以粘贴必须能一次吃进去。
 *
 * 规则（宁可宽松也不要挡住用户）：
 *   · 一行一条，空行忽略；
 *   · 行首的列表符号（- · * 1. ①）与行内多余空格全部剥掉；
 *   · 行尾的数量标记 `x2` / `×2` / `*2` / `（2）` / ` 2` 解析为 quantity；
 *   · 数量上限 9999（与后端 quantity schema 一致），非数字一律回落 1；
 *   · 逐行去重（同名保留先出现的那条，数量取大）——同一份清单里重复出现
 *     两遍「充电宝」几乎总是手误，留两条反而让人以为要带两个。
 *
 * 纯函数、无 Taro 依赖，双端共用且有单测。
 */

import type { ChecklistTemplateItem } from '../api/types';

/** 行首列表符号：「- 」「· 」「* 」「1. 」「1、」「①」 */
const LEADING_BULLET = /^[\s\-·*•]+|^\d{1,2}[.、)]\s*|^[①②③④⑤⑥⑦⑧⑨⑩]\s*/;

/** 行尾数量标记：x2 / ×2 / *2 / （2） / (2) / 空格 2 */
const TRAILING_QTY = /(?:[x×*]\s*(\d{1,3})\s*$|[(（]\s*(\d{1,3})\s*[)）]\s*$|\s(\d{1,3})\s*$)/i;

/**
 * 解析粘贴文本 → 条目数组。
 * @param raw 用户粘贴的原文
 * @param max 单次上限（与后端 createTemplateSchema.items.max(200) 对齐）
 */
export function parsePastedItems(raw: string, max = 200): ChecklistTemplateItem[] {
  const seen = new Map<string, number>();
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    let text = line.trim();
    if (text === '') continue;
    text = text.replace(LEADING_BULLET, '').trim();
    if (text === '') continue;

    let quantity = 1;
    const qty = TRAILING_QTY.exec(text);
    if (qty !== null) {
      const digits = qty[1] ?? qty[2] ?? qty[3];
      if (digits !== undefined) {
        const n = Number(digits);
        if (Number.isFinite(n) && n >= 1 && n <= 9999) {
          quantity = n;
          text = text.slice(0, qty.index).trim();
        }
      }
    }
    // 名称仍为空（整行只有一个数字）→ 丢弃
    if (text === '') continue;
    // 名称上限 64 字（后端 schema）
    if (text.length > 64) text = text.slice(0, 64);

    const prev = seen.get(text);
    if (prev === undefined) {
      if (seen.size >= max) continue;
      seen.set(text, quantity);
    } else if (quantity > prev) {
      seen.set(text, quantity);
    }
  }
  return [...seen].map(([name, quantity]) => ({ name, quantity }));
}
