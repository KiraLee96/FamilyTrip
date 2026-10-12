/** 加载 / 空态 / 错误 三态展示 —— 所有页面共用（Taro 同构版） */

import { Text, View } from '@tarojs/components';

import { Icon } from './Icon';

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <View className="state state--loading">
      <View className="spinner" />
      <Text>{text}</Text>
    </View>
  );
}

export function Empty({ text = '这里还什么都没有' }: { text?: string }) {
  return (
    <View className="state state--empty">
      <Icon name="sparkles" size={30} />
      <Text>{text}</Text>
    </View>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View className="state state--error">
      <Text>{message}</Text>
      {onRetry && (
        <View className="btn btn--ghost" onClick={onRetry}>
          重试
        </View>
      )}
    </View>
  );
}
