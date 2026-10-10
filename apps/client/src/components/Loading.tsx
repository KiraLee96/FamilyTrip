/** 加载 / 空态 / 错误 三态展示 —— 所有页面共用 */

import { Icon } from './Icon';

export function Loading({ text = '加载中…' }: { text?: string }) {
  return (
    <div className="state state--loading">
      <span className="spinner" />
      <span>{text}</span>
    </div>
  );
}

export function Empty({ text = '这里还什么都没有' }: { text?: string }) {
  return (
    <div className="state state--empty">
      <Icon name="sparkles" size={30} />
      <span>{text}</span>
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error">
      <span>{message}</span>
      {onRetry && (
        <button type="button" className="btn btn--ghost" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
