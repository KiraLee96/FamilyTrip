/**
 * 我的常备物品（原「物品库」页，2026-10-27 合并进清单页）
 * ============================================================================
 * 为什么合并（用户反馈④「物品库和物品清单的权限很模糊」）：
 *   合并前是**两个并列入口 + 两套权限**：
 *     · 「物品库」（/items 独立 tab）→ 后端 Item 表，PRIVATE 域，只本人可见
 *     · 「物品清单」（/profile 里的清单页）→ checklistTemplate，SHARED / PERSONAL 双语义
 *   同一个"物品"概念分散在两处，用户无法判断「我在哪加的、家里人看得见吗」。
 *
 * 合并后的口径（**一个页面，三段，每段标明可见范围**）：
 *   ① 家庭清单（共享）      —— 全家可见
 *   ② 我的清单（私人）      —— 仅自己可见
 *   ③ 我的常备物品（本组件）—— 仅自己可见，跨行程复用；可一键塞进某次行程的打包清单
 *
 * 🔴 没有把 Item 表的数据迁进模板表：Item 还被「穿搭」域的 outfit_item 外键引用，
 *    迁数据等于改一处牵三域。这里只做**入口合并 + 语义标注**，数据各回各家，
 *    权限反而更清晰：常备物品永远是你私人的，清单才分共享/私人。
 */

import { useCallback, useMemo, useState } from 'react';
import { Input, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api';
import type { Item, Trip } from '../api/types';
import { Icon } from './Icon';
import { Empty, ErrorBox, Loading } from './Loading';
import { useAsync } from '../hooks/useAsync';
import { ITEM_CATEGORIES } from '../utils/constants';

const UNCATEGORIZED = '未分类';

export function ItemLibraryPanel({ familyId }: { familyId: string }) {
  const [category, setCategory] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 「加入某行程清单」的选行程弹层 */
  const [applying, setApplying] = useState<Item | null>(null);

  const q = useAsync(
    useCallback(
      () => api.listItems({ ...(category !== '' ? { category } : {}), mineOnly: true }),
      [category],
    ),
    [category],
  );

  const items = q.data ?? [];

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.category ?? UNCATEGORIZED;
      const arr = map.get(key);
      if (arr) arr.push(it);
      else map.set(key, [it]);
    }
    const order = [...ITEM_CATEGORIES, UNCATEGORIZED];
    return [...map.entries()].sort(
      (a, b) =>
        (order.indexOf(a[0]) < 0 ? 99 : order.indexOf(a[0])) -
        (order.indexOf(b[0]) < 0 ? 99 : order.indexOf(b[0])),
    );
  }, [items]);

  return (
    <>
      <View className="cl-intro card card--flush" style={{ marginTop: 14 }}>
        <Text className="cl-intro__title">
          <Icon name="user" size={14} /> 我的常备物品 · 仅自己可见
        </Text>
        <Text className="cl-intro__text">
          每次出门都要带的东西（证件、充电、常备药）先放这里，跨行程复用；
          出门前点「加入行程」，一键变成那趟的打包项。
        </Text>
      </View>

      <View className="filter-bar" style={{ marginTop: 10 }}>
        <Chip label="全部" on={category === ''} onClick={() => setCategory('')} />
        {ITEM_CATEGORIES.map((c) => (
          <Chip key={c} label={c} on={category === c} onClick={() => setCategory(c)} />
        ))}
      </View>

      {q.loading ? (
        <Loading text="读取常备物品…" />
      ) : q.error ? (
        <ErrorBox message={q.error} onRetry={q.reload} />
      ) : (
        <>
          {items.length === 0 ? (
            <Empty text="还没有常备物品，下面加几件每次必带的" />
          ) : (
            groups.map(([cat, list]) => (
              <View key={cat} className="card card--flush">
                <View className="row-between" style={{ padding: '9px 14px 4px' }}>
                  <Text className="muted" style={{ fontSize: 11.5 }}>
                    {cat}（{list.length}）
                  </Text>
                </View>
                {list.map((it) =>
                  editingId === it.id ? (
                    <EditRow
                      key={it.id}
                      item={it}
                      onCancel={() => setEditingId(null)}
                      onSaved={() => {
                        setEditingId(null);
                        q.reload();
                      }}
                    />
                  ) : (
                    <StapleRow
                      key={it.id}
                      item={it}
                      onEdit={() => setEditingId(it.id)}
                      onApply={() => setApplying(it)}
                      onDeleted={q.reload}
                    />
                  ),
                )}
              </View>
            ))
          )}

          <CreateItemForm
            familyId={familyId}
            defaultCategory={category !== '' ? category : undefined}
            onCreated={q.reload}
          />
        </>
      )}

      {applying !== null && (
        <ApplyToTripSheet item={applying} familyId={familyId} onClose={() => setApplying(null)} />
      )}
    </>
  );
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <Text className={`chip ${on ? 'chip--on' : 'chip--plain'}`} onClick={onClick}>
      {label}
    </Text>
  );
}

