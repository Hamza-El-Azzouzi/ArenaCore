import { Controller, Get, Inject } from '@nestjs/common';
import { Database } from '../database/database';
import { ApiError } from '../common/errors';
@Controller('health')
export class HealthController {
  constructor(@Inject(Database) private readonly db: Database) {}
  @Get('live') live() { return {status: 'ok'}; }
  @Get('ready') async ready() {
    try { await this.db.$queryRaw`SELECT 1`; return {status: 'ok'}; }
    catch { throw new ApiError(503, 'NOT_READY', 'Service is not ready.'); }
  }
}
