import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { DiscussionLikeState, DiscussionPost, LeaderboardEntry, ProblemDetail, PublicProfile, SubmissionSummary } from '@arenacore/contracts';
async function json<T>(response: Response): Promise<T> { return await response.json() as T; }
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApp } from '../apps/api/src/bootstrap';
import { Config } from '../apps/api/src/config/config';
import { newSessionSecrets } from '../apps/api/src/auth/session';
import {hashPassword} from '../apps/api/src/auth/password';
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
  let otherCsrf: string;
  let reportId: string;
  let jobId: string;
  const origin = 'http://localhost:3000';
  const input = {problemId: sampleProblemId, language: 'python', mode: 'SUBMIT', sourceCode: 'print(5)'};
  const key = 'integration-request-key-001';
  async function request(path: string, options: RequestInit = {}, asOther = false) {
    return fetch(`${base}${path}`, {...options, headers: {cookie: asOther ? otherCookie : cookie, origin, 'x-csrf-token': asOther?otherCsrf:csrf, 'content-type': 'application/json', ...options.headers}});
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
    otherCsrf=sessions[1]!.csrfToken;
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
    const draftProblem=await db.problem.create({data:{slug:`invalid-file-${crypto.randomUUID()}`}});
    const draftVersion=await db.problemVersion.create({data:{problemId:draftProblem.id,number:1,title:'Invalid file contract',difficulty:'EASY',tags:[],statementMarkdown:'This draft deliberately violates the file input contract.',constraints:[],timeMs:1000,memoryKiB:65536,inputMode:'FILES',templates:{java:'x',python:'x',javascript:'x'}}});
    await db.testCase.create({data:{problemVersionId:draftVersion.id,ordinal:0,visibility:'PUBLIC',input:'stdin is forbidden',expectedOutput:'x'}});
    await expect(db.problemVersion.update({where:{id:draftVersion.id},data:{published:true}})).rejects.toThrow();
    await db.testCase.deleteMany({where:{problemVersionId:draftVersion.id}});await db.problemVersion.delete({where:{id:draftVersion.id}});await db.problem.delete({where:{id:draftProblem.id}});
  });
  it('fails closed without session and on bad CSRF/origin', async () => {
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {cookie: '', 'idempotency-key': key}})).status).toBe(401);
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {'x-csrf-token': 'invalid', 'idempotency-key': key}})).status).toBe(403);
    expect((await request('/executions', {method: 'POST', body: JSON.stringify(input), headers: {origin: 'https://evil.example', 'idempotency-key': key}})).status).toBe(403);
  });
  it('returns stable CSRF tokens across me calls', async () => {
    const first = await json<{csrfToken: string; user: {username: string; role: string}}>(await request('/me'));
    const second = await json<{csrfToken: string}>(await request('/me'));
    expect(first.csrfToken).toBe(csrf);
    expect(second.csrfToken).toBe(csrf);
    expect(first.user.username).toMatch(/^user_[a-f0-9]{32}$/);
    expect(first.user.role).toBe('USER');
  });
  it('serves published competitions, registers once and returns a safe scoreboard', async () => {
    const catalog = await json<{items: Array<{slug:string;kind:string}>}>(await request('/competitions?kind=CONTEST', {headers:{cookie:''}}));
    expect(catalog.items).toContainEqual(expect.objectContaining({slug:'weekend-sprint',kind:'CONTEST'}));
    const detail = await json<{rounds:Array<{problems:Array<{id:string}>}>}>(await request('/competitions/weekend-sprint', {headers:{cookie:''}}));
    expect(detail.rounds[0]?.problems).toContainEqual(expect.objectContaining({id:sampleProblemId}));
    expect(JSON.stringify(detail)).not.toContain('expectedOutput');
    expect((await request('/competitions/weekend-sprint/register', {method:'POST'})).status).toBe(200);
    expect((await request('/competitions/weekend-sprint/register', {method:'POST'})).status).toBe(200);
    expect(await json(await request('/competitions/weekend-sprint/registration'))).toMatchObject({registered:true});
    const board = await json<{items:Array<{username:string;score:number}>}>(await request('/competitions/weekend-sprint/leaderboard', {headers:{cookie:''}}));
    expect(board.items).toContainEqual(expect.objectContaining({score:0}));
    expect(JSON.stringify(board)).not.toContain('sourceCode');
    const startsAt=new Date(Date.now()+10*60_000),endsAt=new Date(Date.now()+70*60_000);
    const created=await json<{id:string;slug:string;kind:string}>(await request('/competitions',{method:'POST',body:JSON.stringify({slug:`community-${crypto.randomUUID()}`,kind:'CONTEST',title:'Community Integration Contest',description:'A user-owned event created through the public API.',rulesMarkdown:'Highest score wins this carefully bounded event.',startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),rounds:[{title:'Main round',startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),problemSlugs:['sum-two-numbers']}]})}));
    expect(created.kind).toBe('CONTEST');
    expect(await db.competition.findUniqueOrThrow({where:{id:created.id},select:{ownerId:true}})).toMatchObject({ownerId});
    expect(await json(await request('/competitions/mine'))).toMatchObject({items:[expect.objectContaining({id:created.id})]});
    expect((await request(`/competitions/${created.slug}/manage`,{},true)).status).toBe(403);
    expect(await json(await request(`/competitions/${created.slug}/registrations`))).toMatchObject({items:[expect.objectContaining({joinedAt:expect.any(String)})]});
    expect(await json(await request(`/competitions/${created.slug}/submissions`))).toMatchObject({items:[]});
    expect(await json(await request(`/competitions/${created.slug}/manage/leaderboard`))).toMatchObject({items:[expect.objectContaining({score:0})]});
    const updatedStarts=new Date(Date.now()+12*60_000),updatedEnds=new Date(Date.now()+80*60_000);
    expect((await request(`/competitions/${created.slug}`,{method:'PATCH',body:JSON.stringify({slug:created.slug,kind:'CONTEST',title:'Updated Community Contest',description:'The owner updated this event before its start.',rulesMarkdown:'Highest score still wins this bounded event.',startsAt:updatedStarts.toISOString(),endsAt:updatedEnds.toISOString(),rounds:[{title:'Updated round',startsAt:updatedStarts.toISOString(),endsAt:updatedEnds.toISOString(),problemSlugs:['sum-two-numbers']}]})})).status).toBe(200);
    expect((await json<{title:string}>(await request(`/competitions/${created.slug}/manage`))).title).toBe('Updated Community Contest');
    expect((await request('/executions',{method:'POST',headers:{'idempotency-key':'future-competition-job'},body:JSON.stringify({...input,competitionSlug:created.slug})})).status).toBe(409);
    await db.auditEvent.deleteMany({where:{targetId:created.id}});
    await db.competition.delete({where:{id:created.id}});
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
  it('persists account preferences, manages sessions, changes passwords, and safely deactivates',async()=>{
    const email=`account-${crypto.randomUUID()}@example.test`,oldPassword='correct horse battery staple',newPassword='a newer correct horse battery staple';
    const account=await db.user.create({data:{issuer:'arenacore:password',subject:email,displayName:'Account Owner',credential:{create:{email,passwordHash:await hashPassword(oldPassword)}}},select:{id:true,username:true}});
    const first=newSessionSecrets(),second=newSessionSecrets();
    await db.session.createMany({data:[{userId:account.id,tokenHash:first.tokenHash,csrfTokenHash:first.csrfTokenHash,expiresAt:new Date(Date.now()+600_000)},{userId:account.id,tokenHash:second.tokenHash,csrfTokenHash:second.csrfTokenHash,expiresAt:new Date(Date.now()+600_000)}]});
    const accountRequest=(path:string,options:RequestInit={})=>fetch(`${base}${path}`,{...options,headers:{cookie:`arenacore_session=${first.token}`,origin,'x-csrf-token':first.csrfToken,'content-type':'application/json',...options.headers}});
    try{
      expect(await json(await accountRequest('/account/settings'))).toMatchObject({email,hasPassword:true,profileVisibility:'PUBLIC',themePreference:'SYSTEM'});
      expect((await accountRequest('/account/settings',{method:'PATCH',body:JSON.stringify({profileVisibility:'PRIVATE',themePreference:'LIGHT',productNotifications:false})})).status).toBe(200);
      expect((await accountRequest(`/profiles/${account.username}`,{headers:{cookie:''}})).status).toBe(404);
      expect((await accountRequest('/profiles/me')).status).toBe(200);
      const active=await json<{items:Array<{id:string;current:boolean}>}>(await accountRequest('/account/sessions'));
      expect(active.items).toHaveLength(2);expect(active.items.filter(item=>item.current)).toHaveLength(1);
      expect(await json(await accountRequest('/account/sessions',{method:'DELETE'}))).toMatchObject({revoked:1});
      expect((await accountRequest('/account/password',{method:'PATCH',body:JSON.stringify({currentPassword:'wrong password value',newPassword})})).status).toBe(401);
      expect((await accountRequest('/account/password',{method:'PATCH',body:JSON.stringify({currentPassword:oldPassword,newPassword})})).status).toBe(200);
      const changedEmail=`changed-${crypto.randomUUID()}@example.test`;
      expect((await accountRequest('/account/email',{method:'PATCH',body:JSON.stringify({currentPassword:newPassword,newEmail:changedEmail})})).status).toBe(200);
      expect(await db.credential.findUnique({where:{email:changedEmail},select:{user:{select:{subject:true}}}})).toMatchObject({user:{subject:changedEmail}});
      expect((await accountRequest('/account',{method:'DELETE',body:JSON.stringify({confirmation:'DELETE',currentPassword:newPassword})})).status).toBe(200);
      const deleted=await db.user.findUniqueOrThrow({where:{id:account.id},select:{displayName:true,deactivatedAt:true,credential:true,sessions:{where:{revokedAt:null}}}});
      expect(deleted).toMatchObject({displayName:'Deleted user',credential:null,sessions:[]});expect(deleted.deactivatedAt).toBeInstanceOf(Date);
      expect((await accountRequest('/account/settings')).status).toBe(401);
    }finally{
      await db.auditEvent.deleteMany({where:{actorId:account.id}});await db.user.delete({where:{id:account.id}}).catch(()=>undefined);
    }
  });
  it('isolates, paginates, and updates persisted notifications while respecting competition preferences',async()=>{
    expect((await request('/notifications',{headers:{cookie:''}})).status).toBe(401);
    const own=await db.notification.create({data:{userId:ownerId,kind:'PRODUCT',title:'Platform update',body:'A safe product notification.',href:'/problems',dedupeKey:`test:${crypto.randomUUID()}`}});
    const other=await db.notification.create({data:{userId:otherId,kind:'PRODUCT',title:'Private update',body:'This belongs to another user.',dedupeKey:`test:${crypto.randomUUID()}`}});
    const first=await json<{items:Array<{id:string;readAt:string|null}>;nextCursor:string|null;unreadCount:number}>(await request('/notifications'));
    expect(first.items).toContainEqual(expect.objectContaining({id:own.id,readAt:null}));expect(first.items).not.toContainEqual(expect.objectContaining({id:other.id}));expect(first.unreadCount).toBeGreaterThanOrEqual(1);
    expect((await request(`/notifications?cursor=${other.id}`)).status).toBe(400);
    expect(await json(await request(`/notifications/${own.id}/read`,{method:'PATCH'}))).toMatchObject({id:own.id,readAt:expect.any(String)});
    expect((await request(`/notifications/${other.id}/read`,{method:'PATCH'})).status).toBe(404);
    expect(await json(await request('/notifications/read-all',{method:'PATCH'}))).toMatchObject({updated:expect.any(Number)});
    expect(await json(await request('/notifications/unread-count'))).toEqual({unreadCount:0});
    const weekend=await db.competition.findUniqueOrThrow({where:{slug:'weekend-sprint'},select:{id:true}});
    await request('/competitions/weekend-sprint/register',{method:'POST'});
    await request('/competitions/weekend-sprint/register',{method:'POST'});
    expect(await db.notification.count({where:{userId:ownerId,dedupeKey:`competition:${weekend.id}:registration`}})).toBe(1);
    await db.user.update({where:{id:ownerId},data:{competitionNotifications:false}});
    try{await request('/competitions/arena-open/register',{method:'POST'});expect(await db.notification.count({where:{userId:ownerId,kind:'COMPETITION_REGISTRATION',href:'/tournaments/arena-open'}})).toBe(0);}finally{await db.user.update({where:{id:ownerId},data:{competitionNotifications:true}});}
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
    const otherThread=await json<DiscussionPost>(await request('/problems/sum-two-numbers/discussions',{method:'POST',body:JSON.stringify({title:'Is this discussion appropriate?',body:'This post is used to verify the real moderation workflow.'})},true));
    const report=await json<{id:string;status:string}>(await request(`/discussions/${otherThread.id}/reports`,{method:'POST',body:JSON.stringify({reason:'OFF_TOPIC',details:'This discussion does not address the problem statement.'})}));
    reportId=report.id;
    expect(report.status).toBe('PENDING');
    expect((await request(`/discussions/${otherThread.id}/reports`,{method:'POST',body:JSON.stringify({reason:'SPAM'})})).status).toBe(409);
    const ownReports=await json<{items:unknown[]}>(await request('/reports/me'));
    expect(ownReports).toMatchObject({items:[{id:reportId,status:'PENDING'}]});
    expect(JSON.stringify(ownReports)).not.toContain('moderatorNote');
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
  it('protects admin data by role and exposes only safe operational projections', async () => {
    expect((await request('/admin/overview')).status).toBe(403);
    await db.user.update({where:{id:ownerId},data:{role:'ADMIN'}});
    const me = await json<{user:{role:string}}>(await request('/me'));
    expect(me.user.role).toBe('ADMIN');
    const overview = await json<{stats:{users:number};recentSubmissions:unknown[]}>(await request('/admin/overview'));
    expect(overview.stats.users).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(overview)).not.toContain('sourceCode');
    const analytics=await json<{period:{days:number};stats:{submissions:number;accepted:number;activeUsers:number};daily:Array<{date:string;submissions:number}>;topProblems:unknown[]}>(await request('/admin/analytics?days=30'));
    expect(analytics.period.days).toBe(30);
    expect(analytics.daily).toHaveLength(30);
    expect(analytics.stats.submissions).toBeGreaterThanOrEqual(analytics.stats.accepted);
    expect(JSON.stringify(analytics)).not.toMatch(/sourceCode|expectedOutput|passwordHash|issuer/);
    const exported=await json<{filename:string;contentType:string;content:string}>(await request('/admin/analytics/export?days=7'));
    expect(exported).toMatchObject({contentType:'text/csv'});
    expect(exported.filename).toMatch(/^arenacore-analytics-.*\.csv$/);
    expect(exported.content.split('\n')[0]).toBe('"date","submissions","accepted","active_users"');
    expect((await request('/admin/analytics?days=365')).status).toBe(400);
    const users = await json<{items:Array<{id:string;role:string}>}>(await request('/admin/users'));
    expect(users.items).toContainEqual(expect.objectContaining({id:ownerId,role:'ADMIN'}));
    expect((await request(`/admin/users/${ownerId}/role`, {method:'PATCH',body:JSON.stringify({role:'USER'})})).status).toBe(409);
    expect(await json(await request(`/admin/users/${otherId}/role`,{method:'PATCH',body:JSON.stringify({role:'MODERATOR'})}))).toMatchObject({role:'MODERATOR'});
    const queue=await json<{items:Array<{id:string;post:{body:string}}> }>(await request('/admin/moderation',{},true));
    expect(queue.items).toContainEqual(expect.objectContaining({id:reportId}));
    expect(JSON.stringify(queue)).not.toContain('issuer');
    expect((await request('/admin/users',{},true)).status).toBe(403);
    expect(await json(await request(`/admin/reports/${reportId}`,{method:'PATCH',body:JSON.stringify({status:'RESOLVED',moderatorNote:'Reviewed and hidden because it was unrelated.',postStatus:'HIDDEN'})},true))).toMatchObject({status:'RESOLVED'});
    expect((await json<{items:unknown[]}>(await request('/admin/moderation',{},true))).items).toHaveLength(0);
    const history=await json<{items:Array<{id:string;status:string;moderatorNote:string;moderator:{username:string}|null}>;nextCursor:string|null}>(await request('/admin/moderation?status=RESOLVED',{},true));
    expect(history.items).toContainEqual(expect.objectContaining({id:reportId,status:'RESOLVED',moderatorNote:'Reviewed and hidden because it was unrelated.',moderator:expect.objectContaining({username:expect.any(String)})}));
    expect((await request(`/admin/moderation?cursor=${reportId}`,{},true)).status).toBe(400);
    expect((await request('/admin/moderation?status=INVALID',{},true)).status).toBe(400);
    const bulkPosts=await Promise.all(['First bulk review target','Second bulk review target'].map((title,index)=>db.discussionPost.create({data:{problemId:sampleProblemId,authorId:ownerId,title,body:`Bulk moderation body ${index}.`}})));
    const bulkReports=await Promise.all(bulkPosts.map((post,index)=>db.contentReport.create({data:{postId:post.id,reporterId:otherId,reason:'SPAM',details:`Bulk report ${index}.`}})));
    const bulkDecision=await json<{items:Array<{id:string;status:string}>}>(await request('/admin/reports',{method:'PATCH',body:JSON.stringify({reportIds:bulkReports.map(report=>report.id),status:'DISMISSED',moderatorNote:'Reviewed together as the same benign pattern.'})}));
    expect(bulkDecision.items).toHaveLength(2);
    expect(bulkDecision.items.every(item=>item.status==='DISMISSED')).toBe(true);
    expect(await db.auditEvent.count({where:{targetId:{in:bulkReports.map(report=>report.id)},action:'CONTENT_REPORT_DISMISSED'}})).toBe(2);
    const pendingPost=await db.discussionPost.create({data:{problemId:sampleProblemId,authorId:ownerId,title:'Atomic bulk target',body:'This report must remain pending after a mixed-state request.'}});
    const pendingReport=await db.contentReport.create({data:{postId:pendingPost.id,reporterId:otherId,reason:'OTHER'}});
    expect((await request('/admin/reports',{method:'PATCH',body:JSON.stringify({reportIds:[bulkReports[0]!.id,pendingReport.id],status:'RESOLVED',moderatorNote:'This mixed decision must roll back.'})})).status).toBe(409);
    expect(await db.contentReport.findUniqueOrThrow({where:{id:pendingReport.id},select:{status:true}})).toMatchObject({status:'PENDING'});
    expect((await request('/admin/reports',{method:'PATCH',body:JSON.stringify({reportIds:[pendingReport.id,pendingReport.id],status:'DISMISSED',moderatorNote:'Duplicate identifiers are invalid.'})})).status).toBe(400);
    await request(`/admin/users/${otherId}/role`,{method:'PATCH',body:JSON.stringify({role:'USER'})});
    const until=new Date(Date.now()+60_000).toISOString();
    expect(await json(await request(`/admin/users/${otherId}/restriction`,{method:'PATCH',body:JSON.stringify({action:'SUSPEND',until,reason:'Temporary integration-test restriction.'})}))).toMatchObject({restrictionReason:'Temporary integration-test restriction.'});
    const restrictedSecrets=newSessionSecrets();
    await db.session.create({data:{userId:otherId,tokenHash:restrictedSecrets.tokenHash,csrfTokenHash:restrictedSecrets.csrfTokenHash,expiresAt:new Date(Date.now()+600_000)}});
    const restricted=await request('/submissions',{headers:{cookie:`arenacore_session=${restrictedSecrets.token}`}},true);
    expect(restricted.status).toBe(403);
    expect((await json<{error:{code:string}}>(restricted)).error.code).toBe('ACCOUNT_SUSPENDED');
    expect((await request('/auth/logout',{method:'POST',headers:{cookie:`arenacore_session=${restrictedSecrets.token}`,'x-csrf-token':restrictedSecrets.csrfToken}},true)).status).toBe(200);
    await request(`/admin/users/${otherId}/restriction`,{method:'PATCH',body:JSON.stringify({action:'CLEAR'})});
    const problemSlug=`draft-${crypto.randomUUID()}`;
    const created=await json<{id:string;published:boolean}>(await request('/admin/problems',{method:'POST',body:JSON.stringify({slug:problemSlug,title:'Integration Draft Problem',difficulty:'EASY',tags:['integration'],statementMarkdown:'Read the input and produce the required deterministic output.',constraints:['Input is bounded.'],timeMs:1000,memoryKiB:65536,templates:{java:'class Solution {}',python:'# solution',javascript:'// solution'},tests:[{visibility:'PUBLIC',input:'1\n',expectedOutput:'1\n'},{visibility:'HIDDEN',input:'2\n',expectedOutput:'2\n'}],publish:false})}));
    expect(created.published).toBe(false);
    expect(await json(await request(`/admin/problems/${created.id}`))).toMatchObject({slug:problemSlug,version:{number:1}});
    const edited=await json<{versionId:string;published:boolean}>(await request(`/admin/problems/${created.id}`,{method:'PATCH',body:JSON.stringify({slug:problemSlug,title:'Edited Integration Draft',difficulty:'MEDIUM',tags:['integration'],statementMarkdown:'This edited version remains immutable after publication.',constraints:['Input remains bounded.'],timeMs:1200,memoryKiB:65536,templates:{java:'class Solution {}',python:'# solution',javascript:'// solution'},tests:[{visibility:'PUBLIC',input:'1\n',expectedOutput:'1\n'},{visibility:'HIDDEN',input:'2\n',expectedOutput:'2\n'}],publish:false})}));
    expect(edited.published).toBe(false);
    expect(await json(await request(`/admin/problems/${created.id}/publication`,{method:'PATCH',body:JSON.stringify({published:true})}))).toMatchObject({published:true,currentVersionId:edited.versionId});
    expect((await request(`/admin/problems/${created.id}/publication`,{method:'PATCH',body:JSON.stringify({published:false})})).status).toBe(200);
    expect((await request(`/admin/problems/${created.id}`,{method:'DELETE'})).status).toBe(409);
    const fileProblemSlug=`file-${crypto.randomUUID()}`;
    const fileProblem=await json<{id:string;versionId:string;published:boolean}>(await request('/admin/problems',{method:'POST',body:JSON.stringify({slug:fileProblemSlug,title:'File Input Integration Problem',difficulty:'MEDIUM',tags:['files'],statementMarkdown:'Read values from the declared input text file and print their sum.',constraints:['The file contains two bounded integers.'],timeMs:1000,memoryKiB:65536,inputMode:'FILES',templates:{java:'// read input.txt',python:'open("input.txt")',javascript:'readFileSync("input.txt")'},tests:[{visibility:'PUBLIC',input:'',files:[{name:'input.txt',content:'1 2\n'}],expectedOutput:'3\n'},{visibility:'HIDDEN',input:'',files:[{name:'secret.txt',content:'PRIVATE_FILE_CONTENT'}],expectedOutput:'7\n'}],publish:true})}));
    expect(fileProblem.published).toBe(true);
    const fileDetail=await json<ProblemDetail>(await request(`/problems/${fileProblemSlug}`));
    expect(fileDetail).toMatchObject({difficulty:'MEDIUM',inputMode:'FILES',examples:[{input:'',files:[{name:'input.txt',content:'1 2\n'}],expectedOutput:'3\n'}]});
    expect(JSON.stringify(fileDetail)).not.toContain('PRIVATE_FILE_CONTENT');
    const publicFile=await db.testCaseFile.findFirstOrThrow({where:{testCase:{problemVersionId:fileProblem.versionId,visibility:'PUBLIC'}}});
    await expect(db.testCaseFile.update({where:{testCaseId_name:{testCaseId:publicFile.testCaseId,name:publicFile.name}},data:{content:'tampered'}})).rejects.toThrow();
    const competitionSlug=`competition-${crypto.randomUUID()}`;
    const startsAt=new Date(Date.now()+3_600_000),endsAt=new Date(Date.now()+7_200_000);
    const competition=await json<{id:string;published:boolean}>(await request('/admin/competitions',{method:'POST',body:JSON.stringify({slug:competitionSlug,kind:'CONTEST',title:'Integration Contest',description:'A safely created integration contest.',rulesMarkdown:'Highest score wins this integration contest.',startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),published:false,rounds:[{title:'Main round',startsAt:startsAt.toISOString(),endsAt:endsAt.toISOString(),problemSlugs:['sum-two-numbers']}]})}));
    expect(competition.published).toBe(false);
    const competitions=await json<{items:Array<{id:string}>}>(await request('/admin/competitions'));
    expect(competitions.items).toContainEqual(expect.objectContaining({id:competition.id}));
    expect(await json(await request(`/admin/competitions/${competition.id}/publication`,{method:'PATCH',body:JSON.stringify({published:true})}))).toMatchObject({published:true});
    expect((await request(`/admin/competitions/${competition.id}`,{method:'DELETE'})).status).toBe(200);
  });
  it('execution switch fails closed and logout revokes the session', async () => {
    app.get(Config).values.EXECUTIONS_ENABLED = 'false';
    expect((await request('/executions', {method: 'POST', headers: {'idempotency-key': `${key}-disabled`}, body: JSON.stringify(input)})).status).toBe(503);
    expect((await request('/auth/logout', {method: 'POST'})).status).toBe(200);
    expect((await request('/submissions')).status).toBe(401);
  });
});
