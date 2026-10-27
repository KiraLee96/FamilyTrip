/**
 * 行程长图分享弹层（多端同构）
 * ============================================================================
 * 用户需求（2026-10-26 第 4 条）：
 *   「行程已结束可以分享行程（主要是行程的安排，做成一个长图分享，
 *     但不能再分享邀请码加入行程了）」
 *
 * 职责边界：
 *   · 本组件只负责「取数 → 画布 → 导出图片 → 保存/分享」；
 *   · 排版与绘制在 `utils/tripPoster`（纯逻辑，可单测）；
 *   · 不出现任何邀请码 / 加入链接 —— 结束的行程只分享回忆，不招募同行者。
 *
 * 双端差异（只在这一层分流，绘制逻辑共用）：
 *   · 小程序：Taro 老式 CanvasContext + canvasToTempFilePath；
 *     「分享」优先 showShareImageMenu，失败降级保存相册。
 *   · H5：DOM canvas 2d + toDataURL，下载 a[download]。
 *
 * 🔴 画布必须留在可视区：小程序的 canvas 是原生组件，移出屏幕（left:-9999px）
 *    会出现「绘制成功但截图为空白」的已知问题，所以这里用 transform: scale
 *    等比缩到容器宽度内显示，而不是藏起来。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Canvas, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { ItineraryItem } from '../api/types';
import { Icon } from './Icon';
import { Loading } from './Loading';
import { useAsync } from '../hooks/useAsync';
import { shortDate, weekday } from './shared';
import {
  POSTER_WIDTH,
  clampItems,
  drawPoster,
  estimateHeight,
  type PosterData,
  type PosterDay,
  type PosterPainter,
} from '../utils/tripPoster';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
const CANVAS_ID = 'trip-poster';

/** 安排时间文案：有起止显示区间，否则单点（与详情页 timeText 同口径） */
function timeText(it: ItineraryItem): string {
  if (it.startTime !== undefined && it.endTime !== undefined) {
    return `${it.startTime}-${it.endTime}`;
  }
  return it.startTime ?? it.endTime ?? '';
}

/** 把扁平安排按日期分组，组内按时间/order 排序 */
export function groupByDay(items: ItineraryItem[], startDate?: string): PosterDay[] {
  const map = new Map<string, ItineraryItem[]>();
  for (const it of items) {
    const list = map.get(it.date);
    if (list) list.push(it);
    else map.set(it.date, [it]);
  }
  const dates = [...map.keys()].sort();
  const start = startDate ?? dates[0] ?? '';

  return dates.map((date, i) => {
    const dayNo =
      start !== ''
        ? Math.max(1, Math.round((Date.parse(date) - Date.parse(start)) / 86400000) + 1)
        : i + 1;
    const list = [...(map.get(date) ?? [])].sort((a, b) => {
      const ta = a.startTime ?? '';
      const tb = b.startTime ?? '';
      if (ta !== tb) return ta < tb ? -1 : 1;
      return a.sortOrder - b.sortOrder;
    });
    return {
      label: `Day ${dayNo}`,
      date: `${shortDate(date)} ${weekday(date)}`,
      items: list.map((it) => ({
        ...(timeText(it) !== '' ? { time: timeText(it) } : {}),
        title: it.title,
        ...(it.location !== undefined && it.location !== '' ? { location: it.location } : {}),
      })),
    };
  });
}

