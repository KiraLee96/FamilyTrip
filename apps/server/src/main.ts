import './common/env/load-env.js'; // 🔴 必须在读取 process.env 的模块之前最先执行
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadAuthorizedSources } from './common/fx/rate-tier.js';
import { assertFxSourceConfigured } from './common/fx/source-guard.js';
import {
  installAppDriver,
  installFxSource,
  installWechatExchanger,
  installTokenSecret,
  DEFAULT_DEV_SECRET,
} from './composition-root.js';
import { resolveFxSource } from './common/fx/sources/index.js';
import { resolveAppDriver } from './common/db/resolve-driver.js';
import { resolveWechatExchanger } from './domains/auth/wechat-jscode2session.js';
import { bigintSafeReplacer } from './common/envelope/envelope.js';
import type { AppDriver } from './common/db/resolve-driver.js';

/**
 * 启动期 M3 fail-fast：生产环境未配置合规授权汇率源则拒绝启动。
 * 逻辑委派给 common/fx，确保与单测同源（派发单 §3.2）。
 *
 * 🔴 汇率源策略（resolveFxSource 单一入口，三期路线）：
 *    开发/预览 → PublicRateSource（公开中间价，仅 dev）
 *    生产初期 → ManualRateSource（银行牌价人工录入，0 采购成本）
 *    规模化后 → 签约 API 适配器（同接口，域代码零改动）
 *
 * ⚠️ 生产返回 ManualRateSource **不等于**放行：其名仍须显式出现在
 *    FX_AUTHORIZED_SOURCES，否则照常拒绝启动 —— 启用人工录入路径必须是
 *    一次显式的运维决策。切勿为了「让它起来」删守卫或填假源。
 */
function guardFxSource(): void {
  const nodeEnv = process.env['NODE_ENV'] ?? 'development';

  // 按环境解析汇率源（生产恒不给公开源 —— 红线 R7 不让它靠近生产）
  const source = resolveFxSource(process.env);

  // 开发便利：本地没配白名单时，自动把公开源名补进去。
  // ⛔ 只在非生产做 —— 生产白名单必须由部署环境显式声明，不能由代码兜底。
  if (source !== undefined && nodeEnv !== 'production') {
    const configured = (process.env['FX_AUTHORIZED_SOURCES'] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!configured.includes(source.name)) {
      process.env['FX_AUTHORIZED_SOURCES'] = [...configured, source.name].join(',');
      console.warn(
        `[family-trip] 已自动登记开发汇率源 "${source.name}"（仅非生产；生产须显式配置 FX_AUTHORIZED_SOURCES）`,
      );
    }
  }

  // 先装载白名单，再登记源，最后交给 fail-fast 裁决
  loadAuthorizedSources(process.env);
  installFxSource(source);

  // 生产环境无合规源 → 抛 FxSourceMisconfiguredError，进程启动失败
  // 开发环境无源 → 回落占位源（devFallbackSource），不阻断自测
  assertFxSourceConfigured({
    nodeEnv,
    sources: source !== undefined ? [source] : [],
  });
}

/**
 * JWT 签名密钥选取（与 resolveWechatExchanger 同族的生产 fail-fast）。
 *
 * 🔴 `DEFAULT_DEV_SECRET` 是源码里的公开常量，生产用它等于允许任何人
 *    伪造任意用户的令牌 —— 缺配置必须拒绝启动，而不是"先跑起来再说"。
 */
function resolveTokenSecret(env: NodeJS.ProcessEnv): string {
  const secret = env['JWT_SECRET']?.trim();
  if (secret === undefined || secret === '') {
    if ((env['NODE_ENV'] ?? 'development') === 'production') {
      throw new Error(
        'NODE_ENV=production 但缺少 JWT_SECRET —— 拒绝以开发默认密钥启动' +
          '（公开默认密钥允许伪造任意用户令牌）。请配置强随机密钥后重启。',
      );
    }
    return DEFAULT_DEV_SECRET;
  }
  return secret;
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

  // 微信登录 exchanger：生产必须接真实 jscode2session（缺配置拒绝启动）；
  // 开发/测试由 resolveWechatExchanger 返回 undefined → 组合根回落 stubWechat。
  installWechatExchanger(resolveWechatExchanger(process.env));

  // JWT 签名密钥：生产必须显式配置（开发默认密钥是公开常量，生产不可用）。
  installTokenSecret(resolveTokenSecret(process.env));

  const app = await NestFactory.create(AppModule);

  // 🔴 BigInt 安全出口（派发单 D-2026-10-15-02 P0-B）：
  // 各域白名单万一漏列某个 BigInt 列，真库下 res.json() 会抛 TypeError →
  // 500 且丢信封。装上 replacer 后最坏退化为「多一个字符串字段」，不会丢信封。
  // 必须在此处（而非 controller）装配：controller 的契约是「除转发外无第二个分支」。
  const http = app.getHttpAdapter().getInstance() as {
    set: (key: string, value: unknown) => unknown;
  };
  http.set('json replacer', bigintSafeReplacer);

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
