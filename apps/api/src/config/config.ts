import { z } from 'zod';
import { isIP } from 'node:net';
import { Injectable } from '@nestjs/common';

const optionalString = (schema: z.ZodString) => z.preprocess(value => value === '' ? undefined : value, schema.optional());
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  PUBLIC_ORIGIN: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.string().url().refine(value => /^postgres(ql)?:\/\//.test(value), 'PostgreSQL URL required'),
  EXECUTIONS_ENABLED: z.enum(['true', 'false']).default('false'),
  PIPELINE_ENABLED: z.enum(['true', 'false']).default('false'),
  REALTIME_ENABLED: z.enum(['true', 'false']).default('false'),
  REDIS_URL: optionalString(z.string().url().refine(v => /^rediss?:\/\//.test(v))),
  QUEUE_NAME: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).default('arenacore-executions'),
  OIDC_ENABLED: z.enum(['true', 'false']).default('false'),
  OIDC_ISSUER: optionalString(z.string().url()),
  OIDC_CLIENT_ID: optionalString(z.string().min(1).max(255)),
  OIDC_CLIENT_SECRET: optionalString(z.string().min(1)),
  OIDC_TRANSACTION_KEY: optionalString(z.string().regex(/^[A-Za-z0-9+/]{43}=$/)),
  OIDC_CLIENT_AUTH_METHOD: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  OIDC_ID_TOKEN_ALG: z.enum(['RS256', 'ES256']).default('RS256'),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(28800),
  AUTH_LOGIN_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(100).default(20),
  AUTH_LOGIN_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(120),
  TRUST_PROXY_CIDRS: z.string().default(''),
  MAX_ACTIVE_JOBS_PER_USER: z.coerce.number().int().min(1).max(10).default(1),
  MAX_ACTIVE_JOBS_GLOBAL: z.coerce.number().int().min(1).max(100000).default(1000),
  EXECUTION_CREATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(10),
  EXECUTION_IP_CREATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(10000).default(60),
  EXECUTION_GLOBAL_CREATIONS_PER_MINUTE: z.coerce.number().int().min(1).max(100000).default(300),
  EXECUTION_RATE_LIMIT_KEY: optionalString(z.string().regex(/^[A-Za-z0-9+/]{43}=$/)),
  QUEUE_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  JOB_MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(1).max(300).default(15),
}).superRefine((env, ctx) => {
  if (env.PIPELINE_ENABLED === 'true' && !env.REDIS_URL) ctx.addIssue({code: 'custom', path: ['REDIS_URL'], message: 'Required for queue dispatch'});
  if (env.EXECUTIONS_ENABLED === 'true' && !env.EXECUTION_RATE_LIMIT_KEY) {
    ctx.addIssue({code: 'custom', path: ['EXECUTION_RATE_LIMIT_KEY'], message: 'Required when execution creation is enabled'});
  }
  if (env.OIDC_ENABLED === 'true') {
    for (const key of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_TRANSACTION_KEY'] as const) {
      if (!env[key]) ctx.addIssue({code: 'custom', path: [key], message: 'Required when OIDC is enabled'});
    }
  }
  if (env.OIDC_ISSUER) {
    const issuer = URL.canParse(env.OIDC_ISSUER) ? new URL(env.OIDC_ISSUER) : null;
    if (!issuer || issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
      ctx.addIssue({code: 'custom', path: ['OIDC_ISSUER'], message: 'Issuer must use HTTPS without credentials, query or fragment'});
    }
  }
  if (env.OIDC_TRANSACTION_KEY && Buffer.from(env.OIDC_TRANSACTION_KEY, 'base64').toString('base64') !== env.OIDC_TRANSACTION_KEY) {
    ctx.addIssue({code: 'custom', path: ['OIDC_TRANSACTION_KEY'], message: 'Use a canonical base64-encoded 32-byte key'});
  }
  if (env.EXECUTION_RATE_LIMIT_KEY && Buffer.from(env.EXECUTION_RATE_LIMIT_KEY, 'base64').toString('base64') !== env.EXECUTION_RATE_LIMIT_KEY) {
    ctx.addIssue({code: 'custom', path: ['EXECUTION_RATE_LIMIT_KEY'], message: 'Use a canonical base64-encoded 32-byte key'});
  }
  // Only explicit IPs/CIDRs; never allow trust-all or arbitrary hop counts.
  if (env.TRUST_PROXY_CIDRS) {
    for (const cidr of env.TRUST_PROXY_CIDRS.split(',')) {
      const [address, prefix, ...rest] = cidr.trim().split('/');
      const family = address ? isIP(address) : 0;
      if (!family || rest.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
        ctx.addIssue({code: 'custom', path: ['TRUST_PROXY_CIDRS'], message: 'Only explicit IP addresses or CIDRs are allowed'});
      }
    }
  }
  if (!URL.canParse(env.PUBLIC_ORIGIN)) {
    ctx.addIssue({code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'Use a valid origin'});
    return;
  }
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol)) ctx.addIssue({code: 'custom', path: ['PUBLIC_ORIGIN'], message: 'Use an HTTP or HTTPS origin'});
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
  get oidcEnabled() { return this.values.OIDC_ENABLED === 'true'; }
  get secureCookies() { return this.values.PUBLIC_ORIGIN.startsWith('https:'); }
  get callbackUrl() { return `${this.values.PUBLIC_ORIGIN}/api/v1/auth/callback`; }
  get loginCookieName() { return this.values.NODE_ENV === 'production' ? '__Host-arenacore_oidc' : 'arenacore_oidc'; }
  get cookieName() { return this.values.NODE_ENV === 'production' ? '__Host-arenacore_session' : 'arenacore_session'; }
}
