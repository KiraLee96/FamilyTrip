import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';

/**
 * 根模块（首次提交基线）。
 * 业务域（auth/family/trip/...）按域拆分，待 v1.4 关系型栈收口后接入。
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
