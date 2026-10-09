import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadAuthorizedSources } from './common/fx/rate-tier.js';
import { assertFxSourceConfigured } from './common/fx/source-guard.js';

/**
 * 启动期 M3 fail-fast：生产环境未配置合规授权汇率源则拒绝启动。
 * 逻辑委派给 common/fx，确保与单测同源（派发单 §3.2）。
 */
function guardFxSource(): void {
  // 先从环境变量装载授权源白名单（FX_AUTHORIZED_SOURCES）
  loadAuthorizedSources(process.env);
  // 生产环境无合规源 → 抛 FxSourceMisconfiguredError，进程启动失败
  // 开发环境无源 → 回落占位源（devFallbackSource），不阻断自测
  assertFxSourceConfigured({
    nodeEnv: process.env.NODE_ENV ?? 'development',
    sources: [], // 授权源待 v1.4 接入；此处不写死任何源名（红线 R7）
  });
}

async function bootstrap(): Promise<void> {
  guardFxSource();

  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`family-trip server listening on :${port}`);
}

bootstrap().catch((err: unknown) => {
  console.error('bootstrap failed', err);
  process.exit(1);
});
