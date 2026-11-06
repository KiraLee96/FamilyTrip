/**
 * 内置日历（区间选择）—— 替代原生 `<Picker mode="date">`
 * ============================================================================
 * 为什么要自绘：
 *   · 原生 Picker 一次只能选一天，出发/结束要弹两次，且看不到「这次一共几天」；
 *   · 原生 Picker 在小程序与 H5 渲染成两套完全不同的控件（weapp 是底部滚轮，
 *     H5 是浏览器 date input），行为不在一个模型里；
 *   · 用户诉求是「像钉钉那样在一个月历上点起点和终点」—— 一次看全、一次选完。
 *
 * 交互模型（两次点选）的判定规则抽在 `utils/calendar.ts` 的 `nextRangeSelection`，
 * 这里只负责渲染与把点击翻译成规则调用（纯函数可单测，视图层不藏业务规则）。
 *
 * 多端：只用 View / Text + 普通 class，不依赖 DOM，不 fork。
 * 弹出层用固定定位 + `max-width: 375px` 居中，H5 桌面「手机外壳」内也是 375 宽。
 */

import { useMemo, useState } from 'react';
import { Text, View } from '@tarojs/components';

import { Icon } from './Icon';
import {
  buildMonthCells,
  inclusiveDays,
  nextRangeSelection,
  offsetYmd,
  parseYmd,
  thisWeekend,
  todayYmd,
} from '../utils/calendar';
import { dayMarkOf, holidayRangesOfMonth } from '../utils/holidays';

const WEEK_LABEL = ['一', '二', '三', '四', '五', '六', '日'];

/** 'YYYY-MM-DD' → 'M/D'（假期一览用；完整年份在同一行里已由标题给出） */
function mdText(ds: string): string {
  return `${Number(ds.slice(5, 7))}/${Number(ds.slice(8, 10))}`;
}

/**
 * 假期区间文案（含头含尾）。
 *
 * 单日假只写一个日期：2027 起端午（6/9）、中秋（9/15）各只放 1 天，
 * 原样拼区间会渲染成「端午节 6/9–6/9」，看着像数据出错。
 */
function holidayRangeText(from: string, to: string): string {
  return from === to ? mdText(from) : `${mdText(from)}–${mdText(to)}`;
}

export interface DateRangeSheetProps {
  /** 面板标题 */
  title?: string;
  initialStart?: string;
  initialEnd?: string;
  onCancel: () => void;
  onConfirm: (start: string, end: string) => void;
}

