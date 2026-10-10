/**
 * 驱动选取（`resolveAppDriver`）测试
 * ============================================================================
 * 🔴 这里守的是**最有破坏性的一类事故**：
 *    生产环境静默跑起内存驱动 —— 服务正常、接口正常、读己写正常，
 *    直到进程重启，用户数据全部消失，且事前没有任何报错。
 *
 *    所以「生产缺 DATABASE_URL 必须拒绝启动」不是可选的健壮性增强，
 *    而是与 M3 汇率 fail-fast 同级的启动期硬约束。
 */

import { describe, expect, it, vi } from 'vitest';
import { resolveAppDriver } from './resolve-driver.js';
import { MemoryTableDriver } from './table-client.js';
import type { AppDriver } from './resolve-driver.js';

/** 造一个标记过的假 Prisma 驱动，便于断言「用的确实是它」 */
function fakePrismaDriver(): AppDriver {
  return new MemoryTableDriver();
}

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv => ({ ...over });

describe('resolveAppDriver · 显式注入优先', () => {
  it('传入 driver 时直接使用，且不做任何环境判定', async () => {
    const injected = new MemoryTableDriver();
    // 即便环境是 production 且无 DATABASE_URL，显式注入也不该被拦（测试需要）
    const r = await resolveAppDriver({
      driver: injected,
      env: env({ NODE_ENV: 'production' }),
    });

    expect(r.driver).toBe(injected);
    expect(r.kind).toBe('injected');
  });
});

describe('resolveAppDriver · 有 DATABASE_URL → Prisma', () => {
  it('选中 prisma 驱动并暴露 shutdown', async () => {
    const made = fakePrismaDriver();
    const r = await resolveAppDriver({
      env: env({ DATABASE_URL: 'mysql://u:p@h:3306/db', NODE_ENV: 'production' }),
      createPrismaDriver: () => made,
    });

    expect(r.driver).toBe(made);
    expect(r.kind).toBe('prisma');
    expect(typeof r.shutdown).toBe('function');
  });

  it('shutdown 会调用驱动的 disconnect', async () => {
    const disconnect = vi.fn(() => Promise.resolve());
    const made = Object.assign(fakePrismaDriver(), { disconnect });
    const r = await resolveAppDriver({
      env: env({ DATABASE_URL: 'mysql://u:p@h:3306/db' }),
      createPrismaDriver: () => made,
    });

    await r.shutdown!();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('驱动无 disconnect 时 shutdown 不报错（幂等）', async () => {
    const r = await resolveAppDriver({
      env: env({ DATABASE_URL: 'mysql://u:p@h:3306/db' }),
      createPrismaDriver: () => new MemoryTableDriver(),
    });

    await expect(r.shutdown!()).resolves.toBeUndefined();
  });

  it('🔴 有 DATABASE_URL 但未提供构造器 → 抛错，绝不静默退回内存', async () => {
    await expect(
      resolveAppDriver({ env: env({ DATABASE_URL: 'mysql://u:p@h:3306/db' }) }),
    ).rejects.toThrow(/拒绝静默退回内存驱动/);
  });

  it('空白 DATABASE_URL 不算「有连接串」', async () => {
    const r = await resolveAppDriver({
      env: env({ DATABASE_URL: '   ', NODE_ENV: 'development' }),
    });
    expect(r.kind).toBe('memory');
  });
});

describe('resolveAppDriver · 无 DATABASE_URL', () => {
  it('开发环境回落内存驱动', async () => {
    const r = await resolveAppDriver({ env: env({ NODE_ENV: 'development' }) });
    expect(r.kind).toBe('memory');
    expect(r.driver).toBeInstanceOf(MemoryTableDriver);
  });

  it('未设 NODE_ENV 视为开发，回落内存驱动', async () => {
    const r = await resolveAppDriver({ env: env({}) });
    expect(r.kind).toBe('memory');
  });

  it('test 环境回落内存驱动', async () => {
    const r = await resolveAppDriver({ env: env({ NODE_ENV: 'test' }) });
    expect(r.kind).toBe('memory');
  });

  it('🔴 生产环境缺 DATABASE_URL → 拒绝启动', async () => {
    await expect(resolveAppDriver({ env: env({ NODE_ENV: 'production' }) })).rejects.toThrow(
      /NODE_ENV=production 但缺少 DATABASE_URL/,
    );
  });
});
