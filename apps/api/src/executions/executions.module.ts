import { JobStore } from './job-store';
import { QueuePipeline } from './queue';
import { ExecutionRealtime } from './realtime';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { ExecutionAdmission } from './admission';
import { Executions, ExecutionsController } from './executions';
import { QueuedMaintenance } from './queued-maintenance';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [ExecutionsController],
  providers: [Executions, ExecutionAdmission, QueuedMaintenance, JobStore, QueuePipeline, ExecutionRealtime],
})
export class ExecutionsModule {}
