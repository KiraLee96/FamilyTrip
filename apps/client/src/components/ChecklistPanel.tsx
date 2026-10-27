/**
 * 长期清单面板 —— 「家庭清单」+「我的清单」两套长期维护的东西
 * ============================================================================
 * 反馈 1.1 的落地：清单要能**长期维护**，且每个行程都能引用，
 * 引用之外还能为这次旅程临时加个性化物品（那部分在 TripDetailPage 的清单 tab）。
 *
 * 数据模型（对齐后端 checklistTemplate）：
 *   · SHARED   家庭共享清单 —— 家庭成员都看得见，谁引用都行
 *   · PERSONAL 我的私人清单 —— 只有本人（及其代管成员）可见
 * 一个人天然拥有这两套；同域可以有多套（如「家庭出行常用」「海边赶海专项」），
 * 后台模板表本来就支持多套，不做人为上限。
 *
 * 三条写路径：
 *   1. 新建（POST /checklists/templates，条目一次写入）—— 现在可用
 *   2. 引用到行程（POST /checklists/templates/apply，幂等）—— 现在可用
 *   3. 改条目 / 改名 / 删整套（PATCH / DELETE）—— 后端待补（派发单 P0-1/P0-2），
 *      未上线时按错误码翻译成人话提示，不做「点了没反应」的死按钮。
 */

