import { z } from 'zod';

const workerEnvSchema = z.strictObject({
  NODE_ENV: z.literal('production'),
  RUNNER_WORKER_ENABLED: z.literal('true'),
  RUNNER_SOCKET_PATH: z.string().regex(/^\/(?:[^\0/]+\/)*[^\0/]+$/),
  DATABASE_URL: z.string().url().refine(value => /^postgres(?:ql)?:\/\//.test(value), 'PostgreSQL URL required'),
  REDIS_URL: z.string().url().refine(value => /^rediss?:\/\//.test(value), 'Redis URL required'),
  QUEUE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).default('arenacore-executions'),
}).superRefine((env, context) => {
  const redis = URL.canParse(env.REDIS_URL) ? new URL(env.REDIS_URL) : undefined;
  if (redis && (redis.search || redis.hash || !/^(?:\/\d*)?$/.test(redis.pathname))) {
    context.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'Redis URL may contain only a database path' });
  }
});

export function parseWorkerConfig(env: NodeJS.ProcessEnv) {
  const input = {
    NODE_ENV: env.NODE_ENV,
    RUNNER_WORKER_ENABLED: env.RUNNER_WORKER_ENABLED,
    RUNNER_SOCKET_PATH: env.RUNNER_SOCKET_PATH,
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    QUEUE_NAME: env.QUEUE_NAME,
  };
  const result = workerEnvSchema.safeParse(input);
  // Values may contain credentials. Report field names only.
  if (!result.success) throw new Error(`Invalid worker configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  return result.data;
}
