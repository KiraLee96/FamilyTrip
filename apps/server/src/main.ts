import './common/env/load-env.js'; // 🔴 必须在读取 process.env 的模块之前最先执行
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadAuthorizedSources } from './common/fx/rate-tier.js';
import { assertFxSourceConfigured } from './common/fx/source-guard.js';
import { installAppDriver } from './composition-root.js';
import { resolveAppDriver } from './common/db/resolve-driver.js';
import type { AppDriver } from './common/db/resolve-driver.js';

/**
 * 启动期 M3 fail-fast：生产环境未配置合规授权汇率源则拒绝启动。
 * 逻辑委派给 common/fx，确保与单测同源（派发单 §3.2）。
 *
 * 🔴 关于 `sources: []`：
 *    本期采购决策为「不采购」，故**尚未**注入任何真实汇率源，此处的空数组
 *    会让生产环境按设计拒绝启动（派发单 §3.2 明确要求该分支现在就合）。
 *    授权源接入后，在此把实例传进来即可 —— 白名单仍由
 *    `FX_AUTHORIZED_SOURCES` 环境变量控制，代码中不硬编码源名（红线 R7）。
 *
 * ⚠️ 因此：**当前代码在生产环境无法启动是预期行为**，不是缺陷。
 *    切勿为了「让它起来」而删掉本守卫或填一个假源。
 */
function guardFxSource(): void {
  // 先从环境变量装载授权源白名单（FX_AUTHORIZED_SOURCES）
  loadAuthorizedSources(process.env);
  // 生产环境无合规源 → 抛 FxSourceMisconfiguredError，进程启动失败
  // 开发环境无源 → 回落占位源（devFallbackSource），不阻断自测
  assertFxSourceConfigured({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    sources: [], // ⛔ 授权源待接入；此处不写死任何源名（红线 R7）
  });
}

/**
 * 惰性构造 Prisma 驱动。
 *
 * 🔴 用动态 import 而非顶层 import：
 *    `@prisma/client` 需要已 `prisma generate`（并绑定查询引擎二进制），
 *    开发/测试（走内存驱动）不应被迫加载它。生产有连接串时才引入。
 */
async function createPrismaDriver(): Promise<AppDriver> {
  const [{ PrismaClient }, { PrismaTableDriver }] = await Promise.all([
    import('@prisma/client'),
    import('./common/db/prisma-table-driver.js'),
  ]);
  return new PrismaTableDriver(new PrismaClient());
}

/**
 * 启动期装驱动。
 *
 * 🔴 必须在 `NestFactory.create(AppModule)` **之前**完成：
 *    `CompositionModule` 的 `useFactory: () => buildApp()` 会在容器实例化时
 *    立即调用 `buildApp()`。若那时驱动尚未登记，就会静默用上内存驱动
 *    ——「服务能起、接口能通」，直到重启才发现数据全丢。
 */
async function installDriver(): Promise<void> {
  const env = process.env;
  const databaseUrl = env['DATABASE_URL'];
  const hasDatabase = databaseUrl !== undefined && databaseUrl.trim().length > 0;

  const resolved = await resolveAppDriver({
    env,
    ...(hasDatabase ? { createPrismaDriver } : {}),
  });

  installAppDriver(resolved.driver);
  console.log(`[family-trip] data driver: ${resolved.kind}`);

  if (resolved.shutdown !== undefined) {
    const shutdown = resolved.shutdown;
    const close = (): void => {
      void shutdown()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  }
}

async function bootstrap(): Promise<void> {
  guardFxSource();
  await installDriver();

  const app = await NestFactory.create(AppModule);

  // CORS：放行 H5 预览等前端 origin（联调期可设 CORS_ORIGIN=* 放开全部）。
  // 注意：前端走 Authorization 头，故 credentials 必须与具体 origin 配合（* 时自动关闭）。
  const corsOrigins = (process.env['CORS_ORIGIN'] ?? 'http://127.0.0.1:5199')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const allowAll = corsOrigins.includes('*');
  app.enableCors({
    origin: allowAll ? '*' : corsOrigins,
    credentials: !allowAll,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`family-trip server listening on :${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('bootstrap failed', err);
  process.exit(1);
});