/** 小程序 CanvasContext → 统一绘制适配器 */
interface TaroCtxLike {
  setFillStyle(c: string): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  setFontSize(n: number): void;
  fillText(t: string, x: number, y: number): void;
  measureText(t: string): { width: number };
  setStrokeStyle(c: string): void;
  setLineWidth(n: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  draw(reserve?: boolean, cb?: () => void): void;
}

function taroPainter(ctx: TaroCtxLike): PosterPainter {
  return {
    rect: (x, y, w, h, color) => {
      ctx.setFillStyle(color);
      ctx.fillRect(x, y, w, h);
    },
    text: (content, x, y, o) => {
      ctx.setFillStyle(o.color);
      ctx.setFontSize(o.size);
      ctx.fillText(content, x, y);
    },
    measure: (content, size) => {
      ctx.setFontSize(size);
      return ctx.measureText(content).width || 0;
    },
    line: (x1, y1, x2, y2, color, width) => {
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(width);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },
  };
}

const FONT_STACK = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/**
 * 等 H5 的真 `<canvas>` 出现。
 * ============================================================================
 * 🔴 Taro H5 的 `<Canvas>` 渲染成自定义元素 `<taro-canvas-core id="...">`，
 *    真正的 `<canvas>` 是它**后续挂进去**的子节点。两条实测结论（2026-10-27）：
 *      1. 直接对 id 元素调 getContext → `d.getContext is not a function`；
 *      2. 在首次 effect 里取子 canvas → 有时为 null（Taro 尚未完成内部挂载），
 *         表现为「画布未就绪」。
 *    所以这里轮询等它出现，而不是假设 DOM 已完备。
 */
async function waitForCanvas(timeoutMs = 2500): Promise<HTMLCanvasElement> {
  const started = Date.now();
  for (;;) {
    const host = document.getElementById(CANVAS_ID);
    // 是原生 canvas 就直接用；否则往包装元素里找
    const found = host instanceof HTMLCanvasElement ? host : host?.querySelector('canvas');
    // html canvas 与 querySelector('canvas') 的结果已收窄为 HTMLCanvasElement | null | undefined
    if (found !== null && found !== undefined) return found;
    if (Date.now() - started > timeoutMs) throw new Error('画布未就绪，请重试');
    await new Promise<void>((r) => {
      setTimeout(r, 60);
    });
  }
}

/** H5 DOM 2d → 统一绘制适配器 */
function webPainter(ctx: CanvasRenderingContext2D): PosterPainter {
  return {
    rect: (x, y, w, h, color) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    },
    text: (content, x, y, o) => {
      ctx.fillStyle = o.color;
      ctx.font = `${o.bold === true ? 'bold ' : ''}${o.size}px ${FONT_STACK}`;
      ctx.fillText(content, x, y);
    },
    measure: (content, size, bold) => {
      ctx.font = `${bold === true ? 'bold ' : ''}${size}px ${FONT_STACK}`;
      return ctx.measureText(content).width;
    },
    line: (x1, y1, x2, y2, color, width) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    },
  };
}

/**
 * 把行程与安排组装成海报数据。
 * 顺带算上「被截断的条数」，让底部提示有据可依（不是拍脑袋写的）。
 */
function buildPosterData(
  title: string,
  dateText: string,
  destinations: string,
  items: ItineraryItem[],
  startDate: string | undefined,
): { data: PosterData; dropped: number; total: number } {
  const days = groupByDay(items, startDate);
  const base: PosterData = {
    title,
    dateText,
    destText: destinations,
    days,
    generatedAt: `生成于 ${shortDate(new Date().toISOString().slice(0, 10))}`,
  };
  const { data, dropped } = clampItems(base);
  return { data, dropped, total: items.length };
}

