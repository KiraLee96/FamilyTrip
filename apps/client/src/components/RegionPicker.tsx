/**
 * 地区选择器 —— 两级（省级行政区 → 城市）+ 关键词搜索 + 任意文本兜底
 * ============================================================================
 * 为什么自绘而不直接 `<Picker mode="region">`：
 *   · 该 mode 只在微信小程序端存在，H5 端没有等价实现，用它就等于双端行为分叉；
 *   · 目的地是「城市级」语义（去大理，不是去云南省），三级 picker 反而多一次点击。
 *
 * 三种取数路径，都收敛到同一个回调：
 *   1. 浏览：左栏点省 → 右栏点城市；
 *   2. 搜索：输入关键词 → 城市名命中的排前面（搜「大理」不会被整省结果盖住）；
 *   3. 兜底：搜不到就「用输入的原文」，用户永远不被内置数据表挡住。
 *
 * 数据源见 `utils/regions.ts`（内置常用目的地，非全量行政区划）。
 */

import { useMemo, useState } from 'react';
import { Input, ScrollView, Text, View } from '@tarojs/components';

import { Icon } from './Icon';
import { PROVINCES, citiesOf, provinceOfCity, searchRegions } from '../utils/regions';

export interface RegionSheetProps {
  title?: string;
  /** 已有目的地：用它定位默认省份 */
  initialCity?: string;
  onCancel: () => void;
  onConfirm: (city: string) => void;
}

export function RegionSheet({
  title = '选择地区',
  initialCity = '',
  onCancel,
  onConfirm,
}: RegionSheetProps) {
  const [province, setProvince] = useState<string>(() => {
    const hit = provinceOfCity(initialCity);
    return hit ?? PROVINCES[0] ?? '北京市';
  });
  const [kw, setKw] = useState('');

  const cities = useMemo(() => citiesOf(province), [province]);
  const hits = useMemo(() => searchRegions(kw), [kw]);
  const trimmed = kw.trim();
  const searching = trimmed !== '';

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

        <View className="region__search">
          <Icon name="map-pin" size={14} />
          <Input
            className="region__search-input"
            value={kw}
            placeholder="搜城市，如：大理 / 青岛"
            onInput={(e) => setKw(e.detail.value)}
          />
          {searching ? (
            <View className="region__search-clear" onClick={() => setKw('')}>
              <Icon name="close" size={12} />
            </View>
          ) : null}
        </View>

        {searching ? (
          <ScrollView scrollY className="sheet__scroll">
            {hits.length === 0 ? (
              <Text className="region__empty">内置列表里没有「{trimmed}」</Text>
            ) : null}
            <View className="region__row region__row--manual" onClick={() => onConfirm(trimmed)}>
              <Icon name="plus" size={14} />
              <Text className="region__row-text">用「{trimmed}」作为目的地</Text>
            </View>
            {hits.map((h) => (
              <View
                key={`${h.province}-${h.city}`}
                className="region__row"
                onClick={() => onConfirm(h.city)}
              >
                <Text className="region__row-text">{h.city}</Text>
                <Text className="region__row-sub">{h.province}</Text>
              </View>
            ))}
          </ScrollView>
        ) : (
          <View className="region__cols">
            <ScrollView scrollY className="sheet__scroll region__cols-prov">
              {PROVINCES.map((p) => (
                <View
                  key={p}
                  className={p === province ? 'region__prov region__prov--on' : 'region__prov'}
                  onClick={() => setProvince(p)}
                >
                  <Text className="region__prov-text">{p}</Text>
                </View>
              ))}
            </ScrollView>
            <ScrollView scrollY className="sheet__scroll region__cols-city">
              {cities.map((c) => (
                <View key={c} className="region__row" onClick={() => onConfirm(c)}>
                  <Text className="region__row-text">{c}</Text>
                  {c === initialCity ? (
                    <Icon name="check" size={13} className="region__row-check" />
                  ) : null}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        <Text className="sheet__hint">内置的是常用目的地；找不到就直接在搜索框里输入原文</Text>
      </View>
    </View>
  );
}

export default RegionSheet;
