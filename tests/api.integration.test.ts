import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { ProblemDetail, SubmissionSummary } from '@arenacore/contracts';
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/bootstrap';
import { Config } from '../apps/api/src/config/config';
import { newSessionSecrets } from '../apps/api/src/auth/session';
import { seed, sampleProblemId, sampleVersionId } from '../prisma/seed';

// Never run destructive setup against DATABASE_URL. Explicitly opt into a disposable DB.
const url = process.env.TEST_DATABASE_URL;
const integration = url ? describe : describe.skip;
integration('real PostgreSQL API integration', () => {
  let db: PrismaClient;
  let app: NestExpressApplication;
  let base: string;
  let ownerId: string;
  let otherId: string;
  let cookie: string;
  let otherCookie: string;
  let csrf: string;
  let jobId: string;
  const origin = 'http://localhost:3000';
  const input = {problemId: sampleProblemId, language: 'python', mode: 'SUBMIT', sourceCode: 'print(5)'};
  const key = 'integration-request-key-001';
  async function request(path: string, options: RequestInit = {}, asOther = false) {
    return fetch(`${base}${path}`, {...options, headers: {cookie: asOther ? otherCookie : cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/json', ...options.headers}});
  }
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.NODE_ENV = 'test';
    process.env.PUBLIC_ORIGIN = origin;
    process.env.EXECUTIONS_ENABLED = 'true';
    db = new PrismaClient({datasources: {db: {url}}});
    await seed(db);
    await seed(db); // Published fixtures remain immutable; seed is repeatable.
    const users = await Promise.all(['owner', 'other'].map(subject => db.user.create({data: {issuer: 'integration-test', subject: `${subject}-${crypto.randomUUID()}`, displayName: subject}})));
    ownerId = users[0]!.id;
    otherId = users[1]!.id;
    const sessions = [newSessionSecrets(), newSessionSecrets()];
    for (let i=0; i<2; i++) await db.session.create({data: {userId: users[i]!.id, tokenHash: sessions[i]!.tokenHash, csrfTokenHash: sessions[i]!.csrfTokenHash, expiresAt: new Date(Date.now()+60000)}});
    cookie = `arenacore_session=${sessions[0]!.token}`;
    otherCookie = `arenacore_session=${sessions[1]!.token}`;
    csrf = sessions[0]!.csrfToken;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/v1`;
  });
  afterAll(async () => {
    await app?.close();
    if (db && ownerId && otherId) {
      const jobs = await db.execution.findMany({where: {userId: {in: [ownerId, otherId]}}, select: {id: true}});
      await db.outboxEvent.deleteMany({where: {executionId: {in: jobs.map(j=>j.id)}}});
      await db.execution.deleteMany({where: {userId: {in: [ownerId, otherId]}}});
      await db.user.deleteMany({where: {id: {in: [ownerId, otherId]}}});
    }
    await db?.$disconnect();
  });
  it('serves health, safe problem detail and structured errors', async () => {
    expect((await request('/health/ready')).status).toBe(200);
    const detail = await json<ProblemDetail>(await request('/problems/sum-two-numbers'));
    expect(detail.examples).toHaveLength(2);
    expect(JSON.stringify(detail)).not.toContain('2000000000');
    expect(detail).not.toHaveProperty('testCases');
    const response = await request('/problems?unexpected=1');
    expect(response.status).toBe(400);
    expect((await json<{error: {requestId: string}}>(response)).error.requestId).toBeTruthy();
  });
  it('enforces published problem/test immutability at the database boundary', async () => {
    await expect(db.problemVersion.update({where: {id: sampleVersionId}, data: {title: 'tampered'}})).rejects.toThrow();
    await expect(db.testCase.updateMany({where: {problemVersionId: sampleVersionId}, data: {expectedOutput: 'tampered'}})).rejects.toThrow();
  });
  it('fails closed without session and on bad CSRF/origin', async () => {
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {cookie: '', 'idempotency-key': key}})).status).toBe(401);
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {'x-csrf-token': 'invalid', 'idempotency-key': key}})).status).toBe(403);
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {origin: 'https://evil.example', 'idempotency-key': key}})).status).toBe(403);
  });
  it('returns stable CSRF tokens across me calls', async () => {
    const first = await json<{csrfToken: string}>(await request('/me'));
    const second = await json<{csrfToken: string}>(await request('/me'));
    expect(first.csrfToken).toBe(csrf);
    expect(second.csrfToken).toBe(csrf);
  });
  it('enforces UTF-8 limit and rejects extra owner/runtime fields', async () => {
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': key}, body: JSON.stringify({...input, sourceCode: 'é'.repeat(32769)})})).status).toBe(413);
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': key}, body: JSON.stringify({...input, userId: otherId})})).status).toBe(400);
  });
  it('atomically creates one execution and outbox entry across concurrent retries', async () => {
    const responses = await Promise.all(Array.from({length: 5}, () => request('/executions', {method: 'POST', headers: {'idempotency-key': key}, body: JSON.stringify(input)})));
    expect(responses.every(r=>r.status === 202)).toBe(true);
    const jobs = await Promise.all(responses.map(r=>json<{executionId: string}>(r)));
    jobId = jobs[0]!.executionId;
    expect(new Set(jobs.map(j=>j.executionId)).size).toBe(1);
    expect(await db.execution.count({where: {userId: ownerId}})).toBe(1);
    expect(await db.outboxEvent.count({where: {executionId: jobId, kind: 'EXECUTION_CREATED'}})).toBe(1);
    expect((await db.execution.findUniqueOrThrow({where: {id: jobId}})).problemVersionId).toBe(sampleVersionId);
  });
  it('rejects conflicting idempotency and an additional active job', async () => {
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': key}, body: JSON.stringify({...input, sourceCode: 'print(6)'})})).status).toBe(409);
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': `${key}-new`}, body: JSON.stringify(input)})).status).toBe(429);
  });
  it('isolates snapshots, cancellation and history between owners', async () => {
    expect((await request(`/executions/${jobId}`, {}, true)).status).toBe(404);
    // Supply other user's CSRF, so ownership rather than CSRF is checked.
    const session = newSessionSecrets();
    await db.session.create({data: {userId: otherId, tokenHash: session.tokenHash, csrfTokenHash: session.csrfTokenHash, expiresAt: new Date(Date.now()+60000)}});
    expect((await request(`/executions/${jobId}/cancel`, {method: 'POST', headers: {cookie: `arenacore_session=${session.token}`, 'x-csrf-token': session.csrfToken}})).status).toBe(404);
    expect((await json<{items: SubmissionSummary[]}>(await request('/submissions', {}, true))).items).toHaveLength(0);
    const snapshot = await (await request(`/executions/${jobId}`)).json();
    expect(snapshot).not.toHaveProperty('sourceCode');
    expect(snapshot).not.toHaveProperty('publicCaseResults');
    const history = await json<{items: SubmissionSummary[]}>(await request('/submissions'));
    expect(history.items).toHaveLength(1);
    expect(history.items[0]!).not.toHaveProperty('sourceCode');
  });
  it('cancels queued jobs idempotently without duplicate outbox entries', async () => {
    for (let i=0; i<2; i++) {
      const response = await request(`/executions/${jobId}/cancel`, {method: 'POST'});
      expect(response.status).toBe(200);
      expect((await json<{state: string}>(response)).state).toBe('CANCELLED');
    }
    expect(await db.outboxEvent.count({where: {executionId: jobId, kind: 'EXECUTION_CANCELLED'}})).toBe(1);
  });
  it('rejects malformed and oversized JSON bodies with safe client errors', async () => {
    const malformed = await request('/executions', {method: 'POST', body: '{invalid'});
    expect(malformed.status).toBe(400);
    expect((await json<{error: {code: string}}>(malformed)).error.code).toBe('INVALID_REQUEST');
    const oversized = await request('/executions', {method: 'POST', body: JSON.stringify({sourceCode: 'a'.repeat(600000)})});
    expect(oversized.status).toBe(413);
  });
  it('rejects expired and revoked sessions', async () => {
    for (const revoked of [false, true]) {
      const secrets = newSessionSecrets();
      await db.session.create({data: {userId: ownerId, tokenHash: secrets.tokenHash, csrfTokenHash: secrets.csrfTokenHash, expiresAt: new Date(Date.now() + (revoked ? 60000 : -1000)), revokedAt: revoked ? new Date() : null}});
      expect((await request('/submissions', {headers: {cookie: `arenacore_session=${secrets.token}`}})).status).toBe(401);
    }
  });
  it('execution switch fails closed and logout revokes the session', async () => {
    app.get(Config).values.EXECUTIONS_ENABLED = 'false';
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': `${key}-disabled`}, body: JSON.stringify(input)})).status).toBe(503);
    expect((await request('/auth/logout', {method: 'POST'})).status).toBe(200);
    expect((await request('/submissions')).status).toBe(401);
  });
});
