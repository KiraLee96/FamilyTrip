/**
 * 账单导入解析器的回归基线（2026-10-26 反馈「记账可以直接导入账单」）
 * ============================================================================
 * 锁的是**解析语义**，不是像素：
 *   · 微信 / 支付宝导出 CSV 的表头与说明行必须跳过（不能当数据记进账本）；
 *   · 收入行、退款行、缺金额行一律丢弃并计入 skipped（宁可少记不可错记）；
 *   · 金额带 ¥ / 千分位 / 单位「元」都要能归一成两位小数；
 *   · 自由粘贴模式：一行里有日期 + 金额就成立；
 *   · 类目按关键词猜（打车→交通、酒店→住宿），猜不到给「其他」。
 */

import { describe, expect, it } from 'vitest';

import {
  guessCategory,
  normalizeAmount,
  normalizeDate,
  parseBillText,
  splitCsvLine,
} from '../billImport';

describe('normalizeDate · 日期归一', () => {
  it('标准时间串取日期部分', () => {
    expect(normalizeDate('2026-10-01 12:30:00')).toBe('2026-10-01');
  });

  it('斜杠与单位数月日补零', () => {
    expect(normalizeDate('2026/10/1')).toBe('2026-10-01');
    expect(normalizeDate('2026年10月1日')).toBe('2026-10-01');
  });

  it('无年份时按今年补', () => {
    const y = new Date().getFullYear();
    expect(normalizeDate('10/01')).toBe(`${y}-10-01`);
  });

  it('没有日期返回 undefined', () => {
    expect(normalizeDate('星巴克咖啡')).toBeUndefined();
  });
});

describe('normalizeAmount · 金额归一', () => {
  it('去货币符号与千分位', () => {
    expect(normalizeAmount('¥1,286.50')).toBe('1286.50');
    expect(normalizeAmount('38')).toBe('38.00');
    expect(normalizeAmount('0.9 元')).toBe('0.90');
  });

  it('负数与 0 视为无效（退款不记支出）', () => {
    expect(normalizeAmount('-38.00')).toBeUndefined();
    expect(normalizeAmount('0.00')).toBeUndefined();
  });
});

describe('splitCsvLine · CSV 拆列', () => {
  it('保留含逗号的引号字段', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });

  it('处理 "" 转义', () => {
    expect(splitCsvLine('"他说""好""",x')).toEqual(['他说"好"', 'x']);
  });

  it('兼容制表符分隔', () => {
    expect(splitCsvLine('2026-10-01\t星巴克\t38.00')).toEqual(['2026-10-01', '星巴克', '38.00']);
  });
});

describe('parseBillText · 微信支付账单 CSV', () => {
  const csv = [
    '微信支付账单明细,,,,,,,,,,',
    '微信昵称：[小珂],,,,,,,,,,',
    '起始时间：[2026-10-01 00:00:00],,,,,,,,,,',
    '----------------------微信支付账单明细列表--------------------',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-10-01 12:30:00,商户消费,星巴克,拿铁,支出,¥38.00,零钱,支付成功,1001,2001,/',
    '2026-10-02 09:10:00,商户消费,如家酒店,住宿 2 晚,支出,¥688.00,零钱,支付成功,1002,2002,/',
    '2026-10-02 18:00:00,转账,张三,还款,收入,¥500.00,零钱,已存入零钱,1003,2003,/',
    '2026-10-03 10:00:00,商户消费,滴滴出行,快车,支出,¥26.50,零钱,已全额退款,1004,2004,/',
  ].join('\n');

  it('识别来源并跳过说明行', () => {
    const r = parseBillText(csv);
    expect(r.source).toBe('WECHAT');
    expect(r.rows).toHaveLength(2);
    expect(r.skipped).toBe(2); // 收入行 + 退款行
  });

  it('标题为「交易对方 · 商品」，金额与日期已归一', () => {
    const r = parseBillText(csv);
    expect(r.rows[0]).toMatchObject({
      title: '星巴克 · 拿铁',
      amount: '38.00',
      spentAt: '2026-10-01',
      category: '餐饮',
    });
    expect(r.rows[1]?.category).toBe('住宿');
  });
});

describe('parseBillText · 支付宝账单 CSV', () => {
  const csv = [
    '------------------------支付宝（中国）网络技术有限公司  电子客户回单------------------------',
    '交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态',
    '2026100122001,T2001,2026-10-01 08:00:00,2026-10-01 08:00:05,2026-10-01 08:00:05,其他,即时到账交易,中国铁路,高铁票,¥553.00,支出,交易成功,0.00,0.00,,已支出',
    '2026100222002,T2002,2026-10-02 20:00:00,2026-10-02 20:00:05,2026-10-02 20:00:05,其他,即时到账交易,某某超市,零食,¥86.40,支出,交易关闭,0.00,0.00,,已关闭',
  ].join('\n');

  it('识别为支付宝并只保留交易成功的支出行', () => {
    const r = parseBillText(csv);
    expect(r.source).toBe('ALIPAY');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ amount: '553.00', category: '交通' });
    expect(r.skipped).toBe(1);
  });
});

describe('parseBillText · 自由粘贴', () => {
  it('每行「日期 + 标题 + 金额」都能解析', () => {
    const r = parseBillText(
      [
        '2026-10-01 星巴克拿铁 38.00',
        '2026-10-02 青岛崂山门票 130 元',
        '随手记一句没金额的话',
      ].join('\n'),
    );
    expect(r.source).toBe('GENERIC');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.amount).toBe('38.00');
    expect(r.rows[1]?.category).toBe('门票');
    expect(r.skipped).toBe(1);
  });

  it('全空输入不产生假数据', () => {
    const r = parseBillText('');
    expect(r.rows).toHaveLength(0);
    expect(r.skipped).toBe(0);
  });
});

describe('guessCategory · 关键词映射', () => {
  it('命中交通/住宿/餐饮/门票/购物', () => {
    expect(guessCategory('滴滴出行 · 快车')).toBe('交通');
    expect(guessCategory('汉庭酒店')).toBe('住宿');
    expect(guessCategory('美团外卖')).toBe('餐饮');
    expect(guessCategory('景区门票')).toBe('门票');
    expect(guessCategory('京东商城')).toBe('购物');
  });

  it('猜不到给「其他」', () => {
    expect(guessCategory('随机商户')).toBe('其他');
  });
});
