/**
 * 账单导入弹层 —— 把导出的微信/支付宝账单变成账本里的明细
 * ============================================================================
 * 反馈「记账可以直接导入账单，否则一笔一笔记太麻烦了」。
 *
 * 两条输入路径（都通到同一个解析器）：
 *   1. 选文件：小程序 `chooseMessageFile`（先从聊天/文件传输助手选 csv），
 *      H5 原生 file input；字节流经 decodeBillBytes 处理 UTF-8 / GBK 两种编码。
 *   2. 粘贴：把账单正文或记账备忘粘进来，走自由文本模式。
 *
 * 提交前必须能**逐行确认**：解析不是 100% 可靠（商户名千奇百怪），
 * 所以给每行一个勾选框与可点击切换的类目，勾掉的行不会写进账本。
 * 提交走 api.createExpensesBatch（逐行串行，部分成功语义）。
 */

import { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { BillImportRow } from '../api/types';
import { Icon } from './Icon';
import { BILL_EXPORT_HELP, decodeBillBytes, parseBillText } from '../utils/billImport';
import { EXPENSE_CATEGORIES } from '../utils/constants';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';

export function BillImportSheet({
  tripId,
  familyId,
  onClose,
  onDone,
}: {
  tripId: string;
  familyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [raw, setRaw] = useState('');
  const [rows, setRows] = useState<BillImportRow[]>([]);
  /** 没被勾掉的行索引（默认全选） */
  const [dropped, setDropped] = useState<Record<number, true>>({});
  const [parseHint, setParseHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState('');

  const selected = useMemo(() => rows.filter((_, i) => dropped[i] !== true), [rows, dropped]);
  const total = useMemo(
    () => selected.reduce((s, r) => s + Number(r.amount), 0).toFixed(2),
    [selected],
  );

  /** 解析入口（文本）：文件与粘贴共用 */
  const parseInto = useCallback((text: string) => {
    const parsed = parseBillText(text);
    setRows(parsed.rows);
    setDropped({});
    setErr('');
    const sourceText =
      parsed.source === 'WECHAT'
        ? '微信支付账单'
        : parsed.source === 'ALIPAY'
          ? '支付宝账单'
          : '文本';
    setParseHint(
      parsed.rows.length === 0
        ? `没从${sourceText}里认出可记账的支出行，换个文件或直接粘贴几行试试`
        : `识别为${sourceText}：${parsed.rows.length} 笔支出${parsed.skipped > 0 ? `，跳过 ${parsed.skipped} 行（收入/退款/缺金额）` : ''}`,
    );
  }, []);

  /** 选文件：小程序从会话选，H5 用原生 input */
  const pickFile = useCallback(async () => {
    setReading(true);
    setErr('');
    try {
      if (IS_WEAPP) {
        const res = await Taro.chooseMessageFile({
          count: 1,
          type: 'file',
          extension: ['csv', 'txt'],
        });
        const file = res.tempFiles[0];
        if (file === undefined) return;
        const fs = Taro.getFileSystemManager();
        // 不传 encoding → 拿 ArrayBuffer，自己判断 UTF-8 / GBK
        const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
          fs.readFile({
            filePath: file.path,
            success: (r) => resolve(r.data as ArrayBuffer),
            fail: (e) => reject(new Error(e.errMsg ?? '读取文件失败')),
          });
        });
        const text = decodeBillBytes(buf);
        setRaw(text);
        parseInto(text);
        return;
      }

      // H5：无 Taro 等价 API，用原生 input（不 fork 组件，只是取字节的手段不同）
      const text = await new Promise<string>((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.txt,text/csv,text/plain';
        input.onchange = () => {
          const f = input.files?.[0];
          if (f === undefined) {
            reject(new Error('没有选择文件'));
            return;
          }
          f.arrayBuffer()
            .then((buf) => resolve(decodeBillBytes(buf)))
            .catch(() => reject(new Error('读取文件失败')));
        };
        input.click();
      });
      setRaw(text);
      parseInto(text);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '选择文件失败';
      // 用户主动取消不算错误，不弹提示
      if (!/cancel/i.test(msg)) setErr(msg);
    } finally {
      setReading(false);
    }
  }, [parseInto]);

  const submit = useCallback(async () => {
    if (selected.length === 0) {
      setErr('没有勾选任何一笔');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const result = await api.createExpensesBatch(
        { tripId, familyId },
        selected.map((r) => ({
          title: r.title,
          amount: r.amount,
          ...(r.currency !== undefined ? { currency: r.currency } : {}),
          ...(r.category !== undefined ? { category: r.category } : {}),
          ...(r.spentAt !== undefined ? { spentAt: r.spentAt } : {}),
          ...(r.note !== undefined ? { note: r.note } : {}),
        })),
      );
      onDone();
      onClose();
      void Taro.showModal({
        title: '导入完成',
        content:
          result.failed > 0
            ? `成功 ${result.created} 笔，失败 ${result.failed} 笔${result.errors.length > 0 ? `\n${result.errors.join('\n')}` : ''}`
            : `已导入 ${result.created} 笔，合计 ¥${total}`,
        showCancel: false,
        confirmText: '知道了',
      });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '导入失败');
    } finally {
      setBusy(false);
    }
  }, [selected, tripId, familyId, total, onDone, onClose]);

  /** 类目切换（点一下换下一个，直到转回原值） */
  const cycleCategory = useCallback((idx: number) => {
    setRows((prev) => {
      const cur = prev[idx];
      if (cur === undefined) return prev;
      const list = EXPENSE_CATEGORIES as readonly string[];
      const at = cur.category === undefined ? -1 : list.indexOf(cur.category);
      const next = list[(at + 1) % list.length] ?? '其他';
      const copy = [...prev];
      copy[idx] = { ...cur, category: next };
      return copy;
    });
  }, []);

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={busy ? undefined : onClose} />
      <View className="sheet sheet--tall">
        <View className="sheet__head">
          <Text className="sheet__title">导入账单</Text>
          <View className="sheet__close" onClick={busy ? undefined : onClose}>
            <Icon name="close" size={15} />
          </View>
        </View>

        <ScrollView scrollY className="sheet__scroll sheet__scroll--tall">
          <View className="bill-actions">
            <View
              className={`btn btn--ghost bill-actions__btn ${reading ? 'btn--busy' : ''}`}
              onClick={reading ? undefined : () => void pickFile()}
            >
              <Icon name="package" size={14} /> {reading ? '读取中…' : '选账单文件'}
            </View>
          </View>

          <Textarea
            className="cl-paste__area bill-textarea"
            value={raw}
            maxlength={-1}
            onInput={(e) => setRaw(e.detail.value)}
            placeholder={
              '也可以直接粘贴账单内容：\n2026-10-01 星巴克拿铁 38.00\n2026-10-02 崂山门票 130 元'
            }
          />
          <View
            className="btn btn--block bill-parse"
            onClick={() => {
              if (raw.trim() === '') {
                setErr('先选文件或粘贴账单内容');
                return;
              }
              parseInto(raw);
            }}
          >
            解析
          </View>

          {parseHint !== '' ? <Text className="bill-hint">{parseHint}</Text> : null}
          {err !== '' ? <Text className="form-error">{err}</Text> : null}

          {rows.length > 0 ? (
            <View className="bill-rows">
              <View className="bill-rows__head">
                <Text className="bill-rows__title">
                  勾选要记的（{selected.length}/{rows.length} · ¥{total}）
                </Text>
                <Text
                  className="card__more"
                  onClick={() =>
                    setDropped(
                      selected.length > 0
                        ? Object.fromEntries(rows.map((_, i) => [i, true as const]))
                        : {},
                    )
                  }
                >
                  {selected.length > 0 ? '全不选' : '全选'}
                </Text>
              </View>
              {rows.map((r, idx) => {
                const off = dropped[idx] === true;
                return (
                  <View
                    key={`${r.title}-${r.spentAt}-${idx}`}
                    className={off ? 'bill-row bill-row--off' : 'bill-row'}
                    onClick={() =>
                      setDropped((prev) => {
                        const next = { ...prev };
                        if (next[idx] === true) delete next[idx];
                        else next[idx] = true;
                        return next;
                      })
                    }
                  >
                    <Text className="bill-row__box">
                      <Icon name={off ? 'circle' : 'check'} size={16} />
                    </Text>
                    <View className="bill-row__body">
                      <Text className="bill-row__title">{r.title}</Text>
                      <Text className="bill-row__sub">
                        {r.spentAt}
                        {' · '}
                        <Text
                          className="bill-row__cat"
                          onClick={(e) => {
                            e.stopPropagation();
                            cycleCategory(idx);
                          }}
                        >
                          {r.category ?? '其他'}
                        </Text>
                      </Text>
                    </View>
                    <Text className="bill-row__amt">¥{r.amount}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          <View className="bill-help">
            <Text className="bill-help__title">账单怎么导出？</Text>
            {BILL_EXPORT_HELP.map((line) => (
              <Text className="bill-help__line" key={line}>
                · {line}
              </Text>
            ))}
            <Text className="bill-help__note">
              说明：微信/支付宝的个人账单没有开放接口可直读，只能本人导出后导入。
            </Text>
          </View>
        </ScrollView>

        <View className="sheet__ops">
          <View className="btn btn--ghost sheet__op" onClick={busy ? undefined : onClose}>
            取消
          </View>
          <View
            className={`btn sheet__op ${busy || selected.length === 0 ? 'btn--busy' : ''}`}
            onClick={busy || selected.length === 0 ? undefined : () => void submit()}
          >
            {busy ? '导入中…' : `导入 ${selected.length} 笔`}
          </View>
        </View>
      </View>
    </View>
  );
}
