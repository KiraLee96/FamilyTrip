import { describe, expect, it, vi } from 'vitest';
import {
  FORBIDDEN_IN_TX,
  TxQuotaExceededError,
  isTxQuotaExceeded,
  withTransaction,
  type TxContext,
  type TxRunner,
} from './transaction.js';

/** 简单内存事务执行器：成功即返回，失败原样抛出 */
function makeRunner(): { runner: TxRunner; calls: () => number } {
  const state = { calls: 0 };
  const runner: TxRunner = async <T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> => {
    state.calls += 1;
    return fn({ client: { kind: 'in-memory' } });
  };
  return { runner, calls: () => state.calls };
}

describe('transaction · isTxQuotaExceeded', () => {
  it('识别显式 TxQuotaExceededError', () => {
    expect(isTxQuotaExceeded(new TxQuotaExceededError())).toBe(true);
  });

  it('识别超限文案（too many / transaction limit / 1205 / 1213）', () => {
    expect(isTxQuotaExceeded(new Error('too many queries in a single transaction'))).toBe(true);
    expect(isTxQuotaExceeded(new Error('transaction limit exceeded'))).toBe(true);
    expect(isTxQuotaExceeded(new Error('ER_LOCK_WAIT_TIMEOUT 1205'))).toBe(true);
    expect(isTxQuotaExceeded(new Error('deadlock 1213'))).toBe(true);
  });

  it('普通错误不误判', () => {
    expect(isTxQuotaExceeded(new Error('connection refused'))).toBe(false);
    expect(isTxQuotaExceeded('boom')).toBe(false);
  });
});

describe('transaction · withTransaction 正常路径', () => {
  it('直接返回事务体结果', async () => {
    const r = makeRunner();
    const out = await withTransaction(r.runner, async (ctx) => {
      expect(ctx.client).toBeDefined();
      return 42;
    });
    expect(out).toBe(42);
    expect(r.calls()).toBe(1);
  });

  it('非超限错误原样抛出、不降级', async () => {
    const r = makeRunner();
    const onDegrade = {
      singleShot: vi.fn(),
      reconcile: vi.fn(),
    };
    await expect(
      withTransaction(
        r.runner,
        async () => {
          throw new Error('unrelated');
        },
        onDegrade,
      ),
    ).rejects.toThrow('unrelated');
    expect(onDegrade.singleShot).not.toHaveBeenCalled();
    expect(onDegrade.reconcile).not.toHaveBeenCalled();
  });
});

describe('transaction · withTransaction 降级（单笔事务 + reconcile）', () => {
  it('命中 5005 → 走 singleShot 并 reconcile', async () => {
    // 第 1 次调用（整体事务）抛超限；第 2 次（单笔）成功
    let calls = 0;
    const runner: TxRunner = async <T>(fn: (ctx: TxContext) => Promise<T>): Promise<T> => {
      calls += 1;
      if (calls === 1) throw new TxQuotaExceededError();
      return fn({ client: { kind: 'in-memory' } });
    };
    const reconciled: unknown[] = [];

    const out = await withTransaction<string>(runner, async () => 'big-tx', {
      singleShot: async () => 'single-shot',
      reconcile: async (res) => {
        reconciled.push(res);
      },
    });

    expect(out).toBe('single-shot');
    expect(calls).toBe(2);
    expect(reconciled).toEqual(['single-shot']);
  });

  it('命中 5005 但未提供 onDegrade → 直接抛错', async () => {
    const runner: TxRunner = async () => {
      throw new TxQuotaExceededError();
    };
    await expect(withTransaction(runner, async () => 1)).rejects.toBeInstanceOf(
      TxQuotaExceededError,
    );
  });
});

describe('transaction · 事务内禁止副作用清单存在', () => {
  it('FORBIDDEN_IN_TX 覆盖红线项', () => {
    expect(FORBIDDEN_IN_TX.length).toBeGreaterThan(0);
    expect(FORBIDDEN_IN_TX.join(' ')).toMatch(/汇率|KMS|COS/);
  });
});