import { useCallback, useMemo, useState } from 'react';
import { Input, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import type { ChecklistTemplate, ChecklistTemplateItem, Trip } from '../api/types';
import { Icon } from './Icon';
import { Empty, ErrorBox, Loading } from './Loading';
import { SectionTitle } from './shared';
import { useAsync } from '../hooks/useAsync';
import { parsePastedItems } from '../utils/checklistPaste';
import { ITEM_CATEGORIES, templateWriteUnavailableHint } from '../utils/constants';

type Scope = 'SHARED' | 'PERSONAL';

const UNCATEGORIZED = '未分类';

/** 给新条目挂类型；category 为空则**不带该字段**（不存空串分类） */
function withCategory(item: ChecklistTemplateItem, category: string): ChecklistTemplateItem {
  return category === '' ? item : { ...item, category };
}

/**
 * 按类型分组（2026-10-27 反馈④第二次）。
 * ============================================================================
 * 顺序：先 ITEM_CATEGORIES 的既定顺序，再自定义分类（按名称），「未分类」垫底。
 *
 * 🔴 返回的条目带 `idx`（原始 items 数组下标）：分组会打乱顺序，
 *    删除时若用分组内下标，删的会是另一条 —— 这类错删在清单里很难被发现。
 */
function groupByCategory(
  items: ChecklistTemplateItem[],
): Array<[string, Array<ChecklistTemplateItem & { idx: number }>]> {
  const map = new Map<string, Array<ChecklistTemplateItem & { idx: number }>>();
  items.forEach((it, idx) => {
    const key = it.category === undefined || it.category === '' ? UNCATEGORIZED : it.category;
    const arr = map.get(key);
    if (arr) arr.push({ ...it, idx });
    else map.set(key, [{ ...it, idx }]);
  });
  const rank = (k: string): number => {
    if (k === UNCATEGORIZED) return 999;
    const i = ITEM_CATEGORIES.indexOf(k as (typeof ITEM_CATEGORIES)[number]);
    return i >= 0 ? i : 100;
  };
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
}

export function ChecklistPanel({ familyId }: { familyId: string }) {
  const q = useAsync(
    useCallback(
      () => api.listChecklistTemplates(familyId === '' ? undefined : familyId),
      [familyId],
    ),
    [familyId],
  );
  /** 展开的模板 id（一次只展开一套，避免长列表滚成面条） */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 「引用到行程」的选行程弹层 */
  const [picking, setPicking] = useState<ChecklistTemplate | null>(null);

  Taro.useDidShow(() => {
    q.reload();
  });

  const all = q.data ?? [];
  const shared = useMemo(() => all.filter((t) => t.scope === 'SHARED'), [all]);
  const personal = useMemo(() => all.filter((t) => t.scope === 'PERSONAL'), [all]);

  if (q.loading) return <Loading text="读取清单…" />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  return (
    <>
      <View className="cl-intro card card--flush">
        <Text className="cl-intro__title">
          <Icon name="package" size={14} /> 常备物品：维护一次，每个行程都能引用
        </Text>
        <Text className="cl-intro__text">
          {
            '常备物品分两半：家庭常备全家可见、我的常备只有自己看得见。\n每一半里的条目按类型归类（证件 / 电子 / 衣物 / 洗护 / 药品 / 食品 / 母婴 / 其他）。'
          }
        </Text>
      </View>

      {/*
        2026-10-27 反馈④（第二次）：此前把「我的常备物品」做成了第三段并列，
        与「家庭清单 / 我的清单」平级 —— 用户的原话是「常备物品其实就应该包含
        家庭清单和我的清单」。故层改为：**常备物品（上位）→ 家庭常备 / 我的常备（两半）**。
        数据结构不变（同一张 checklist_template，scope 区分），只是不再有第二套模型。
      */}
      <SectionTitle icon="users">家庭常备 · 全家可见（{shared.length}）</SectionTitle>
      {shared.length === 0 ? (
        <Empty text="还没有家庭常备清单，下面新建一套" />
      ) : (
        shared.map((tpl) => (
          <TemplateCard
            key={tpl.id}
            template={tpl}
            open={openId === tpl.id}
            onToggle={() => setOpenId(openId === tpl.id ? null : tpl.id)}
            onChanged={q.reload}
            onApply={() => setPicking(tpl)}
          />
        ))
      )}

      <SectionTitle icon="user">我的常备 · 仅自己可见（{personal.length}）</SectionTitle>
      {personal.length === 0 ? (
        <Empty text="还没有私人常备清单，下面新建一套" />
      ) : (
        personal.map((tpl) => (
          <TemplateCard
            key={tpl.id}
            template={tpl}
            open={openId === tpl.id}
            onToggle={() => setOpenId(openId === tpl.id ? null : tpl.id)}
            onChanged={q.reload}
            onApply={() => setPicking(tpl)}
          />
        ))
      )}

      <CreateTemplateForm familyId={familyId} onCreated={q.reload} />

      {/*
        原「物品库」（item 表）不再作为并列的一段出现 —— 它是同一件事的第二套模型，
        正是"混乱"的来源。保留**一次性导入**：把旧物品库的东西倒进「我的常备」，
        导入后 item 表原行不动（可回滚；outfit_item 外键也不受影响）。
      */}
      <ImportLegacyItems familyId={familyId} personal={personal} onImported={q.reload} />

      {picking !== null && (
        <TripPickerSheet template={picking} familyId={familyId} onClose={() => setPicking(null)} />
      )}
    </>
  );
}

/** 单套清单卡片：折叠看概要，展开看条目 + 加条目 / 粘贴 / 引用 / 改名 / 删整套 */
function TemplateCard({
  template,
  open,
  onToggle,
  onChanged,
  onApply,
}: {
  template: ChecklistTemplate;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
  onApply: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(template.name);
  /** 新条目的类型（2026-10-27：条目按类型归类，新增/粘贴都落在这个类型下） */
  const [category, setCategory] = useState('');

  const items = template.items;

  /**
   * 改模板（名称 / 条目整体替换）。
   * ==========================================================================
   * 🔴 改条目时服务端会把变更同步到「引用过它、且尚未成行」的行程清单
   *    （已完成/已取消的行程不动，那是历史快照）。返回值里的 `synced`
   *    就是这次同步的影响面 —— 必须告诉用户，否则他改完模板完全不知道
   *    行程那边发生了什么，容易以为没生效而反复点。
   */
  const patch = useCallback(
    async (input: { name?: string; items?: ChecklistTemplateItem[] }) => {
      setBusy(true);
      setErr('');
      try {
        const r = await api.updateChecklistTemplate(template.id, {
          version: template.version,
          ...input,
        });
        onChanged();

        // 只改名字时没有 synced；改了条目才有
        const s = r.synced;
        if (s !== undefined) {
          if (s.trips === 0) {
            void Taro.showToast({ title: '已保存（暂无未成行的行程引用它）', icon: 'none' });
          } else {
            const parts: string[] = [];
            if (s.created > 0) parts.push(`新增 ${s.created}`);
            if (s.removed > 0) parts.push(`移除 ${s.removed}`);
            if (s.updated > 0) parts.push(`改数 ${s.updated}`);
            if (s.keptChecked > 0) parts.push(`保留已勾选 ${s.keptChecked}`);
            void Taro.showToast({
              title: `已同步 ${s.trips} 场未成行行程${parts.length > 0 ? `：${parts.join('、')}` : ''}`,
              icon: 'none',
              duration: 2600,
            });
          }
        }
        return true;
      } catch (e: unknown) {
        setErr(templateWriteUnavailableHint(e instanceof Error ? e.message : '修改失败'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [template.id, template.version, onChanged],
  );

  const addOne = useCallback(async () => {
    const text = draft.trim();
    if (text === '') return;
    // 允许「名称 x2」这种带数量的写法（与粘贴同一套解析规则）
    const parsed = parsePastedItems(text);
    if (parsed.length === 0) return;
    // 选中类型才落类型；没选 = 未分类（不猜，避免分类错乱比不分类更难查）
    const withCat = parsed.map((p) => withCategory(p, category));
    const ok = await patch({ items: [...items, ...withCat] });
    if (ok) setDraft('');
  }, [draft, items, patch, category]);

  const addPasted = useCallback(async () => {
    const parsed = parsePastedItems(pasteText);
    if (parsed.length === 0) {
      setErr('没识别到物品，一行写一个名字即可');
      return;
    }
    // 一整段粘贴默认归到当前选中的类型下，避免贴完再逐条补类型
    const withCat = parsed.map((p) => withCategory(p, category));
    const ok = await patch({ items: [...items, ...withCat] });
    if (ok) {
      setPasteText('');
      setPasting(false);
      void Taro.showToast({
        title:
          category === ''
            ? `已加入 ${parsed.length} 项（未分类）`
            : `已加入 ${category} ${parsed.length} 项`,
        icon: 'none',
      });
    }
  }, [pasteText, items, patch, category]);

  const removeItem = useCallback(
    async (idx: number) => {
      const next = items.filter((_, i) => i !== idx);
      await patch({ items: next });
    },
    [items, patch],
  );

  const removeAll = useCallback(() => {
    void Taro.showModal({
      title: '删除整套清单',
      content: `确定删除「${template.name}」？已引用到行程的物品不受影响。`,
      confirmText: '删除',
      confirmColor: '#e5484d',
    }).then(async (res) => {
      if (!res.confirm) return;
      setBusy(true);
      setErr('');
      try {
        await api.deleteChecklistTemplate(template.id);
        onChanged();
      } catch (e: unknown) {
        setErr(templateWriteUnavailableHint(e instanceof Error ? e.message : '删除失败'));
      } finally {
        setBusy(false);
      }
    });
  }, [template.id, template.name, onChanged]);

  return (
    <View className="card cl-card">
      <View className="cl-card__head" onClick={onToggle}>
        <View className="cl-card__title-wrap">
          <Text className="cl-card__name">{template.name}</Text>
          <Text className="cl-card__sub">
            {template.scope === 'SHARED' ? '家庭共享' : '仅自己可见'} · {items.length} 项
          </Text>
        </View>
        <Text className={`chev ${open ? 'rotate-180' : ''}`}>
          <Icon name="chevron-right" size={18} />
        </Text>
      </View>

      {open ? (
        <View className="cl-card__body">
          {items.length === 0 ? (
            <Text className="muted" style={{ display: 'block', padding: '4px 0 8px' }}>
              这套清单还是空的，下面加几项，或者直接粘贴一整段。
            </Text>
          ) : (
            /*
              条目按类型分组（2026-10-27 反馈④第二次）。
              此前是平铺一长串，几十件东西一眼看不出"还缺哪一类"；
              分组后每组带件数，缺什么类型一眼就看得见。
            */
            groupByCategory(items).map(([cat, list]) => (
              <View key={cat} className="cl-group">
                <Text className="cl-group__title">
                  {cat}
                  <Text className="cl-group__count">{list.length}</Text>
                </Text>
                {list.map((it) => (
                  <View className="cl-item" key={`${cat}-${it.name}-${it.idx}`}>
                    <Text className="cl-item__name">{it.name}</Text>
                    {it.quantity > 1 ? <Text className="cl-item__qty">×{it.quantity}</Text> : null}
                    <View
                      className="icon-btn icon-btn--danger"
                      onClick={busy ? undefined : () => void removeItem(it.idx)}
                    >
                      <Icon name="close" size={13} />
                    </View>
                  </View>
                ))}
              </View>
            ))
          )}

          {/* 新条目的类型：粘一段清单时也按这个类型落，避免一条条补 */}
          <View className="filter-bar filter-bar--compact" style={{ marginBottom: 6 }}>
            {ITEM_CATEGORIES.map((c) => (
              <Text
                key={c}
                className={`chip chip--tiny ${category === c ? 'chip--on' : 'chip--plain'}`}
                onClick={() => setCategory(category === c ? '' : c)}
              >
                {c}
              </Text>
            ))}
          </View>

          <View className="add-row">
            <Input
              className="add-row__input"
              value={draft}
              maxlength={64}
              onInput={(e) => setDraft(e.detail.value)}
              placeholder={
                category === ''
                  ? '加一项，如：防晒霜 x1（先选类型）'
                  : `加到「${category}」，如：防晒霜 x1`
              }
            />
            <View
              className={
                draft.trim() !== '' && !busy ? 'add-row__btn' : 'add-row__btn add-row__btn--off'
              }
              onClick={busy ? undefined : () => void addOne()}
            >
              <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>
                {busy ? '…' : '添加'}
              </Text>
            </View>
          </View>

          {pasting ? (
            <View className="cl-paste">
              <Textarea
                className="cl-paste__area"
                value={pasteText}
                maxlength={4000}
                onInput={(e) => setPasteText(e.detail.value)}
                placeholder={'一行一项，支持数量：\n身份证\n袜子 x3\n充电宝*2'}
              />
              <View className="btn-row">
                <View
                  className="btn btn--ghost"
                  onClick={() => {
                    setPasting(false);
                    setPasteText('');
                    setErr('');
                  }}
                >
                  取消
                </View>
                <View
                  className={`btn ${busy ? 'btn--busy' : ''}`}
                  onClick={busy ? undefined : () => void addPasted()}
                >
                  {busy ? '加入中…' : '粘贴加入'}
                </View>
              </View>
            </View>
          ) : (
            <View className="cl-links">
              <Text className="cl-link" onClick={() => setPasting(true)}>
                <Icon name="copy" size={13} /> 粘贴一段清单
              </Text>
              <Text className="cl-link" onClick={() => setRenaming((v) => !v)}>
                <Icon name="edit" size={13} /> 改名
              </Text>
              <Text className="cl-link cl-link--danger" onClick={busy ? undefined : removeAll}>
                <Icon name="trash" size={13} /> 删除整套
              </Text>
            </View>
          )}

          {renaming ? (
            <View className="add-row">
              <Input
                className="add-row__input"
                value={name}
                maxlength={64}
                onInput={(e) => setName(e.detail.value)}
                placeholder="清单名称"
              />
              <View
                className="add-row__btn"
                onClick={() => {
                  void patch({ name: name.trim() }).then((ok) => {
                    if (ok) setRenaming(false);
                  });
                }}
              >
                <Text style={{ color: '#fff', fontSize: 13.5, fontWeight: 550 }}>保存</Text>
              </View>
            </View>
          ) : null}

          {err ? <Text className="form-error">{err}</Text> : null}

          <View className="btn btn--block cl-card__apply" onClick={onApply}>
            <Icon name="route" size={14} /> 引用到某个行程
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** 选行程弹层 —— 把一套清单引用进某场行程（幂等：重复引用不会翻倍） */
function TripPickerSheet({
  template,
  familyId,
  onClose,
}: {
  template: ChecklistTemplate;
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
        const r = await api.applyChecklistTemplate({
          templateId: template.id,
          tripId: trip.id,
          familyId: trip.familyId,
        });
        void Taro.showToast({
          title: r.alreadyApplied
            ? `「${trip.title}」已经引用过这套清单`
            : `已加入 ${r.created} 项到「${trip.title}」`,
          icon: 'none',
        });
        onClose();
      } catch (e: unknown) {
        void Taro.showToast({ title: e instanceof Error ? e.message : '引用失败', icon: 'none' });
      } finally {
        setBusyId(null);
      }
    },
    [template.id, onClose],
  );

  const trips = q.data ?? [];

  return (
    <View className="sheet-root">
      <View className="sheet-mask" onClick={onClose} />
      <View className="sheet">
        <View className="sheet__head">
          <Text className="sheet__title">引用「{template.name}」到</Text>
          <View className="sheet__close" onClick={onClose}>
            <Icon name="close" size={15} />
          </View>
        </View>
        {q.loading ? (
          <Loading text="读取行程…" />
        ) : q.error ? (
          <ErrorBox message={q.error} onRetry={q.reload} />
        ) : trips.length === 0 ? (
          <Empty text="还没有行程，先去「行程」建一个再回来引用" />
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
                <Text className="pick-row__go">{busyId === t.id ? '引用中…' : '引用'}</Text>
              </View>
            ))}
          </View>
        )}
        <Text className="sheet__hint">引用后可在行程的「清单」tab 里勾选打包进度</Text>
      </View>
    </View>
  );
}

/** 新建一套清单 —— 名称 + 范围 + 可选粘贴条目（一次写入，无需后续 PATCH） */
function CreateTemplateForm({ familyId, onCreated }: { familyId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>('SHARED');
  const [name, setName] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const create = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setErr('给这套清单起个名字');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const items = parsePastedItems(pasteText);
      await api.createChecklistTemplate({
        ...(familyId !== '' ? { familyId } : {}),
        name: trimmed,
        scope,
        items,
      });
      setName('');
      setPasteText('');
      setOpen(false);
      onCreated();
      void Taro.showToast({ title: '清单已创建', icon: 'none' });
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }, [name, pasteText, scope, familyId, onCreated]);

  if (!open) {
    return (
      <View className="add-bar" onClick={() => setOpen(true)}>
        <Icon name="plus" size={16} />
        <Text className="add-bar__text">新建一套清单</Text>
      </View>
    );
  }

  return (
    <View className="card">
      <View className="card__head">
        <Text className="card__title">新建长期清单</Text>
        <Text className="card__more" onClick={() => setOpen(false)}>
          取消
        </Text>
      </View>

      <View className="field">
        <Text className="field__label">清单范围</Text>
        <View className="filter-bar filter-bar--compact">
          <Text
            className={`chip ${scope === 'SHARED' ? 'chip--on' : 'chip--plain'}`}
            onClick={() => setScope('SHARED')}
          >
            家庭共享
          </Text>
          <Text
            className={`chip ${scope === 'PERSONAL' ? 'chip--on' : 'chip--plain'}`}
            onClick={() => setScope('PERSONAL')}
          >
            仅我自己
          </Text>
        </View>
      </View>

      <View className="field">
        <Text className="field__label">名称</Text>
        <Input
          className="input"
          value={name}
          maxlength={64}
          onInput={(e) => setName(e.detail.value)}
          placeholder="如：家庭出行常用"
        />
      </View>

      <View className="field">
        <Text className="field__label">物品（可粘贴，一行一项）</Text>
        <Textarea
          className="cl-paste__area"
          value={pasteText}
          maxlength={4000}
          onInput={(e) => setPasteText(e.detail.value)}
          placeholder={'身份证\n充电宝 x2\n常备药\n雨伞'}
        />
      </View>

      {err ? <Text className="form-error">{err}</Text> : null}

      <View
        className={`btn btn--block ${busy ? 'btn--busy' : ''}`}
        onClick={busy ? undefined : () => void create()}
      >
        {busy ? '创建中…' : '创建清单'}
      </View>
    </View>
  );
}

/**
 * 旧「物品库」(item 表) 的一次性并入 —— 2026-10-27 反馈④第二次
 * ============================================================================
 * 为什么还留着这段：item 表是**第二套模型**（有 category、无 templateId），
 * 历史上在「物品库」页录过东西。现在 UI 不再给物品库入口，那些数据若直接消失，
 * 等于把用户录过的物品藏起来 —— 那是数据丢失，不是信息架构调整。
 *
 * 做法（全程可回滚）：
 *   · 只在**确实存在** item 行时才渲染，没有旧数据就完全不出现（不占版面）；
 *   · 点击后按 name 去重，「复制」进一套 PERSONAL 常备清单
 *     （已有同名「我的常备物品」优先，否则新建一套）；
 *   · **不删 item 行** —— outfit_item 外键仍引用它们，删了就回不去。
 */

/** 并入时的目标清单名（固定，便于重复点击时命中同一套而不是越建越多） */
const LEGACY_TARGET = '我的常备物品';

export function ImportLegacyItems({
  familyId,
  personal,
  onImported,
}: {
  familyId: string;
  /** 已有的「我的常备」套（用于挑选并入目标） */
  personal: ChecklistTemplate[];
  onImported: () => void;
}) {
  const q = useAsync(
    useCallback(() => api.listItems({ mineOnly: true }), []),
    [],
  );
  const [busy, setBusy] = useState(false);

  const items = q.data ?? [];

  // 没有旧数据 / 还在读 / 读失败 → 整块不渲染（这是历史包袱，不该占主界面）
  if (q.loading || q.error !== undefined || items.length === 0) return null;

  const run = (): void => {
    void Taro.showModal({
      title: '并入常备物品',
      content: `物品库里有 ${items.length} 件，会复制进「我的常备」（同名不重复加）。原物品库不删除。`,
      confirmText: '开始并入',
    }).then(async (res) => {
      if (!res.confirm) return;
      setBusy(true);
      try {
        // 目标清单：同名优先 → 否则第一套我的常备 → 都没有就新建
        let target = personal.find((t) => t.name === LEGACY_TARGET) ?? personal[0];
        if (target === undefined) {
          target = await api.createChecklistTemplate({
            ...(familyId !== '' ? { familyId } : {}),
            name: LEGACY_TARGET,
            scope: 'PERSONAL',
            items: [],
          });
        }

        const existing = target.items;
        const had = new Set(existing.map((i) => i.name));
        const add: ChecklistTemplateItem[] = items
          .filter((i) => !had.has(i.name))
          .map((i) => ({
            name: i.name,
            quantity: i.quantity,
            ...(i.category !== undefined ? { category: i.category } : {}),
          }));

        if (add.length === 0) {
          void Taro.showToast({ title: '物品库里的东西都已在常备清单里', icon: 'none' });
          onImported();
          return;
        }

        await api.updateChecklistTemplate(target.id, {
          version: target.version,
          items: [...existing, ...add],
        });
        void Taro.showToast({ title: `已并入 ${add.length} 项到「${target.name}」`, icon: 'none' });
        onImported();
      } catch (e: unknown) {
        void Taro.showToast({
          title: templateWriteUnavailableHint(e instanceof Error ? e.message : '并入失败'),
          icon: 'none',
        });
      } finally {
        setBusy(false);
      }
    });
  };

  return (
    <View className="card card--flush" style={{ marginTop: 12 }}>
      <View className="row-between" style={{ padding: '10px 14px' }}>
        <View>
          <Text style={{ fontSize: 12.5, fontWeight: 600 }}>还有旧物品库的数据</Text>
          <Text className="muted" style={{ fontSize: 11, display: 'block', marginTop: 2 }}>
            {items.length} 件（已不再单独维护），可一次性并入「我的常备」
          </Text>
        </View>
        <Text className="cl-link" onClick={busy ? undefined : run} style={{ flexShrink: 0 }}>
          {busy ? '并入中…' : '并入'}
        </Text>
      </View>
    </View>
  );
}
