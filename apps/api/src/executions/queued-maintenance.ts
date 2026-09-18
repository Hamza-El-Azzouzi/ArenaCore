import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Database } from '../database/database';
import { Config } from '../config/config';

export const EXPIRY_BATCH_SIZE = 100;
export async function expireQueuedJobs(db: PrismaClient): Promise<number> {
  return db.$transaction(async tx => {
    const now = new Date();
    const expired = await tx.$queryRaw<Array<{id: string}>>`
      SELECT id FROM "Execution"
      WHERE state = 'QUEUED' AND "queueExpiresAt" <= ${now}
      ORDER BY "queueExpiresAt", id
      LIMIT ${EXPIRY_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED`;
    if (!expired.length) return 0;
    const ids = expired.map(row => row.id);
    await tx.execution.updateMany({where: {id: {in: ids}, state: 'QUEUED'}, data: {
      state: 'INTERNAL_ERROR', verdict: 'INTERNAL_ERROR', failureCode: 'QUEUE_TIMEOUT', finishedAt: now,
    }});
    await tx.outboxEvent.createMany({data: ids.map(executionId => ({kind: 'EXECUTION_EXPIRED', executionId}))});
    return ids.length;
  });
}

@Injectable()
export class QueuedMaintenance implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private readonly logger = new Logger(QueuedMaintenance.name);
  constructor(@Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config) {}
  async onApplicationBootstrap() {
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.config.values.JOB_MAINTENANCE_INTERVAL_SECONDS * 1000);
    this.timer.unref();
  }
  private tick(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      await expireQueuedJobs(this.db);
      await this.db.executionRateLimit.deleteMany({where: {expiresAt: {lte: new Date()}}});
    })().catch(() => {
      // Database errors can include private values. Log only the stable code.
      this.logger.error('JOB_MAINTENANCE_FAILED');
    }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
  }
}
