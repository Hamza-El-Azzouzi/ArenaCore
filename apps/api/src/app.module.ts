import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';
import { Problems, ProblemsController } from './problems/problems';
import { ExecutionsModule } from './executions/executions.module';
import { ProfilesModule } from './profiles/profiles.module';
import { DiscussionsModule } from './discussions/discussions.module';
@Module({
  imports: [DatabaseModule, AuthModule, ExecutionsModule, ProfilesModule, DiscussionsModule],
  controllers: [HealthController, ProblemsController],
  providers: [Problems],
})
export class AppModule {}
