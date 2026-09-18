import { Module } from '@nestjs/common';
import { Config } from './config/config';
import { Database } from './database/database';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { Sessions, SessionGuard } from './auth/session';
import { Problems, ProblemsController } from './problems/problems';
import { Executions, ExecutionsController } from './executions/executions';
@Module({
  controllers: [HealthController, AuthController, ProblemsController, ExecutionsController],
  providers: [Config, Database, Sessions, SessionGuard, Problems, Executions],
})
export class AppModule {}