export function TripPosterSheet({
  tripId,
  tripTitle,
  onClose,
}: {
  tripId: string;
  tripTitle: string;
  onClose: () => void;
}) {
  const q = useAsync(
    useCallback(() => api.listItineraries(tripId), [tripId]),
    [tripId],
  );
  const trip = useAsync(
    useCallback(() => api.getTrip(tripId), [tripId]),
    [tripId],
  );

  /** 画布高度（估算，绘制前必须定下来） */
  const [height, setHeight] = useState(1200);
  /** 已生成的临时图片路径 / dataURL */
  const [imagePath, setImagePath] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  /** 缩放比：750 逻辑宽等比缩到可视区 */
  const [scale, setScale] = useState(0.46);
  const drewRef = useRef(false);

  const items = q.data ?? [];
  const t = trip.data;

  // 视口宽度 → 缩放比（一次计算，避免每帧量 DOM）
  useEffect(() => {
    try {
      const w = Taro.getSystemInfoSync().windowWidth || 375;
      const box = Math.min(w - 56, 520);
      setScale(Math.max(0.3, Math.min(1, box / POSTER_WIDTH)));
    } catch {
      setScale(0.46);
    }
  }, []);

  // 数据到位后算高度
  useEffect(() => {
    if (t === undefined || q.loading) return;
    const { data } = buildPosterData(t.title, '', '', items, t.startDate ?? undefined);
    setHeight(estimateHeight(data));
    drewRef.current = false;
    setImagePath('');
  }, [t, q.loading, items]);

  /** 执行绘制 + 导出图片 */
  const render = useCallback(async () => {
    if (t === undefined) return;
    setErr('');
    setBusy(true);
    try {
      const dateText = [t.startDate, t.endDate].filter(Boolean).join(' ~ ');
      const destinations = (t.destinations ?? []).map((d) => d.name).join(' · ');
      const { data } = buildPosterData(
        t.title,
        dateText === '' ? '日期待定' : dateText,
        destinations,
        items,
        t.startDate ?? undefined,
      );

      if (IS_WEAPP) {
        const ctx = Taro.createCanvasContext(CANVAS_ID) as unknown as TaroCtxLike;
        drawPoster(taroPainter(ctx), data);
        // 等 draw 真正落盘再导出，否则截到半张白图
        await new Promise<void>((resolve) => {
          ctx.draw(false, () => resolve());
        });
        const res = await Taro.canvasToTempFilePath({
          canvasId: CANVAS_ID,
          width: POSTER_WIDTH,
          height,
          destWidth: POSTER_WIDTH,
          destHeight: height,
        });
        setImagePath(res.tempFilePath);
      } else {
        const el = await waitForCanvas();
        // 2x 渲染，手机上看字更实（750 逻辑宽 → 1500 物理像素）
        const dpr = 2;
        el.width = POSTER_WIDTH * dpr;
        el.height = height * dpr;
        // 🔴 属性改完必须把显示尺寸交回 CSS：默认 canvas 会按属性尺寸（1500px）
        //    直接渲染，把容器撑爆。这里显式 width:100%/height:auto 让浏览器等比缩放。
        el.style.width = '100%';
        el.style.height = 'auto';
        el.style.display = 'block';
        // Taro 的包装元素（taro-canvas-core）也要跟着撑满，否则高度不跟随内部画布
        const hostEl = document.getElementById(CANVAS_ID);
        if (hostEl !== null && hostEl !== el) {
          hostEl.style.width = '100%';
          hostEl.style.height = 'auto';
        }
        const ctx = el.getContext('2d');
        if (ctx === null) throw new Error('当前环境不支持画布导出');
        ctx.scale(dpr, dpr);
        drawPoster(webPainter(ctx), data);
        setImagePath(el.toDataURL('image/png'));
      }
      drewRef.current = true;
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '生成长图失败，请重试');
    } finally {
      setBusy(false);
    }
  }, [t, items, height]);

  // 数据就绪后自动生成一次
  useEffect(() => {
    if (t === undefined || q.loading || drewRef.current) return;
    void render();
  }, [t, q.loading, render]);

  /** 保存到相册（小程序）/ 下载（H5） */
  const save = async (): Promise<void> => {
    if (imagePath === '') return;
    if (IS_WEAPP) {
      try {
        await Taro.saveImageToPhotosAlbum({ filePath: imagePath });
        void Taro.showToast({ title: '已保存到相册', icon: 'success' });
      } catch {
        void Taro.showToast({ title: '保存失败，请允许相册权限后重试', icon: 'none' });
      }
      return;
    }
    const a = document.createElement('a');
    a.href = imagePath;
    a.download = `${tripTitle}-行程安排.png`;
    a.click();
    void Taro.showToast({ title: '已开始下载', icon: 'none' });
  };

  /** 分享图片（小程序走原生分享面板；H5 无此能力，引导保存） */
  const share = async (): Promise<void> => {
    if (imagePath === '') return;
    if (!IS_WEAPP) {
      void Taro.showToast({ title: '网页版请先保存图片再发送', icon: 'none' });
      return;
    }
    try {
      // 基础库 2.14.4+；老版本会 reject，降级为保存相册
      await Taro.showShareImageMenu({ path: imagePath });
    } catch {
      void Taro.showToast({ title: '当前微信版本不支持直接分享，已改为保存图片', icon: 'none' });
      await save();
    }
  };

  const loading = q.loading || trip.loading;

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={onClose} />
      <View className="sheet sheet--tall">
        <View className="sheet__head">
          <Text className="sheet__title">行程长图</Text>
          <View className="sheet__close" onClick={onClose}>
            <Icon name="close" size={16} />
          </View>
        </View>

        {loading ? (
          <Loading text="正在整理行程…" />
        ) : (
          <>
            <Text className="sheet__hint poster-hint">
              仅含行程安排，不含邀请码 —— 结束的行程只分享回忆
            </Text>

            {err !== '' ? (
              <View className="poster-err">
                <Text>{err}</Text>
              </View>
            ) : null}

            {/*
              画布本身就是预览 —— 不再额外渲染一张 <Image>。
              🔴 此前 canvas + 导出图片各显示一份，用户看到「两张一模一样的图」，
                 像出了 bug（2026-10-27 验收截图发现）。

              两端尺寸策略不同（画布坐标系的行为差异，不是风格差异）：
                · H5：canvas 的绘制坐标系由 width/height **属性**决定，CSS 只影响显示。
                      所以属性给 750×H，样式给 width:100%/height:auto，浏览器自动等比缩放
                      —— 不需要算 scale，也不会算错（此前就是按 windowWidth 猜 334，
                      而容器实测只有 274，右边 60px 被裁）。
                · 小程序：原生组件的绘制坐标系跟随 style 尺寸，所以内部必须保持 750px，
                      外层用 transform 缩放。
            */}
            <View
              className="poster-sheet__canvas-box"
              style={IS_WEAPP ? { height: height * scale + 2 } : undefined}
            >
              <View
                style={
                  IS_WEAPP
                    ? {
                        width: `${POSTER_WIDTH}px`,
                        height: `${height}px`,
                        transform: `scale(${scale})`,
                        transformOrigin: 'top left',
                      }
                    : { width: '100%' }
                }
              >
                <Canvas
                  canvasId={CANVAS_ID}
                  id={CANVAS_ID}
                  style={
                    IS_WEAPP
                      ? { width: `${POSTER_WIDTH}px`, height: `${height}px` }
                      : { width: '100%', height: 'auto', display: 'block' }
                  }
                />
              </View>
            </View>

            {imagePath !== '' && !busy ? (
              <Text className="poster-done">
                <Icon name="check" size={13} /> 长图已生成，可直接分享或保存
              </Text>
            ) : null}

            <View className="sheet__ops">
              <View
                className={`btn btn--ghost sheet__op poster-op ${busy ? 'btn--busy' : ''}`}
                onClick={busy ? undefined : () => void render()}
              >
                <Icon name="edit" size={14} />
                {busy ? '生成中…' : '重新生成'}
              </View>
              <View
                className={`btn sheet__op poster-op ${imagePath === '' || busy ? 'btn--busy' : ''}`}
                onClick={imagePath === '' || busy ? undefined : () => void share()}
              >
                <Icon name="share" size={14} />
                分享
              </View>
              <View
                className={`btn btn--ghost sheet__op poster-op ${imagePath === '' || busy ? 'btn--busy' : ''}`}
                onClick={imagePath === '' || busy ? undefined : () => void save()}
              >
                <Icon name="download" size={14} />
                保存
              </View>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
