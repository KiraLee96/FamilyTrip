import { Global, Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { HttpAdapterController } from './http/http-adapter.controller.js';
import { buildApp, type BuiltApp } from './composition-root.js';

/**
 * 组合根的 NestJS 容器封装。
 *
 * 为什么用 `useFactory` 而不是 `useValue`：
 *   `buildApp()` 里含启动期断言（权限矩阵 78 格、FX 授权源 fail-fast、
 *   路由唯一性）。让容器在**实例化时**调用它，断言失败即启动失败 ——
 *   这正是我们要的：坏配置不应该活到第一个请求。
 */
export const APP_TOKEN = 'FAMILY_TRIP_APP';

@Global()
@Module({
  providers: [
    {
      provide: APP_TOKEN,
      useFactory: (): BuiltApp => buildApp(),
    },
  ],
  exports: [APP_TOKEN],
})
export class CompositionModule {}

/**
 * 根模块。
 *
 * `/health`  —— 探针，不走 8 段链（无需鉴权）
 * `/api/**`  —— 全量业务路由，统一经派发器进 8 段链
 */
@Module({
  imports: [CompositionModule],
  controllers: [HealthController, HttpAdapterController],
})
export class AppModule {}
