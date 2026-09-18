import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes, randomUUID } from 'node:crypto';
import { canTransition, stateSchema, type ExecutionReceipt, type ExecutionSnapshot, type SubmissionSummary } from '@arenacore/contracts';
import { AppModule } from '../apps/api/src/app.module';
import { configureApp } from '../apps/api/src/bootstrap';
import { Config } from '../apps/api/src/config/config';
import { newSessionSecrets } from '../apps/api/src/auth/session';
import { executionRateKey } from '../apps/api/src/executions/admission';
import { expireQueuedJobs } from '../apps/api/src/executions/queued-maintenance';
import { payloadHash } from '../apps/api/src/executions/executions';
import { sampleProblemId, sampleVersionId, seed } from '../prisma/seed';

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const origin = 'http://localhost:3000';
const input = {problemId: sampleProblemId, language: 'python' as const, mode: 'SUBMIT' as const, sourceCode: 'print(5)'};
interface Client { id: string; cookie: string; csrf: string }
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }

integration('durable job lifecycle and distributed admission', () => {
  let db: PrismaClient, config: Config;
  const apps: NestExpressApplication[] = [];
  const bases: string[] = [];
  const users = new Set<string>(), rateKeys = new Set<string>();
  let owner: Client, other: Client;
  function trackRateKeys() {
    const window = Math.floor(Date.now() / 60000);
    for (const w of [window - 1, window, window + 1]) {
      for (const scope of ['global', 'ip:127.0.0.1', ...[...users].map(id => `user:${id}`)]) {
        rateKeys.add(executionRateKey(config.values.EXECUTION_RATE_LIMIT_KEY!, w, scope));
      }
    }
  }
  async function client(): Promise<Client> {
    const user = await db.user.create({data: {issuer: 'stage4-test', subject: randomUUID(), displayName: 'Stage 4 test'}});
    users.add(user.id);
    const secrets = newSessionSecrets();
    await db.session.create({data: {userId: user.id, tokenHash: secrets.tokenHash, csrfTokenHash: secrets.csrfTokenHash, expiresAt: new Date(Date.now() + 3600000)}});
    trackRateKeys();
    return {id: user.id, cookie: `arenacore_session=${secrets.token}`, csrf: secrets.csrfToken};
  }
  async function request(path: string, who = owner, options: RequestInit = {}, instance = 0) {
    trackRateKeys();
    const response = await fetch(`${bases[instance]}${path}`, {...options, headers: {
      cookie: who.cookie, origin, 'x-csrf-token': who.csrf, 'content-type': 'application/json', ...options.headers,
    }});
    trackRateKeys();
    return response;
  }
  function create(who = owner, key = `stage4-${randomUUID()}`, body = input, instance = 0) {
    return request('/executions', who, {method: 'POST', headers: {'idempotency-key': key}, body: JSON.stringify(body)}, instance);
  }
  async function fixture(who = owner, options: {expired?: boolean; mode?: 'RUN' | 'SUBMIT'; createdAt?: Date} = {}) {
    const createdAt = options.createdAt ?? new Date(Date.now() - (options.expired ? 60000 : 0));
    const row = await db.execution.create({data: {
      userId: who.id, problemVersionId: sampleVersionId, language: 'python', mode: options.mode ?? 'SUBMIT',
      sourceCode: input.sourceCode, payloadHash: payloadHash(input), idempotencyKey: `fixture-${randomUUID()}`,
      createdAt, queueExpiresAt: new Date(createdAt.getTime() + (options.expired ? 10000 : 3600000)),
    }});
    await db.outboxEvent.create({data: {kind: 'EXECUTION_CREATED', executionId: row.id}});
    return row;
  }
  beforeAll(async () => {
    Object.assign(process.env, {DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test', PUBLIC_ORIGIN: origin,
      OIDC_ENABLED: 'false', EXECUTIONS_ENABLED: 'true', EXECUTION_RATE_LIMIT_KEY: randomBytes(32).toString('base64'), TRUST_PROXY_CIDRS: ''});
    config = new Config();
    db = new PrismaClient({datasources: {db: {url: process.env.TEST_DATABASE_URL}}});
    await seed(db);
    for (let i = 0; i < 2; i++) {
      const module = await Test.createTestingModule({imports: [AppModule]}).overrideProvider(Config).useValue(config).compile();
      const app = configureApp(module.createNestApplication<NestExpressApplication>({bodyParser: false, logger: false}));
      await app.listen(0, '127.0.0.1');
      apps.push(app); bases.push(`${await app.getUrl()}/api/v1`);
    }
  });
  beforeEach(async () => {
    await db.execution.deleteMany({where: {userId: {in: [...users]}}});
    await db.executionRateLimit.deleteMany({where: {key: {in: [...rateKeys]}}});
    Object.assign(config.values, {EXECUTIONS_ENABLED: 'true', MAX_ACTIVE_JOBS_PER_USER: 1, MAX_ACTIVE_JOBS_GLOBAL: 100000,
      EXECUTION_CREATIONS_PER_MINUTE: 1000, EXECUTION_IP_CREATIONS_PER_MINUTE: 10000,
      EXECUTION_GLOBAL_CREATIONS_PER_MINUTE: 100000, EXECUTION_RATE_LIMIT_KEY: randomBytes(32).toString('base64')});
    owner = await client(); other = await client();
  });
  afterAll(async () => {
    await Promise.all(apps.map(app => app.close()));
    if (db) {
      await db.execution.deleteMany({where: {userId: {in: [...users]}}});
      await db.user.deleteMany({where: {id: {in: [...users]}}});
      await db.executionRateLimit.deleteMany({where: {key: {in: [...rateKeys]}}});
      await db.$disconnect();
    }
    process.env.EXECUTIONS_ENABLED = 'false';
  });

  it('serializes distinct requests competing for one owner slot across API instances', async () => {
    const responses = await Promise.all([create(owner), create(owner, undefined, undefined, 1)]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 429]);
    expect(await db.execution.count({where: {userId: owner.id}})).toBe(1);
  });
  it('scopes the same idempotency key independently to each user', async () => {
    const key = `shared-${randomUUID()}`;
    const responses = await Promise.all([create(owner, key), create(other, key, undefined, 1)]);
    expect(responses.map(r => r.status)).toEqual([202, 202]);
    const rows = await Promise.all(responses.map(r => json<ExecutionReceipt>(r)));
    expect(rows[0]!.executionId).not.toBe(rows[1]!.executionId);
  });
  it('returns concurrent retries without consuming additional admission quotas', async () => {
    config.values.EXECUTION_CREATIONS_PER_MINUTE = 1;
    config.values.EXECUTION_IP_CREATIONS_PER_MINUTE = 1;
    config.values.EXECUTION_GLOBAL_CREATIONS_PER_MINUTE = 1;
    const key = `retry-${randomUUID()}`;
    const responses = await Promise.all(Array.from({length: 6}, (_, i) => create(owner, key, undefined, i % 2)));
    expect(responses.every(r => r.status === 202)).toBe(true);
    const jobs = await Promise.all(responses.map(r => json<ExecutionReceipt>(r)));
    expect(new Set(jobs.map(j => j.executionId)).size).toBe(1);
    const keys = [...rateKeys];
    const counts = await db.executionRateLimit.findMany({where: {key: {in: keys}}});
    expect(counts).toHaveLength(3);
    expect(counts.every(c => c.count === 1)).toBe(true);
  });
  it('preserves a cancelled job receipt on retry and rejects payload changes', async () => {
    const key = `cancel-retry-${randomUUID()}`;
    const receipt = await json<ExecutionReceipt>(await create(owner, key));
    await request(`/executions/${receipt.executionId}/cancel`, owner, {method: 'POST'});
    const retried = await json<ExecutionReceipt>(await create(owner, key, undefined, 1));
    expect(retried).toEqual({executionId: receipt.executionId, state: 'CANCELLED'});
    const conflict = await create(owner, key, {...input, sourceCode: 'print(6)'});
    expect(conflict.status).toBe(409);
    expect(await db.execution.count({where: {userId: owner.id}})).toBe(1);
  });
  it('limits successful creations even when a user rapidly cancels each job', async () => {
    config.values.EXECUTION_CREATIONS_PER_MINUTE = 1;
    const receipt = await json<ExecutionReceipt>(await create());
    await request(`/executions/${receipt.executionId}/cancel`, owner, {method: 'POST'});
    const rejected = await create();
    expect(rejected.status).toBe(429);
    expect((await json<{error: {code: string}}>(rejected)).error.code).toBe('EXECUTION_RATE_LIMIT');
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await db.execution.count({where: {userId: owner.id}})).toBe(1);
  });
  it('shares the IP quota across owners and rejects forwarded-IP spoofing', async () => {
    config.values.EXECUTION_IP_CREATIONS_PER_MINUTE = 1;
    expect((await create()).status).toBe(202);
    const rejected = await request('/executions', other, {method: 'POST', headers: {
      'idempotency-key': `spoof-${randomUUID()}`, 'x-forwarded-for': '203.0.113.20',
    }, body: JSON.stringify(input)}, 1);
    expect(rejected.status).toBe(429);
    expect(await db.execution.count({where: {userId: other.id}})).toBe(0);
  });
  it('shares global creation quotas across API instances', async () => {
    config.values.EXECUTION_GLOBAL_CREATIONS_PER_MINUTE = 1;
    const responses = await Promise.all([create(), create(other, undefined, undefined, 1)]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 429]);
  });
  it('atomically reserves the last global active slot across different users', async () => {
    config.values.MAX_ACTIVE_JOBS_GLOBAL = 1;
    const responses = await Promise.all([create(), create(other, undefined, undefined, 1)]);
    expect(responses.map(r => r.status).sort()).toEqual([202, 503]);
    const denied = responses.find(r => r.status === 503)!;
    expect((await json<{error: {code: string}}>(denied)).error.code).toBe('EXECUTION_CAPACITY');
    expect(denied.headers.get('retry-after')).toBe('5');
    expect(await db.execution.count({where: {userId: {in: [owner.id, other.id]}}})).toBe(1);
  });
  it('rolls back execution and quota writes if durable outbox insertion fails', async () => {
    await db.$executeRawUnsafe(`CREATE FUNCTION stage4_reject_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'EXECUTION_CREATED' THEN RAISE EXCEPTION 'PRIVATE_OUTBOX_FAILURE'; END IF; RETURN NEW; END; $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER stage4_reject_outbox BEFORE INSERT ON "OutboxEvent"
      FOR EACH ROW EXECUTE FUNCTION stage4_reject_outbox()`);
    const key = `rollback-${randomUUID()}`;
    try {
      const response = await create(owner, key);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('PRIVATE_OUTBOX_FAILURE');
      expect(await db.execution.count({where: {userId: owner.id}})).toBe(0);
      expect(await db.executionRateLimit.count({where: {key: {in: [...rateKeys]}}})).toBe(0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER stage4_reject_outbox ON "OutboxEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION stage4_reject_outbox()');
    }
    expect((await create(owner, key)).status).toBe(202);
  });
  it('pins a job to its version and preserves retries after catalog unpublication', async () => {
    const key = `version-${randomUUID()}`;
    const receipt = await json<ExecutionReceipt>(await create(owner, key));
    await db.problem.update({where: {id: sampleProblemId}, data: {currentVersionId: null}});
    try {
      expect((await create(owner, key)).status).toBe(202);
      expect((await db.execution.findUniqueOrThrow({where: {id: receipt.executionId}})).problemVersionId).toBe(sampleVersionId);
      expect((await request(`/executions/${receipt.executionId}`)).status).toBe(200);
    } finally {
      await db.problem.update({where: {id: sampleProblemId}, data: {currentVersionId: sampleVersionId}});
    }
  });
  it('emits one cancellation outbox event under parallel cancellation', async () => {
    const receipt = await json<ExecutionReceipt>(await create());
    const responses = await Promise.all(Array.from({length: 6}, (_, i) => request(`/executions/${receipt.executionId}/cancel`, owner, {method: 'POST'}, i % 2)));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(await db.outboxEvent.count({where: {executionId: receipt.executionId, kind: 'EXECUTION_CANCELLED'}})).toBe(1);
    expect((await db.execution.findUniqueOrThrow({where: {id: receipt.executionId}})).verdict).toBe('CANCELLED');
  });
  it('expires queued jobs once, exposes only a safe code, and frees an owner slot', async () => {
    const row = await fixture(owner, {expired: true});
    expect(await expireQueuedJobs(db)).toBe(1);
    expect(await expireQueuedJobs(db)).toBe(0);
    const snapshot = await json<ExecutionSnapshot>(await request(`/executions/${row.id}`));
    expect(snapshot.state).toBe('INTERNAL_ERROR');
    expect(snapshot.verdict).toBe('INTERNAL_ERROR');
    expect(snapshot.failureCode).toBe('QUEUE_TIMEOUT');
    expect(snapshot).not.toHaveProperty('sourceCode');
    expect(snapshot).not.toHaveProperty('publicCaseResults');
    expect(await db.outboxEvent.count({where: {executionId: row.id, kind: 'EXECUTION_EXPIRED'}})).toBe(1);
    const history = await json<{items: SubmissionSummary[]}>(await request('/submissions'));
    expect(history.items[0]!.failureCode).toBe('QUEUE_TIMEOUT');
    expect((await create()).status).toBe(202);
  });
  it('preserves exactly one terminal outcome when expiry races cancellation', async () => {
    const row = await fixture(owner, {expired: true});
    const [cancel] = await Promise.all([request(`/executions/${row.id}/cancel`, owner, {method: 'POST'}), expireQueuedJobs(db)]);
    expect(cancel.status).toBe(200);
    const terminal = await db.execution.findUniqueOrThrow({where: {id: row.id}});
    expect(['CANCELLED', 'INTERNAL_ERROR']).toContain(terminal.state);
    expect(await db.outboxEvent.count({where: {executionId: row.id, kind: {in: ['EXECUTION_CANCELLED', 'EXECUTION_EXPIRED']}}})).toBe(1);
  });
  it('does not expire jobs that concurrently leave the queue', async () => {
    const row = await fixture(owner, {expired: true});
    await Promise.all([db.execution.updateMany({where: {id: row.id, state: 'QUEUED'}, data: {state: 'COMPILING'}}), expireQueuedJobs(db)]);
    const actual = await db.execution.findUniqueOrThrow({where: {id: row.id}});
    expect(['COMPILING', 'INTERNAL_ERROR']).toContain(actual.state);
    expect(await db.outboxEvent.count({where: {executionId: row.id, kind: 'EXECUTION_EXPIRED'}})).toBe(actual.state === 'INTERNAL_ERROR' ? 1 : 0);
  });
  it('automatically expires overdue work through the Nest maintenance lifecycle', async () => {
    const module = await Test.createTestingModule({imports: [AppModule]}).overrideProvider(Config).useValue(config).compile();
    const app = configureApp(module.createNestApplication<NestExpressApplication>({bodyParser: false, logger: false}));
    const previousInterval = config.values.JOB_MAINTENANCE_INTERVAL_SECONDS;
    config.values.JOB_MAINTENANCE_INTERVAL_SECONDS = 1;
    try {
      await app.listen(0, '127.0.0.1');
      const row = await fixture(owner, {expired: true});
      await expect.poll(async () => (await db.execution.findUniqueOrThrow({where: {id: row.id}})).state,
        {timeout: 4000, interval: 50}).toBe('INTERNAL_ERROR');
      expect(await db.outboxEvent.count({where: {executionId: row.id, kind: 'EXECUTION_EXPIRED'}})).toBe(1);
    } finally {
      config.values.JOB_MAINTENANCE_INTERVAL_SECONDS = previousInterval;
      await app.close();
    }
  });
  it('refuses active cancellation without pretending a runner process was stopped', async () => {
    const row = await fixture();
    await db.execution.update({where: {id: row.id}, data: {state: 'COMPILING'}});
    const rejected = await request(`/executions/${row.id}/cancel`, owner, {method: 'POST'});
    expect(rejected.status).toBe(503);
    expect((await json<{error: {code: string}}>(rejected)).error.code).toBe('CANCELLATION_UNAVAILABLE');
    expect((await db.execution.findUniqueOrThrow({where: {id: row.id}})).state).toBe('COMPILING');
    expect(await db.outboxEvent.count({where: {executionId: row.id, kind: 'EXECUTION_CANCELLED'}})).toBe(0);
  });
  it('bounds each expiry batch and permits concurrent maintenance without duplicates', async () => {
    for (let i = 0; i < 105; i++) await fixture(owner, {expired: true});
    const expired = await Promise.all([expireQueuedJobs(db), expireQueuedJobs(db)]);
    expect(expired.every(n => n <= 100)).toBe(true);
    expect(expired.reduce((a, b) => a + b, 0)).toBe(105);
    expect(await db.outboxEvent.count({where: {execution: {userId: owner.id}, kind: 'EXECUTION_EXPIRED'}})).toBe(105);
  });
  it('rejects rewrites of immutable execution requests and snapshots', async () => {
    const row = await fixture();
    for (const data of [{userId: other.id}, {sourceCode: 'changed'}, {language: 'java' as const},
      {mode: 'RUN' as const}, {problemVersionId: randomUUID()}, {payloadHash: 'b'.repeat(64)},
      {idempotencyKey: 'changed-request-key'}, {queueExpiresAt: new Date(Date.now() + 7200000)}]) {
      await expect(db.execution.update({where: {id: row.id}, data})).rejects.toThrow();
    }
  });
  it('enforces the same state graph as the shared contract in PostgreSQL', async () => {
    for (const from of stateSchema.options) {
      for (const to of stateSchema.options) {
        if (from === to) continue;
        const row = await fixture();
        if (from === 'COMPILING' || from === 'RUNNING' || from === 'FINISHED') {
          await db.execution.update({where: {id: row.id}, data: {state: 'COMPILING'}});
        }
        if (from === 'RUNNING') await db.execution.update({where: {id: row.id}, data: {state: 'RUNNING'}});
        if (from === 'FINISHED' || from === 'CANCELLED' || from === 'INTERNAL_ERROR') {
          await db.execution.update({where: {id: row.id}, data: {state: from,
            verdict: from === 'FINISHED' ? 'ACCEPTED' : from, finishedAt: new Date()}});
        }
        const terminal = ['FINISHED', 'CANCELLED', 'INTERNAL_ERROR'].includes(to);
        const update = db.execution.update({where: {id: row.id}, data: {state: to,
          verdict: terminal ? (to === 'FINISHED' ? 'ACCEPTED' : to as 'CANCELLED' | 'INTERNAL_ERROR') : null,
          finishedAt: terminal ? new Date() : null}});
        if (canTransition(from, to)) await expect(update).resolves.toMatchObject({state: to});
        else await expect(update).rejects.toThrow();
      }
    }
  });
  it('rejects inconsistent terminal fields, counter regression, and terminal verdict edits', async () => {
    const row = await fixture();
    await expect(db.execution.update({where: {id: row.id}, data: {state: 'CANCELLED'}})).rejects.toThrow();
    await expect(db.execution.update({where: {id: row.id}, data: {state: 'CANCELLED', verdict: 'ACCEPTED', finishedAt: new Date()}})).rejects.toThrow();
    await expect(db.execution.update({where: {id: row.id}, data: {attempt: -1}})).rejects.toThrow();
    await db.execution.update({where: {id: row.id}, data: {state: 'COMPILING', attempt: 1, lastSequence: 3}});
    await expect(db.execution.update({where: {id: row.id}, data: {lastSequence: 2}})).rejects.toThrow();
    await db.execution.update({where: {id: row.id}, data: {state: 'FINISHED', verdict: 'WRONG_ANSWER', finishedAt: new Date()}});
    await expect(db.execution.update({where: {id: row.id}, data: {verdict: 'ACCEPTED'}})).rejects.toThrow();
    const cancelled = await json<ExecutionReceipt>(await request(`/executions/${row.id}/cancel`, owner, {method: 'POST'}));
    expect(cancelled.state).toBe('FINISHED');
    expect(await db.outboxEvent.count({where: {executionId: row.id, kind: 'EXECUTION_CANCELLED'}})).toBe(0);
  });
  it('paginates owner history without missing timestamp ties and excludes Run jobs', async () => {
    const createdAt = new Date(Date.now() - 30000);
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) ids.push((await fixture(owner, {createdAt})).id);
    await fixture(owner, {mode: 'RUN', createdAt});
    const foreign = await fixture(other, {createdAt});
    const first = await json<{items: SubmissionSummary[]; nextCursor: string}>(await request('/submissions'));
    const second = await json<{items: SubmissionSummary[]; nextCursor: null}>(await request(`/submissions?cursor=${first.nextCursor}`));
    expect(first.items).toHaveLength(20); expect(second.items).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map(r => r.executionId)).toEqual(ids.sort().reverse());
    expect((await request(`/submissions?cursor=${foreign.id}`)).status).toBe(400);
    expect(first.items.every(r => !('sourceCode' in r))).toBe(true);
  });
  it('enforces outbox identity and referential integrity', async () => {
    const row = await fixture();
    await expect(db.outboxEvent.create({data: {executionId: row.id, kind: 'EXECUTION_CREATED'}})).rejects.toThrow();
    await expect(db.outboxEvent.create({data: {executionId: randomUUID(), kind: 'EXECUTION_CREATED'}})).rejects.toThrow();
  });
});
