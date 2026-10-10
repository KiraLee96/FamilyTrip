/**
 * 通用数据获取 hook
 * ============================================================================
 * 把「加载中 / 出错 / 有数据」三态收敛到一处，页面只管渲染。
 * 依赖 fn 的稳定引用：调用方请用 useCallback 包一层，或传入基础类型参数。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/index';

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [tick, setTick] = useState(0);

  // fn 每次渲染都是新函数，这里刻意只用 deps 控制重跑时机
  //（项目未装 eslint-plugin-react-hooks，规则名不存在会报错，故用泛化 disable）

  const run = useCallback(fn, deps);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(undefined);
    run()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? `${e.message}（code ${e.code}）` : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [run, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  return { data, loading, error, reload };
}
