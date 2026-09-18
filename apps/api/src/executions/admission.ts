import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHmac } from 'node:crypto';
import { activeStates } from '@arenacore/contracts';
import { Config } from '../config/config';
import { ApiError } from '../common/errors';

// Dedicated two-integer PostgreSQL advisory-lock namespace. All API replicas
// must acquire this lock before checking global capacity and inserting a job.
export const ADMISSION_LOCK_NAMESPACE = 740021;
export const ADMISSION_LOCK_ID = 1;
export function executionRateKey(secret: string, window: number, scope: string): string {
  return createHmac('sha256', Buffer.from(secret, 'base64')).update(`execution:create:v1:${window}:${scope}`).digest('hex');
}

@Injectable()
export class ExecutionAdmission {
  constructor(@Inject(Config) private readonly config: Config) {}

  async reserve(tx: Prisma.TransactionClient, userId: string, ip: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}::int, ${ADMISSION_LOCK_ID}::int)::text`;
    const values = this.config.values;
    const active = await tx.execution.count({where: {state: {in: [...activeStates]}}});
    if (active >= values.MAX_ACTIVE_JOBS_GLOBAL) {
      throw new ApiError(503, 'EXECUTION_CAPACITY', 'Execution capacity is full. Please retry later.', 5);
    }
    const now = new Date();
    const window = Math.floor(now.getTime() / 60000);
    const expiresAt = new Date((window + 1) * 60000);
    const scopes: Array<[string, number]> = [
      ['global', values.EXECUTION_GLOBAL_CREATIONS_PER_MINUTE],
      [`ip:${ip}`, values.EXECUTION_IP_CREATIONS_PER_MINUTE],
      [`user:${userId}`, values.EXECUTION_CREATIONS_PER_MINUTE],
    ];
    for (const [scope, limit] of scopes) {
      const key = executionRateKey(values.EXECUTION_RATE_LIMIT_KEY!, window, scope);
      const counter = await tx.executionRateLimit.upsert({
        where: {key}, create: {key, expiresAt}, update: {count: {increment: 1}},
      });
      if (counter.count > limit) {
        // Rollback means these quotas count committed new jobs, not retries,
        // rejected requests, or partially failed writes. Edge request limits
        // remain a separate production control.
        throw new ApiError(429, 'EXECUTION_RATE_LIMIT', 'Too many new executions. Please wait and retry.',
          Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000)));
      }
    }
  }
}
