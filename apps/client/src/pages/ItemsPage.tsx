/**
 * 物品页 —— 个人物品库（PRIVATE 域）
 * ============================================================================
 * 反馈 #2：缺少物品管理。每次必带物品（证件/充电/常备药）按分类整理，随取随用。
 *
 * 能力：分类筛选（分组展示）+ 增 / 删 / 改（改走 E7 CAS，version 原样回传）。
 * 数据源：api.listItems / createItem / updateItem / deleteItem（Mock 与真后端同形）。
 */

import { useCallback, useMemo, useState } from 'react';
import { Text, View, Input } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { Item } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { SectionTitle } from '../components/shared';
import { useAsync } from '../hooks/useAsync';
import { ITEM_CATEGORIES } from '../utils/constants';

const UNCATEGORIZED = '未分类';

export function ItemsPage() {
  // category === '' 表示「全部」
  const [category, setCategory] = useState('');
  const [mineOnly, setMineOnly] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const q = useAsync(
    useCallback(async () => {
      const [families, items] = await Promise.all([
        api.listFamilies(),
        api.listItems({ ...(category !== '' ? { category } : {}), mineOnly }),
      ]);
      return { familyId: families[0]?.id ?? '', items };
    }, [category, mineOnly]),
    [category, mineOnly],
  );

  Taro.useDidShow(() => {
    q.reload();
  });

  const items = q.data?.items ?? [];
  const familyId = q.data?.familyId ?? '';

  // 按分类分组（保持 ITEM_CATEGORIES 顺序，未分类垫底）
  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const key = it.category ?? UNCATEGORIZED;
      const arr = map.get(key);
      if (arr) arr.push(it);
      else map.set(key, [it]);
    }
    const order = [...ITEM_CATEGORIES, UNCATEGORIZED];
    return [...map.entries()].sort((a, b) => {
      const ia = order.indexOf(a[0]);
      const ib = order.indexOf(b[0]);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [items]);

  return (
    <PageLayout title="物品" sub="每次出门，该带的都在这儿" badge={`${items.length} 件`}>
      <View className="filter-bar">
        <Chip label="全部" on={category === ''} onClick={() => setCategory('')} />
        {ITEM_CATEGORIES.map((c) => (
          <Chip key={c} label={c} on={category === c} onClick={() => setCategory(c)} />
        ))}
      </View>

      <View className="row-between items-scope">
        <Text className="muted">{mineOnly ? '只看我的物品' : '含我代管的家人物品'}</Text>
        <View
          className={`switch ${mineOnly ? 'switch--on' : ''}`}
          onClick={() => setMineOnly((v) => !v)}
        >
          <View className="switch__knob" />
        </View>
      </View>

      {q.loading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox message={q.error} onRetry={q.reload} />
      ) : (
        <>
          {items.length === 0 ? (
            <Empty text="这个分类还没有物品，下面添加吧" />
          ) : (
            groups.map(([cat, list]) => (
              <View key={cat}>
                <SectionTitle icon="package">
                  {cat}（{list.length}）
                </SectionTitle>
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
                    <ItemRow
                      key={it.id}
                      item={it}
                      onEdit={() => setEditingId(it.id)}
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
    </PageLayout>
  );
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <Text className={`chip ${on ? 'chip--on' : 'chip--plain'}`} onClick={onClick}>
      {label}
    </Text>
  );
}

function ItemRow({
  item,
  onEdit,
  onDeleted,
}: {
  item: Item;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const remove = useCallback(async () => {
    const res = await Taro.showModal({
      title: '删除物品',
      content: `确定删除「${item.name}」？`,
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
        <View className="icon-btn" onClick={onEdit}>
          <Icon name="edit" size={16} />
        </View>
        <View
          className={`icon-btn icon-btn--danger ${busy ? 'icon-btn--busy' : ''}`}
          onClick={busy ? undefined : () => void remove()}
        >
          <Icon name="trash" size={16} />
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
          placeholder="1"
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

  const reset = useCallback(() => {
    setName('');
    setCategory(defaultCategory ?? '');
    setQuantity('1');
    setNote('');
    setErr('');
  }, [defaultCategory]);

  const create = useCallback(async () => {
    if (name.trim() === '') {
      setErr('物品名不能为空');
      return;
    }
    if (familyId === '') {
      setErr('尚未加入家庭，无法添加物品');
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
      reset();
      setOpen(false);
      onCreated();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '添加失败');
    } finally {
      setSaving(false);
    }
  }, [name, category, quantity, note, familyId, reset, onCreated]);

  if (!open) {
    return (
      <View className="add-bar" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        <Text className="add-bar__text">添加物品</Text>
      </View>
    );
  }

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">添加物品</Text>
        <Text
          className="card__more"
          onClick={() => {
            reset();
            setOpen(false);
          }}
        >
          取消
        </Text>
      </View>
      <View className="field">
        <Text className="field__label">物品名</Text>
        <Input
          className="input"
          value={name}
          onInput={(e) => setName(e.detail.value)}
          placeholder="如：护照"
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
          placeholder="1"
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
        {saving ? '添加中…' : '添加到物品库'}
      </View>
    </View>
  );
}

export default ItemsPage;