export function DateRangeSheet({
  title = '选择日期',
  initialStart = '',
  initialEnd = '',
  onCancel,
  onConfirm,
}: DateRangeSheetProps) {
  const [selStart, setSelStart] = useState(initialStart);
  const [selEnd, setSelEnd] = useState(initialEnd);

  const today = todayYmd();

  // 打开时定位到起点所在月（没有起点就看今天）
  const [cursor, setCursor] = useState<{ y: number; m: number }>(() => {
    const base = parseYmd(initialStart) ?? parseYmd(today);
    return base ? { y: base.y, m: base.m } : { y: 2026, m: 1 };
  });

  const cells = useMemo(() => buildMonthCells(cursor.y, cursor.m), [cursor]);
  const monthHolidays = useMemo(() => holidayRangesOfMonth(cursor.y, cursor.m), [cursor]);

  const pick = (ds: string): void => {
    const next = nextRangeSelection(selStart, selEnd, ds);
    setSelStart(next.start);
    setSelEnd(next.end);
  };

  const shiftMonth = (delta: number): void => {
    setCursor((c) => {
      const total = c.m + delta;
      if (total < 1) return { y: c.y - 1, m: 12 };
      if (total > 12) return { y: c.y + 1, m: 1 };
      return { y: c.y, m: total };
    });
  };

  const summary = (() => {
    if (selStart === '') return '先点一下出发日期';
    if (selEnd === '') return `出发 ${selStart} · 再点一下返程日期（单日出行可直接确认）`;
    return `${selStart} → ${selEnd} · 共 ${inclusiveDays(selStart, selEnd)} 天`;
  })();

  const quick = [
    {
      label: '今天',
      run: () => {
        setSelStart(today);
        setSelEnd('');
      },
    },
    {
      label: '本周末',
      run: () => {
        const w = thisWeekend();
        setSelStart(w.start);
        setSelEnd(w.end);
      },
    },
    {
      label: '下周',
      run: () => {
        setSelStart(offsetYmd(7));
        setSelEnd(offsetYmd(13));
      },
    },
    {
      label: '清空',
      run: () => {
        setSelStart('');
        setSelEnd('');
      },
    },
  ];

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={onCancel} />
      <View className="sheet">
        <View className="sheet__head">
          <Text className="sheet__title">{title}</Text>
          <View className="sheet__close" onClick={onCancel}>
            <Icon name="close" size={15} />
          </View>
        </View>

        <Text className="sheet__summary">{summary}</Text>

        <View className="cal">
          <View className="cal__nav">
            <View className="cal__nav-btn" onClick={() => shiftMonth(-1)}>
              <Icon name="chevron-left" size={17} />
            </View>
            <Text className="cal__nav-title">
              {cursor.y} 年 {cursor.m} 月
            </Text>
            <View className="cal__nav-btn" onClick={() => shiftMonth(1)}>
              <Icon name="chevron-right" size={17} />
            </View>
          </View>

          <View className="cal__week">
            {WEEK_LABEL.map((w) => (
              <Text key={w} className="cal__week-cell">
                {w}
              </Text>
            ))}
          </View>

          <View className="cal__grid">
            {cells.map((c, idx) => {
              if (c === null) {
                return <View key={`b-${idx}`} className="cal__cell cal__cell--blank" />;
              }
              const mark = dayMarkOf(c.ds);
              const isStart = c.ds === selStart;
              const isEnd = selEnd !== '' && c.ds === selEnd;
              const inRange = selStart !== '' && selEnd !== '' && c.ds > selStart && c.ds < selEnd;
              const cls = [
                'cal__cell',
                c.ds === today ? 'cal__cell--today' : '',
                inRange ? 'cal__cell--in' : '',
                isStart ? 'cal__cell--edge cal__cell--start' : '',
                isEnd ? 'cal__cell--edge cal__cell--end' : '',
                mark?.kind === 'HOLIDAY' ? 'cal__cell--holiday' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <View key={c.ds} className={cls} onClick={() => pick(c.ds)}>
                  {/* 日期 + 右上角「休 / 班」角标：调休这件事不标出来，
                      用户会以为自己选了个普通周末，结果那天要上班 */}
                  <View className="cal__day-wrap">
                    <Text className="cal__cell-day">{c.day}</Text>
                    {mark !== null && (
                      <Text
                        className={
                          mark.kind === 'HOLIDAY'
                            ? 'cal__tag cal__tag--off'
                            : 'cal__tag cal__tag--work'
                        }
                      >
                        {mark.kind === 'HOLIDAY' ? '休' : '班'}
                      </Text>
                    )}
                  </View>
                </View>
              );
            })}
          </View>

          {/* 本月假期一览：角标只有「休/班」两个字，节日名放这里说清楚 */}
          {monthHolidays.length > 0 && (
            <View className="cal__holidays">
              {monthHolidays.map((h) => (
                <Text key={`${h.name}-${h.from}`} className="cal__holidays-item">
                  {h.name} {holidayRangeText(h.from, h.to)}
                </Text>
              ))}
            </View>
          )}

          <View className="cal__legend">
            <Text className="cal__legend-item">
              <Text className="cal__tag cal__tag--off cal__tag--inline">休</Text> 法定假期
            </Text>
            <Text className="cal__legend-item">
              <Text className="cal__tag cal__tag--work cal__tag--inline">班</Text> 调休上班
            </Text>
          </View>
        </View>

        <View className="sheet__quick">
          {quick.map((q) => (
            <Text key={q.label} className="sheet__quick-item" onClick={q.run}>
              {q.label}
            </Text>
          ))}
        </View>

        <View className="sheet__ops">
          <View className="btn btn--ghost sheet__op" onClick={onCancel}>
            取消
          </View>
          <View
            className={`btn sheet__op ${selStart === '' ? 'btn--busy' : ''}`}
            onClick={
              selStart === ''
                ? undefined
                : () => onConfirm(selStart, selEnd === '' ? selStart : selEnd)
            }
          >
            确定
          </View>
        </View>
      </View>
    </View>
  );
}

export default DateRangeSheet;
