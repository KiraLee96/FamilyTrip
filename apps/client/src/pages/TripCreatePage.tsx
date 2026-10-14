/**
 * 新建行程 —— 表单页（Taro 同构版）
 * ============================================================================
 * 契约：ApiClient.createTrip 与 Mock 均已就绪（对齐后端 POST /trips），
 *       本页只补 UI 层，不改任何接口签名。
 * familyId 来自 listFamilies（原型期单家庭）；日期用 Taro Picker，
 *       双端同构（H5 渲染为原生 date input）。
 */

import { useCallback, useState } from 'react';
import { Button, Input, Picker, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';

import { api } from '../api/index';
import { Icon } from '../components/Icon';
import { ErrorBox, Loading } from '../components/Loading';
import { PageLayout } from '../components/PageLayout';
import { navigate } from '../nav';
import { useAsync } from '../hooks/useAsync';
import { defaultChecklistFor } from '../utils/constants';

export function TripCreatePage() {
  const families = useAsync(
    useCallback(() => api.listFamilies(), []),
    [],
  );

  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  if (families.loading) return <Loading />;
  if (families.error) return <ErrorBox message={families.error} onRetry={families.reload} />;

  const familyId = families.data?.[0]?.id ?? '';

  const submit = async () => {
    const name = title.trim();
    if (!name) {
      setFormError('先给这次出行起个名字吧');
      return;
    }
    if (startDate && endDate && endDate < startDate) {
      setFormError('结束日期不能早于出发日期');
      return;
    }
    setFormError('');
    setSubmitting(true);
    try {
      const trip = await api.createTrip({
        familyId,
        title: name,
        ...(startDate ? { startDate } : {}),
        ...(endDate ? { endDate } : {}),
      });
      // 播种默认清单（反馈 #5：新行程不该沿用上一个清单）
      // 往返票 / 住宿（按天算晚数）/ 证件 / 充电 —— 失败不阻塞跳转
      try {
        await Promise.all(
          defaultChecklistFor(startDate || null, endDate || null).map((seed) =>
            api.createChecklistItem({
              tripId: trip.id,
              familyId,
              name: seed.title,
              scope: seed.scope,
            }),
          ),
        );
      } catch (e) {
        console.warn('[trip-create] 默认清单播种失败（不影响行程创建）：', e);
      }
      void Taro.showToast({ title: '已创建', icon: 'success' });
      navigate(`/trips/${trip.id}`);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '创建失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PageLayout title="新建行程" sub="起个草，慢慢安排">
      <View className="card">
        <View className="field">
          <Text className="field__label">行程名称</Text>
          <Input
            className="input"
            placeholder="比如：国庆 · 青岛看海"
            value={title}
            maxlength={40}
            onInput={(e) => setTitle(e.detail.value)}
          />
        </View>

        <View className="field">
          <Text className="field__label">出发日期</Text>
          <Picker mode="date" value={startDate} onChange={(e) => setStartDate(e.detail.value)}>
            <View className="picker-row">
              <Text
                className={startDate ? 'picker-row__val' : 'picker-row__val picker-row__val--empty'}
              >
                {startDate || '选择日期'}
              </Text>
              <Icon name="chevron-right" size={16} className="rotate-90 muted" />
            </View>
          </Picker>
        </View>

        <View className="field">
          <Text className="field__label">结束日期</Text>
          <Picker mode="date" value={endDate} onChange={(e) => setEndDate(e.detail.value)}>
            <View className="picker-row">
              <Text
                className={endDate ? 'picker-row__val' : 'picker-row__val picker-row__val--empty'}
              >
                {endDate || '选择日期'}
              </Text>
              <Icon name="chevron-right" size={16} className="rotate-90 muted" />
            </View>
          </Picker>
        </View>

        {formError ? <Text className="form-error">{formError}</Text> : null}

        <Button className="btn btn--block" disabled={submitting} onClick={() => void submit()}>
          {submitting ? '创建中…' : '创建行程'}
        </Button>
        <Text className="muted" style={{ marginTop: 10, textAlign: 'center' }}>
          创建后会带上往返票 / 住宿 / 证件等默认清单，可再补充日程与花销
        </Text>
      </View>
    </PageLayout>
  );
}

export default TripCreatePage;
