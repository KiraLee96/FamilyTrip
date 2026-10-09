import { Controller, Get } from '@nestjs/common';
import { ok, type Envelope } from '../common/envelope/envelope.js';

interface HealthStatus {
  status: 'up';
}

/**
 * 健康检查：探针 / 存活检测入口。返回统一信封（responseEnvelope 链路第 8 段）。
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): Envelope<HealthStatus> {
    return ok<HealthStatus>({ status: 'up' });
  }
}
