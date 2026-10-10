/**
 * 驱动选择（生产 / 测试分流）
 * ============================================================================
 * 为什么需要这个文件，而不是在 `buildApp()` 里直接 `new MemoryTableDriver()`：
 *
 *   🔴 `MemoryTableDriver` 是**内存实现**，进程重启数据全丢。
 *      如果生产环境因为「忘了传 driver」而静默跑内存驱动，现象是
 *      「服务起来了、接口都通、写进去也能读出来」—— 直到第一次重启才发现
 *      用户数据全没了。这是最不该发生、也最难在测试里发现的一类事故。
 *
 *   所以此处把「选取驱动」变成一次**显式决策**：
 *     · 有 `DATABASE_URL`              → PrismaTableDriver（生产路径）
 *     · 无 `DATABASE_URL` + 非生产      → MemoryTableDriver（开发/测试回退）
 *     · 无 `DATABASE_URL` + NODE_ENV=production → **拒绝启动**
 *
 *   与 M3 的 FX fail-fast 同源思路：坏配置不该活到第一个请求。
 */

import type { DriverTxRunner, TableDriver } from './table-client.js';
import { MemoryTableDriver } from './table-client.js';

/** 组合根需要的驱动形态：读写 + 事务 */
export type AppDriver = TableDriver & DriverTxRunner;

export interface ResolveDriverOptions {
  /** 显式注入（测试用）；给了就不再走环境判定 */
  driver?: AppDriver;
  /** 环境变量读取口，默认 `process.env` */
  env?: NodeJS.ProcessEnv;
  /**
   * 惰性构造 Prisma 驱动。
   *
   * 🔴 用回调而非直接 import：`@prisma/client` 体积大且需要已生成的客户端，
   *    开发/测试路径（内存驱动）不应被迫加载它。这里由调用方在需要时才引入。
   */
  createPrismaDriver?: () => AppDriver | Promise<AppDriver>;
}

export interface ResolvedDriver {
  driver: AppDriver;
  /** 实际选中的驱动种类，便于启动日志与健康检查暴露 */
  kind: 'prisma' | 'memory' | 'injected';
  /** 需要被优雅关闭时的回调（Prisma 要 disconnect） */
  shutdown?: () => Promise<void>;
}

/**
 * 选取驱动。
 *
 * ⚠️ 这是**唯一**决定「数据落在哪」的地方。任何绕过它的构造路径
 *    （例如直接 `new MemoryTableDriver()`）都会破坏上述 fail-fast 保证。
 */
export async function resolveAppDriver(options: ResolveDriverOptions = {}): Promise<ResolvedDriver> {
  if (options.driver !== undefined) {
    return { driver: options.driver, kind: 'injected' };
  }

  const env = options.env ?? process.env;
  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const databaseUrl = env['DATABASE_URL'];
  const hasDatabase = databaseUrl !== undefined && databaseUrl.trim().length > 0;

  if (hasDatabase) {
    if (options.createPrismaDriver === undefined) {
      // 有连接串但没给构造器：说明装配方漏了接线。宁可炸掉也不静默退回内存。
      throw new Error(
        '检测到 DATABASE_URL 但未提供 createPrismaDriver —— 拒绝静默退回内存驱动' +
          '（进程重启会丢数据）。请在组合根传入 createPrismaDriver。',
      );
    }
    const driver = await options.createPrismaDriver();
    return {
      driver,
      kind: 'prisma',
      shutdown: async () => {
        // 仅当驱动自身暴露了 disconnect（PrismaTableDriver 有）
        const maybe = driver as unknown as { disconnect?: () => Promise<void> };
        if (typeof maybe.disconnect === 'function') await maybe.disconnect();
      },
    };
  }

  // 无连接串：生产环境直接拒绝，其它环境回落内存
  if (nodeEnv === 'production') {
    throw new Error(
      'NODE_ENV=production 但缺少 DATABASE_URL —— 拒绝以内存驱动启动' +
        '（用户数据将无法持久化）。请配置 DATABASE_URL 后重启。',
    );
  }

  return { driver: new MemoryTableDriver(), kind: 'memory' };
}
