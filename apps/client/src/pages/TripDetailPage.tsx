/**
 * 行程详情 —— 按天时间轴 + 准备清单 + 花销
 * ============================================================================
 * 三个板块用标签页切换，避免长滚动：
 *   行程：按日期分组的时间轴（后端返回已按 date+sortOrder 排序）
 *   清单：共享清单，点一下即勾选（toggle 是幂等的单条切换）
 *   花销：总额 + 按人/按类目分布
 */

import { useCallback, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api } from '../api/index';
import type { ChecklistItem } from '../api/types';
import { Icon } from '../components/Icon';
import { Empty, ErrorBox, Loading } from '../components/Loading';
import { Progress, StatusChip, dateRange, shortDate, weekday } from '../components/shared';
import { useAsync } from '../hooks/useAsync';

type Tab = 'itinerary' | 'checklist' | 'expense';

export function TripDetailPage() {
  const { tripId = '' } = useParams();
  const [tab, setTab] = useState<Tab>('itinerary');

  const trip = useAsync(
    useCallback(() => api.getTrip(tripId), [tripId]),
    [tripId],
  );

  if (trip.loading) return <Loading />;
  if (trip.error) return <ErrorBox message={trip.error} onRetry={trip.reload} />;
  const t = trip.data!;

  return (
    <>
      <Link
        to="/trips"
        className="muted"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          marginBottom: 10,
          textDecoration: 'none',
        }}
      >
        <Icon name="chevron-right" size={14} className="rotate-180" />
        返回行程列表
      </Link>

      <div className="trip">
        <div className="trip__top">
          <div style={{ flex: 1 }}>
            <div className="trip__title">{t.title}</div>
            <div className="trip__meta">
              <span>
                <Icon name="calendar" size={14} />
                {dateRange(t)}
              </span>
              {t.timezone && (
                <span>
                  <Icon name="clock" size={14} />
                  {t.timezone}
                </span>
              )}
            </div>
          </div>
          <StatusChip status={t.status} />
        </div>
        {(t.destinations ?? []).length > 0 && (
          <div className="trip__dest">
            {(t.destinations ?? []).map((d) => (
              <span key={d.name} className="chip">
                <Icon name="map-pin" size={12} />
                {d.name}
              </span>
            ))}
          </div>
        )}
        <div className="muted" style={{ marginTop: 10 }}>
          版本 v{t.version} · CAS 乐观锁，更新需回传该值
        </div>
      </div>

      <div className="tabs">
        {(
          [
            ['itinerary', '行程'],
            ['checklist', '清单'],
            ['expense', '花销'],
          ] as Array<[Tab, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={tab === k ? 'tabs__btn tabs__btn--on' : 'tabs__btn'}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'itinerary' && <ItineraryTab tripId={tripId} />}
      {tab === 'checklist' && <ChecklistTab />}
      {tab === 'expense' && <ExpenseTab tripId={tripId} />}
    </>
  );
}

