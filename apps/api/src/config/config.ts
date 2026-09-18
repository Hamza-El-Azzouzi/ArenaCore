import { z } from 'zod';
import { Injectable } from '@nestjs/common';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:\/\//.test(value), 'PostgreSQL URL required'),
  EXECUTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().min(1).max(10).default(1),
}).superRefine((env, ctx) => {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.origin !== env.PUBLIC_ORIGIN || origin.username || origin.password) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'Use an exact origin without path, credentials or trailing slash' });
  }
  if (env.NODE_ENV === 'production' && env.EXECUTIONS_ENABLED === 'true') {
    ctx.addIssue({ code: 'custom', path: ['EXECUTIONS_ENABLED'], message: 'Production execution is not supported in this foundation release' });
  }
  if (env.NODE_ENV === 'production' && origin.protocol !== 'https:') {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'Production origin must use HTTPS' });
  }
});
export function parseConfig(env: NodeJS.ProcessEnv) {
  const result = envSchema.safeParse(env);
  // Never echo rejected values, which can contain credentials.
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.')).join(', ')}`);
  return result.data;
}
@Injectable()
export class Config {
  readonly values = parseConfig(process.env);
  get executionsEnabled() { return this.values.EXECUTIONS_ENABLED === 'true'; }
  get cookieName() { return this.values.NODE_ENV === 'production' ? '__Host-arenacore_session' : 'arenacore_session'; }
}
