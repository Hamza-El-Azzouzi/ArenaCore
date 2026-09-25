import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { DiscussionLikeState, DiscussionPost, LeaderboardEntry, ProblemDetail, PublicProfile, SubmissionSummary } from '@arenacore/contracts';
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
    process.env.OIDC_ENABLED = 'false';
    process.env.PUBLIC_ORIGIN = origin;
    process.env.EXECUTIONS_ENABLED = 'true';
    process.env.EXECUTION_RATE_LIMIT_KEY = randomBytes(32).toString('base64');
    db = new PrismaClient({datasources: {db: {url}}});
    await seed(db);
    await seed(db); // Published fixtures remain immutable; seed is repeatable.
    const users = await Promise.all(['owner', 'other'].map(subject => db.user.create({data: {issuer: 'integration-test', subject: `${subject}-${crypto.randomUUID()}`, displayName: subject}})));
    ownerId = users[0]!.id;
    otherId = users[1]!.id;
    const sessions = [newSessionSecrets(), newSessionSecrets()];
    for (let i=0; i<2; i++) await db.session.create({data: {userId: users[i]!.id, tokenHash: sessions[i]!.tokenHash, csrfTokenHash: sessions[i]!.csrfTokenHash, expiresAt: new Date(Date.now()+600000)}});
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
      await db.auditEvent.deleteMany({where: {actorId: {in: [ownerId, otherId]}}});
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
    const tagSearch = await json<{items: {id: string}[]}>(await request('/problems?search=STDIN'));
    expect(tagSearch.items.map(item => item.id)).toContain(sampleProblemId);
    const response = await request('/problems?unexpected=1');
    expect(response.status).toBe(400);
    expect((await json<{error: {requestId: string}}>(response)).error.requestId).toBeTruthy();
  });
  it('allows credentialed CORS only for the configured frontend origin', async () => {
    const allowed = await fetch(`${base}/me`, {method: 'OPTIONS', headers: {origin, 'access-control-request-method': 'GET'}});
    expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    const mutationPreflights = await Promise.all(['PATCH', 'PUT', 'DELETE'].map(method => fetch(`${base}/profiles/me`, {method: 'OPTIONS', headers: {origin, 'access-control-request-method': method, 'access-control-request-headers': 'content-type,x-csrf-token'}})));
    expect(mutationPreflights.every(response => response.status === 204)).toBe(true);
    for (const response of mutationPreflights) {
      const methods = response.headers.get('access-control-allow-methods') ?? '';
      expect(methods).toContain('PATCH');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
      expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-csrf-token');
    }
    const denied = await fetch(`${base}/me`, {method: 'OPTIONS', headers: {origin: 'https://evil.example', 'access-control-request-method': 'GET'}});
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
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
    const first = await json<{csrfToken: string; user: {username: string}}>(await request('/me'));
    const second = await json<{csrfToken: string}>(await request('/me'));
    expect(first.csrfToken).toBe(csrf);
    expect(second.csrfToken).toBe(csrf);
    expect(first.user.username).toMatch(/^user_[a-f0-9]{32}$/);
  });
  it('updates and serves a safe public profile', async () => {
    const username = `learner_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const updated = await json<PublicProfile>(await request('/profiles/me', {method: 'PATCH', body: JSON.stringify({username, displayName: 'Integration Learner', bio: 'Solving carefully.', location: 'Casablanca', website: 'https://example.com'})}));
    expect(updated).toMatchObject({username, displayName: 'Integration Learner', bio: 'Solving carefully.', location: 'Casablanca', website: 'https://example.com'});
    const publicProfile = await json<PublicProfile>(await request(`/profiles/${username}`, {headers: {cookie: ''}}));
    expect(publicProfile.stats.totalSubmissions).toBe(0);
    expect(publicProfile).not.toHaveProperty('issuer');
    expect(JSON.stringify(publicProfile)).not.toContain('sourceCode');
    expect((await request('/profiles/me', {method: 'PATCH', body: JSON.stringify({username: 'admin'})})).status).toBe(400);
  });
  it('creates, lists, replies to and idempotently likes a public discussion', async () => {
    expect((await request('/problems/sum-two-numbers/discussions', {method: 'POST', headers: {cookie: ''}, body: JSON.stringify({title: 'Unauthenticated question', body: 'This must not be accepted.'})})).status).toBe(401);
    expect((await request('/problems/sum-two-numbers/discussions', {method: 'POST', body: JSON.stringify({title: 'Client-selected moderation', body: 'This must not be accepted.', status: 'VISIBLE'})})).status).toBe(400);
    const thread = await json<DiscussionPost>(await request('/problems/sum-two-numbers/discussions', {method: 'POST', body: JSON.stringify({title: 'How should overflow be handled?', body: 'I am reasoning about the input bounds without sharing a full solution.'})}));
    expect(thread).toMatchObject({title: 'How should overflow be handled?', replyCount: 0, likeCount: 0});
    expect(thread.author.username).toMatch(/^[a-z0-9][a-z0-9_]{1,38}[a-z0-9]$/);
    const reply = await json<DiscussionPost>(await request(`/discussions/${thread.id}/replies`, {method: 'POST', body: JSON.stringify({body: 'Use the published constraints to choose the numeric range.'})}));
    expect(reply).not.toHaveProperty('title');
    await expect(db.discussionPost.create({data: {problemId: sampleProblemId, authorId: ownerId, parentId: reply.id, body: 'Nested reply'}})).rejects.toThrow();
    const liked = await json<DiscussionLikeState>(await request(`/discussions/${thread.id}/like`, {method: 'PUT'}));
    const likedAgain = await json<DiscussionLikeState>(await request(`/discussions/${thread.id}/like`, {method: 'PUT'}));
    expect(liked).toMatchObject({liked: true, likeCount: 1});
    expect(likedAgain.likeCount).toBe(1);
    const listed = await json<{items: DiscussionPost[]}>(await request('/problems/sum-two-numbers/discussions', {headers: {cookie: ''}}));
    expect(listed.items[0]).toMatchObject({id: thread.id, replyCount: 1, likeCount: 1});
    const replies = await json<{items: DiscussionPost[]}>(await request(`/discussions/${thread.id}/replies`, {headers: {cookie: ''}}));
    expect(replies.items).toContainEqual(expect.objectContaining({id: reply.id}));
    expect(JSON.stringify(listed)).not.toContain('issuer');
  });
  it('enforces the shared discussion write quota in PostgreSQL', async () => {
    await db.discussionRateLimit.deleteMany({where: {userId: ownerId}});
    const responses = [];
    for (let index = 0; index < 11; index++) responses.push(await request('/problems/sum-two-numbers/discussions', {method: 'POST', body: JSON.stringify({title: `Bounded question ${index}`, body: 'A bounded, constructive question.'})}));
    expect(responses.slice(0, 10).every(response => response.status === 201)).toBe(true);
    expect(responses[10]?.status).toBe(429);
    expect(responses[10]?.headers.get('retry-after')).toBe('60');
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
  it('derives public profile statistics and deterministic leaderboard ranks from trusted submits', async () => {
    const accepted = await db.execution.create({data: {userId: ownerId, problemVersionId: sampleVersionId, language: 'python', mode: 'SUBMIT', sourceCode: 'print(5)', payloadHash: 'b'.repeat(64), idempotencyKey: `profile-${crypto.randomUUID()}`}});
    await db.execution.update({where: {id: accepted.id}, data: {state: 'COMPILING'}});
    await db.execution.update({where: {id: accepted.id}, data: {state: 'FINISHED', verdict: 'ACCEPTED', runtimeMs: 42, memoryKiB: 1024, finishedAt: new Date()}});
    const self = await json<PublicProfile>(await request('/profiles/me'));
    expect(self.stats).toMatchObject({acceptedSubmissions: 1, problemsSolved: 1});
    expect(self.languages).toContainEqual({language: 'python', submissions: 2, accepted: 1});
    expect(self.recentSubmissions[0]).not.toHaveProperty('sourceCode');
    const board = await json<{items: LeaderboardEntry[]}>(await request('/leaderboard', {headers: {cookie: ''}}));
    expect(board.items[0]).toMatchObject({rank: 1, username: self.username, problemsSolved: 1, acceptedSubmissions: 1});
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