function StapleRow({
  item,
  onEdit,
  onApply,
  onDeleted,
}: {
  item: Item;
  onEdit: () => void;
  onApply: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const remove = useCallback(async () => {
    const res = await Taro.showModal({
      title: '删除常备物品',
      content: `确定删除「${item.name}」？已加入行程的打包项不受影响。`,
      confirmText: '删除',
      confirmColor: '#e5484d',
    });
    if (!res.confirm) return;
    setBusy(true);
    try {
      await api.deleteItem(item.id);
      onDeleted();
    } catch (e: unknown) {
      void Taro.showToast({ title: e instanceof Error ? e.message : '删除失败', icon: 'none' });
    } finally {
      setBusy(false);
    }
  }, [item.id, item.name, onDeleted]);

  return (
    <View className="item-row">
      <View className="item-row__body">
        <View className="item-row__name-line">
          <Text className="item-row__name">{item.name}</Text>
          {item.quantity > 1 ? <Text className="item-row__qty">×{item.quantity}</Text> : null}
        </View>
        {item.note ? <Text className="item-row__note">{item.note}</Text> : null}
      </View>
      <View className="item-row__ops">
        <Text className="cl-link" onClick={onApply}>
          加入行程
        </Text>
        <View className="icon-btn" onClick={onEdit}>
          <Icon name="edit" size={15} />
        </View>
        <View
          className={`icon-btn icon-btn--danger ${busy ? 'icon-btn--busy' : ''}`}
          onClick={busy ? undefined : () => void remove()}
        >
          <Icon name="trash" size={15} />
        </View>
      </View>
    </View>
  );
}

function EditRow({
  item,
  onCancel,
  onSaved,
}: {
  item: Item;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [category, setCategory] = useState(item.category ?? '');
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [note, setNote] = useState(item.note ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const save = useCallback(async () => {
    if (name.trim() === '') {
      setErr('物品名不能为空');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.updateItem(item.id, {
        version: item.version,
        name: name.trim(),
        category: category === '' ? null : category,
        quantity: Math.max(1, Math.min(9999, Number(quantity) || 1)),
        note: note.trim() === '' ? null : note.trim(),
      });
      onSaved();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [name, category, quantity, note, item.id, item.version, onSaved]);

  return (
    <View className="card item-edit">
      <View className="field">
        <Text className="field__label">物品名</Text>
        <Input className="input" value={name} onInput={(e) => setName(e.detail.value)} />
      </View>
      <View className="field">
        <Text className="field__label">分类</Text>
        <View className="filter-bar filter-bar--compact">
          {ITEM_CATEGORIES.map((c) => (
            <Chip
              key={c}
              label={c}
              on={category === c}
              onClick={() => setCategory(category === c ? '' : c)}
            />
          ))}
        </View>
      </View>
      <View className="field">
        <Text className="field__label">数量</Text>
        <Input
          className="input"
          type="number"
          value={quantity}
          onInput={(e) => setQuantity(e.detail.value)}
        />
      </View>
      <View className="field">
        <Text className="field__label">备注</Text>
        <Input className="input" value={note} onInput={(e) => setNote(e.detail.value)} />
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
      <View className="btn-row">
        <View className="btn btn--ghost" onClick={onCancel}>
          取消
        </View>
        <View
          className={`btn ${saving ? 'btn--busy' : ''}`}
          onClick={saving ? undefined : () => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </View>
      </View>
    </View>
  );
}

function CreateItemForm({
  familyId,
  defaultCategory,
  onCreated,
}: {
  familyId: string;
  defaultCategory?: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(defaultCategory ?? '');
  const [quantity, setQuantity] = useState('1');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const create = useCallback(async () => {
    if (name.trim() === '') {
      setErr('物品名不能为空');
      return;
    }
    if (familyId === '') {
      setErr('尚未加入家庭，无法保存常备物品');
      return;
    }
    setSaving(true);
    setErr('');
    try {
      await api.createItem({
        familyId,
        name: name.trim(),
        ...(category !== '' ? { category } : {}),
        quantity: Math.max(1, Math.min(9999, Number(quantity) || 1)),
        ...(note.trim() !== '' ? { note: note.trim() } : {}),
      });
      setName('');
      setQuantity('1');
      setNote('');
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '添加失败');
    } finally {
      setSaving(false);
    }
  }, [name, category, quantity, note, familyId, onCreated]);

  if (!open) {
    return (
      <View className="add-bar" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        <Text className="add-bar__text">添加常备物品</Text>
      </View>
    );
  }

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">添加常备物品</Text>
        <Text className="card__more" onClick={() => setOpen(false)}>
          取消
        </Text>
      </View>
      <View className="field">
        <Text className="field__label">物品名</Text>
        <Input
          className="input"
          value={name}
          onInput={(e) => setName(e.detail.value)}
          placeholder="如：身份证"
        />
      </View>
      <View className="field">
        <Text className="field__label">分类</Text>
        <View className="filter-bar filter-bar--compact">
          {ITEM_CATEGORIES.map((c) => (
            <Chip
              key={c}
              label={c}
              on={category === c}
              onClick={() => setCategory(category === c ? '' : c)}
            />
          ))}
        </View>
      </View>
      <View className="field">
        <Text className="field__label">数量</Text>
        <Input
          className="input"
          type="number"
          value={quantity}
          onInput={(e) => setQuantity(e.detail.value)}
        />
      </View>
      <View className="field">
        <Text className="field__label">备注</Text>
        <Input
          className="input"
          value={note}
          onInput={(e) => setNote(e.detail.value)}
          placeholder="如：每次出行必带"
        />
      </View>
      {err ? <Text className="form-error">{err}</Text> : null}
      <View
        className={`btn btn--block ${saving ? 'btn--busy' : ''}`}
        onClick={saving ? undefined : () => void create()}
      >
        {saving ? '添加中…' : '加入常备物品'}
      </View>
    </View>
  );
}

/** 选一次行程，把该常备物品写成那趟的打包项（kind=PACK） */
function ApplyToTripSheet({
  item,
  familyId,
  onClose,
}: {
  item: Item;
  familyId: string;
  onClose: () => void;
}) {
  const q = useAsync(
    useCallback(() => api.listTrips(familyId === '' ? undefined : familyId), [familyId]),
    [familyId],
  );
  const [busyId, setBusyId] = useState<string | null>(null);

  const apply = useCallback(
    async (trip: Trip) => {
      setBusyId(trip.id);
      try {
        await api.createChecklistItem({
          tripId: trip.id,
          familyId: trip.familyId,
          name: item.name,
          quantity: item.quantity,
          // 常备物品进的是「要带的东西」，不是待办
          kind: 'PACK',
        });
        void Taro.showToast({ title: `已加入「${trip.title}」的打包清单`, icon: 'none' });
        onClose();
      } catch (e: unknown) {
        void Taro.showToast({ title: e instanceof Error ? e.message : '加入失败', icon: 'none' });
      } finally {
        setBusyId(null);
      }
    },
    [item.name, item.quantity, onClose],
  );

  const trips = q.data ?? [];

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={onClose} />
      <View className="sheet">
        <View className="sheet__head">
          <Text className="sheet__title">把「{item.name}」加入</Text>
          <View className="sheet__close" onClick={onClose}>
            <Icon name="close" size={15} />
          </View>
        </View>
        {q.loading ? (
          <Loading text="读取行程…" />
        ) : q.error ? (
          <ErrorBox message={q.error} onRetry={q.reload} />
        ) : trips.length === 0 ? (
          <Empty text="还没有行程，先去「行程」建一个" />
        ) : (
          <View className="sheet__scroll">
            {trips.map((t) => (
              <View
                key={t.id}
                className="pick-row"
                onClick={busyId === null ? () => void apply(t) : undefined}
              >
                <View className="pick-row__body">
                  <Text className="pick-row__title">{t.title}</Text>
                  <Text className="pick-row__sub">
                    {t.startDate ?? '待定'} ~ {t.endDate ?? '待定'}
                  </Text>
                </View>
                <Text className="pick-row__go">{busyId === t.id ? '加入中…' : '加入'}</Text>
              </View>
            ))}
          </View>
        )}
        <Text className="sheet__hint">加进的是那趟行程的「要带的东西」，可在清单 tab 勾选</Text>
      </View>
    </View>
  );
}