function ItineraryTab({ tripId }: { tripId: string }) {
  const q = useAsync(
    useCallback(() => api.listItineraries(tripId), [tripId]),
    [tripId],
  );
  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;
  const items = q.data ?? [];
  if (items.length === 0) return <Empty text="还没有安排，先加一条吧" />;

  const dates = [...new Set(items.map((i) => i.date))].sort();

  return (
    <>
      {dates.map((d) => {
        const dayItems = items.filter((i) => i.date === d);
        return (
          <div className="day" key={d}>
            <div className="day__head">
              {shortDate(d)} {weekday(d)}
              <span className="day__date">{dayItems.length} 项安排</span>
            </div>
            <div className="tl">
              {dayItems.map((it) => (
                <div className="tl__row" key={it.id}>
                  <div className="tl__rail">
                    <span className="tl__dot" />
                    <span className="tl__line" />
                  </div>
                  <div className="tl__card">
                    {it.startTime && (
                      <div className="tl__time">
                        <Icon name="clock" size={13} />
                        {it.startTime}
                      </div>
                    )}
                    <div className="tl__title">{it.title}</div>
                    {it.location && (
                      <div className="tl__loc">
                        <Icon name="map-pin" size={13} />
                        {it.location}
                      </div>
                    )}
                    {it.note && <div className="tl__note">{it.note}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ChecklistTab() {
  const q = useAsync(
    useCallback(() => api.listChecklist(), []),
    [],
  );
  const [local, setLocal] = useState<Record<string, ChecklistItem>>({});

  if (q.loading) return <Loading />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;

  const list = (q.data ?? []).map((c) => local[c.id] ?? c);
  const shared = list.filter((c) => c.scope === 'SHARED');
  const personal = list.filter((c) => c.scope === 'PERSONAL');
  const done = list.filter((c) => c.done).length;

  const toggle = async (id: string) => {
    try {
      const next = await api.toggleChecklistItem(id);
      setLocal((m) => ({ ...m, [id]: next }));
    } catch {
      /* 忽略：保持服务端状态 */
    }
  };

  return (
    <>
      <Progress done={done} total={list.length} label="整体准备度" />

      {shared.length > 0 && (
        <div className="card card--flush" style={{ marginTop: 12 }}>
          <RowLabel>共享清单</RowLabel>
          {shared.map((c) => (
            <CheckRow key={c.id} item={c} onToggle={(id) => void toggle(id)} />
          ))}
        </div>
      )}

      {personal.length > 0 && (
        <div className="card card--flush">
          <RowLabel>我的清单</RowLabel>
          {personal.map((c) => (
            <CheckRow key={c.id} item={c} onToggle={(id) => void toggle(id)} />
          ))}
        </div>
      )}
    </>
  );
}

function RowLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="muted" style={{ padding: '10px 14px 6px', fontSize: 11.5, fontWeight: 600 }}>
      {children}
    </div>
  );
}

function CheckRow({ item, onToggle }: { item: ChecklistItem; onToggle: (id: string) => void }) {
  return (
    <button
      type="button"
      className={item.done ? 'check check--done' : 'check'}
      onClick={() => onToggle(item.id)}
    >
      <span className="check__box">
        <Icon name={item.done ? 'check' : 'circle'} size={19} />
      </span>
      <span className="check__text">{item.title}</span>
      {item.assigneeName && <span className="check__who">{item.assigneeName}</span>}
    </button>
  );
}

function ExpenseTab({ tripId }: { tripId: string }) {
  const list = useAsync(
    useCallback(() => api.listExpenses(tripId), [tripId]),
    [tripId],
  );
  const sum = useAsync(
    useCallback(() => api.expenseSummary(tripId), [tripId]),
    [tripId],
  );

  if (list.loading || sum.loading) return <Loading />;
  if (list.error) return <ErrorBox message={list.error} onRetry={list.reload} />;

  const items = list.data ?? [];
  const s = sum.data;

  const maxMember = Math.max(...(s?.byMember ?? []).map((m) => Number(m.amountCny)), 1);
  const maxCat = Math.max(...(s?.byCategory ?? []).map((m) => Number(m.amountCny)), 1);

  return (
    <>
      <div className="card">
        <div className="money__total">
          <div className="money__num">
            <small>¥</small>
            {s?.totalCny ?? '0.00'}
          </div>
          <div className="money__cap">本次出行合计（人民币折算）</div>
        </div>

        <div className="section-title" style={{ margin: '0 0 9px' }}>
          按人
        </div>
        <div className="bars">
          {(s?.byMember ?? []).map((m) => (
            <div className="bar__row" key={m.memberName}>
              <span className="bar__name">{m.memberName}</span>
              <span className="bar__track">
                <span
                  className="bar__fill"
                  style={{ width: `${(Number(m.amountCny) / maxMember) * 100}%` }}
                />
              </span>
              <span className="bar__val">¥{m.amountCny}</span>
            </div>
          ))}
        </div>

        <div className="section-title" style={{ margin: '16px 0 9px' }}>
          按类目
        </div>
        <div className="bars">
          {(s?.byCategory ?? []).map((m) => (
            <div className="bar__row" key={m.category}>
              <span className="bar__name">{m.category}</span>
              <span className="bar__track">
                <span
                  className="bar__fill"
                  style={{ width: `${(Number(m.amountCny) / maxCat) * 100}%` }}
                />
              </span>
              <span className="bar__val">¥{m.amountCny}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="section-title">明细（{items.length} 笔）</div>
      <div className="card card--flush">
        {items.map((e) => (
          <div className="exp" key={e.id}>
            <span className="exp__icon">
              <Icon name="wallet" size={17} />
            </span>
            <div className="exp__body">
              <div className="exp__title">{e.title}</div>
              <div className="exp__sub">
                {e.payerName} · {shortDate(e.spentAt)}
                {e.category ? ` · ${e.category}` : ''}
              </div>
            </div>
            <div className="exp__amt">¥{e.amount}</div>
          </div>
        ))}
      </div>
    </>
  );
}
