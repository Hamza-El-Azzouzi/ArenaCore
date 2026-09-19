import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Queue, Worker } from 'bullmq';
import { io, Socket } from 'socket.io-client';
import { JudgingBackend, loadJudgePlan } from '../apps/runner/src/judging-backend';
import { SandboxCleanupError } from '@arenacore/contracts';
import { Database } from '../apps/api/src/database/database';
import { JobStore, REPLAY_ROWS, REPLAY_BYTES } from '../apps/api/src/executions/job-store';
import { OutboxDispatcher, redisOptions, startExecutionWorker } from '../apps/api/src/executions/queue';
import { newSessionSecrets } from '../apps/api/src/auth/session';
import { Config } from '../apps/api/src/config/config';
import { AppModule } from '../apps/api/src/app.module';
import { configureApp } from '../apps/api/src/bootstrap';
import { seed, sampleVersionId } from '../prisma/seed';

const suite=process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL?describe:describe.skip;
async function until(predicate:()=>Promise<boolean>|boolean) {
  const end=Date.now()+8000;
  while(!await predicate()) {if(Date.now()>end) throw new Error('Timed out');await new Promise(r=>setTimeout(r,30));}
}
suite('durable queue, leases, cancellation, public replay and socket authorization',()=>{
  let db:Database,jobs:JobStore,queue:Queue,dispatcher:OutboxDispatcher,userId:string,otherId:string,cookie:string,sessionId:string,caseId:string,hiddenId:string;
  const name=`test-${randomUUID()}`,sockets:Socket[]=[],workers:Worker[]=[],apps:NestExpressApplication[]=[],urls:string[]=[];
  beforeAll(async()=>{
    Object.assign(process.env,{DATABASE_URL:process.env.TEST_DATABASE_URL,NODE_ENV:'test',PUBLIC_ORIGIN:'http://localhost:3000',EXECUTIONS_ENABLED:'false',OIDC_ENABLED:'false',PIPELINE_ENABLED:'false',REALTIME_ENABLED:'true'});
    db=new Database(new Config());await db.$connect();await seed(db);jobs=new JobStore(db);
    userId=(await db.user.create({data:{issuer:'stage5',subject:randomUUID(),displayName:'Queue owner'}})).id;
    otherId=(await db.user.create({data:{issuer:'stage5',subject:randomUUID(),displayName:'Other owner'}})).id;
    const secrets=newSessionSecrets();cookie=`arenacore_session=${secrets.token}`;
    sessionId=(await db.session.create({data:{userId,tokenHash:secrets.tokenHash,csrfTokenHash:secrets.csrfTokenHash,expiresAt:new Date(Date.now()+3600000)}})).id;
    const cases=await db.testCase.findMany({where:{problemVersionId:sampleVersionId}});
    caseId=cases.find(c=>c.visibility==='PUBLIC')!.id;hiddenId=cases.find(c=>c.visibility==='HIDDEN')!.id;
    queue=new Queue(name,{connection:redisOptions(process.env.TEST_REDIS_URL!)});queue.on('error',()=>{});await queue.waitUntilReady();dispatcher=new OutboxDispatcher(db,queue);
    for(let i=0;i<2;i++) {
      const config=new Config();
      const module=await Test.createTestingModule({imports:[AppModule]}).overrideProvider(Config).useValue(config).compile();
      const app=configureApp(module.createNestApplication<NestExpressApplication>({bodyParser:false,logger:false}));
      await app.listen(0,'127.0.0.1');apps.push(app);urls.push(await app.getUrl());
    }
  });
  beforeEach(async()=>{
    await Promise.all(workers.splice(0).map(w=>w.close()));sockets.splice(0).forEach(s=>s.disconnect());
    await queue.obliterate({force:true});await db.execution.deleteMany({where:{userId:{in:[userId,otherId]}}});
    await db.session.update({where:{id:sessionId},data:{revokedAt:null,expiresAt:new Date(Date.now()+3600000)}});
  });
  afterAll(async()=>{
    sockets.forEach(s=>s.disconnect());await Promise.all(workers.map(w=>w.close()));await Promise.all(apps.map(a=>a.close()));
    if(queue){await queue.obliterate({force:true});await queue.close();}
    if(db){await db.execution.deleteMany({where:{userId:{in:[userId,otherId]}}});await db.user.deleteMany({where:{id:{in:[userId,otherId]}}});await db.$disconnect();}
    process.env.REALTIME_ENABLED='false';
  });
  async function fixture(mode:'RUN'|'SUBMIT'='RUN',owner=userId) {
    const row=await db.execution.create({data:{userId:owner,problemVersionId:sampleVersionId,language:'python',mode,sourceCode:'PRIVATE_SOURCE_SENTINEL',payloadHash:'a'.repeat(64),idempotencyKey:randomUUID(),queueExpiresAt:new Date(Date.now()+60000)}});
    await db.outboxEvent.create({data:{executionId:row.id,kind:'EXECUTION_CREATED'}});return row;
  }
  async function expire(id:string) {await db.execution.update({where:{id},data:{leaseExpiresAt:new Date(Date.now()-1)}});}
  function worker(backend:Parameters<typeof startExecutionWorker>[3]) {const w=startExecutionWorker(jobs,process.env.TEST_REDIS_URL!,name,backend);workers.push(w);return w;}
  async function connect(instance=0,headers:Record<string,string>={cookie,origin:'http://localhost:3000'}) {
    const socket=io(`${urls[instance]}/executions`,{transports:['websocket'],extraHeaders:headers,reconnection:false,timeout:2000});sockets.push(socket);
    await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Socket connection failed')),3000);socket.once('connect',()=>{clearTimeout(timeout);resolve();});socket.once('connect_error',e=>{clearTimeout(timeout);reject(e);});socket.once('disconnect',()=>{clearTimeout(timeout);reject(new Error('Socket disconnected'));});});return socket;
  }
  async function subscribe(socket:Socket,id:string,attempt=0,afterSequence=0) {
    return socket.timeout(3000).emitWithAck('subscribe_execution',{executionId:id,attempt,afterSequence}) as Promise<{ok:boolean;replayAvailable:boolean;snapshot:{lastSequence:number;state:string};events:unknown[];error?:{code:string}}>;
  }
  it('dispatches ID-only work and survives enqueue-before-ack duplication',async()=>{
    const row=await fixture();await dispatcher.tick();
    const qjob=await queue.getJob(`exec-${row.id}-g0`);expect(qjob!.data).toEqual({executionId:row.id});
    await db.outboxEvent.updateMany({where:{executionId:row.id},data:{publishedAt:null}});await dispatcher.tick();
    expect(await queue.getWaitingCount()).toBe(1);expect(await db.outboxEvent.count({where:{executionId:row.id,publishedAt:{not:null}}})).toBe(1);
  });
  it('fences the acknowledgement after a dispatch claim is replaced',async()=>{
    const row=await fixture();const add=queue.add.bind(queue);
    const spy=vi.spyOn(queue,'add').mockImplementationOnce(async(...args)=>{const job=await add(...args);await db.outboxEvent.updateMany({where:{executionId:row.id},data:{dispatchToken:randomUUID(),dispatchExpiresAt:new Date(Date.now()+10000)}});return job;});
    try {await dispatcher.tick();expect((await db.outboxEvent.findFirstOrThrow({where:{executionId:row.id}})).publishedAt).toBeNull();} finally {spy.mockRestore();}
    await db.outboxEvent.updateMany({where:{executionId:row.id},data:{dispatchExpiresAt:new Date(0)}});await dispatcher.tick();expect(await queue.getWaitingCount()).toBe(1);
  });
  it('dispatches a shared intent once under concurrent dispatchers',async()=>{
    const row=await fixture();await Promise.all([dispatcher.tick(),new OutboxDispatcher(db,queue).tick()]);expect(await queue.getWaitingCount()).toBe(1);expect((await db.outboxEvent.findFirstOrThrow({where:{executionId:row.id}})).dispatchAttempts).toBe(1);
  });
  it('executes one fenced attempt despite concurrent duplicate claims',async()=>{
    const row=await fixture();const claims=await Promise.all([jobs.claim(row.id),jobs.claim(row.id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);expect((await db.execution.findUniqueOrThrow({where:{id:row.id}})).attempt).toBe(1);
  });
  it('reclaims expired work and rejects every stale worker mutation',async()=>{
    const row=await fixture();const old=(await jobs.claim(row.id))!.lease;await jobs.markRunning(old);await expire(row.id);
    const current=(await jobs.claim(row.id))!.lease;expect(current.attempt).toBe(2);expect(current.token).not.toBe(old.token);
    expect(await jobs.renew(old)).toBe('LOST');expect(await jobs.markRunning(old)).toBe(false);expect(await jobs.console(old,caseId,'stdout','stale')).toBe(false);expect(await jobs.finish(old,{verdict:'ACCEPTED'})).toBe(false);expect(await jobs.fail(old)).toBe(false);
    expect(await jobs.finish(current,{verdict:'WRONG_ANSWER'})).toBe(true);
  });
  it('rejects an expired token even before a successor claims',async()=>{
    const row=await fixture();const lease=(await jobs.claim(row.id))!.lease;await expire(row.id);expect(await jobs.finish(lease,{verdict:'ACCEPTED'})).toBe(false);
  });
  it('runs the BullMQ worker with a trusted test backend and persists terminal truth',async()=>{
    const row=await fixture();let calls=0;worker({execute:async ctx=>{calls++;await ctx.markRunning();await ctx.console(caseId,'stdout','5\n');return {verdict:'ACCEPTED',runtimeMs:3,publicCaseResults:[{caseId,verdict:'ACCEPTED',stdout:'5\n'}]};}});
    await dispatcher.tick();await until(async()=> (await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='FINISHED');expect(calls).toBe(1);
    const replay=await jobs.replay(userId,row.id,1,0);expect(replay.replayAvailable).toBe(true);expect(replay.events.map(e=>e.kind)).toEqual(['execution_status','execution_status','console_output','final_verdict']);expect(replay.snapshot.publicCaseResults![0]!.stdout).toBe('5\n');
  });
  it('judges a real queued Submit without publishing hidden diagnostics',async()=>{
    const row=await fixture('SUBMIT');
    const backend=new JudgingBackend({execute:async request=>{
      const cases=await db.testCase.findMany({where:{id:{in:request.cases.map(c=>c.id)}}});
      return {cases:request.cases.map(c=>{const test=cases.find(t=>t.id===c.id)!;return {caseId:c.id,stdout:test.visibility==='HIDDEN'?'SECRET_HIDDEN_OUTPUT':test.expectedOutput,stderr:'SECRET_HIDDEN_TRACE',exitCode:0,wallMs:1};})};
    }},(id,mode)=>loadJudgePlan(db,id,mode));
    worker(backend);await dispatcher.tick();await until(async()=>(await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='FINISHED');
    const stored=await db.execution.findUniqueOrThrow({where:{id:row.id}});expect(stored.verdict).toBe('WRONG_ANSWER');expect(stored.publicResults).toBeNull();
    const replay=await jobs.replay(userId,row.id,1,0);expect(JSON.stringify(replay)).not.toMatch(/SECRET_HIDDEN|PRIVATE_SOURCE_SENTINEL/);expect(replay.events.some(e=>e.kind==='console_output')).toBe(false);
  });
  it('judges public RUN cases and persists only public case results',async()=>{
    const row=await fixture('RUN');const backend=new JudgingBackend({execute:async request=>{
      const plan=await loadJudgePlan(db,row.problemVersionId,'RUN');expect(request.cases).toHaveLength(plan.cases.length);
      return {cases:plan.cases.map(c=>({caseId:c.id,stdout:c.expectedOutput,stderr:'',exitCode:0,wallMs:1}))};
    }},(id,mode)=>loadJudgePlan(db,id,mode));
    worker(backend);await dispatcher.tick();await until(async()=>(await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='FINISHED');
    const replay=await jobs.replay(userId,row.id,1,0);expect(replay.snapshot.verdict).toBe('ACCEPTED');expect(replay.snapshot.publicCaseResults).toHaveLength(2);expect(replay.events.filter(e=>e.kind==='console_output')).toHaveLength(2);expect(JSON.stringify(replay.snapshot.publicCaseResults)).not.toContain(hiddenId);
  });
  it('records cancellation as pending until the backend confirms cleanup',async()=>{
    const row=await fixture();let started=false,aborted=false,release!:()=>void;
    worker({execute:async ctx=>{started=true;await ctx.markRunning();await new Promise<void>(resolve=>{release=resolve;ctx.signal.addEventListener('abort',()=>{aborted=true;},{once:true});});return {verdict:'ACCEPTED'};}});
    await dispatcher.tick();await until(()=>started);await until(async()=>(await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='RUNNING');
    expect((await jobs.cancel(userId,row.id,true)).cancellationRequested).toBe(true);await until(()=>aborted);
    expect((await db.execution.findUniqueOrThrow({where:{id:row.id}})).state).toBe('RUNNING');release();
    await until(async()=>(await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='CANCELLED');
  });
  it('does not report cancellation when backend cleanup fails',async()=>{
    const row=await fixture();let started=false;worker({execute:async ctx=>{started=true;await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>resolve(),{once:true}));throw new SandboxCleanupError();}});await dispatcher.tick();await until(()=>started);await jobs.cancel(userId,row.id,true);await until(async()=>(await db.execution.findUniqueOrThrow({where:{id:row.id}})).state==='INTERNAL_ERROR');expect((await db.execution.findUniqueOrThrow({where:{id:row.id}})).failureCode).toBe('CANCELLATION_TIMEOUT');
  });
  it('does not label a lost cancelled worker as safely stopped',async()=>{
    const row=await fixture();await jobs.claim(row.id);await jobs.cancel(userId,row.id,true);await expire(row.id);await jobs.maintain();
    const result=await db.execution.findUniqueOrThrow({where:{id:row.id}});expect(result.state).toBe('INTERNAL_ERROR');expect(result.failureCode).toBe('CANCELLATION_TIMEOUT');
  });
  it('terminates after three abandoned attempts and fences terminal results',async()=>{
    const row=await fixture();for(let i=0;i<3;i++){await jobs.claim(row.id);await expire(row.id);}await jobs.maintain();expect((await db.execution.findUniqueOrThrow({where:{id:row.id}})).failureCode).toBe('LEASE_EXPIRED');expect(await jobs.claim(row.id)).toBeNull();
  });
  it('creates one recovery intent across concurrent maintainers',async()=>{
    const row=await fixture();await jobs.claim(row.id);await expire(row.id);await Promise.all([jobs.maintain(),jobs.maintain()]);expect(await db.outboxEvent.count({where:{executionId:row.id,kind:'EXECUTION_RECOVERY'}})).toBe(1);await dispatcher.tick();expect(await queue.getJob(`exec-${row.id}-g1`)).not.toBeUndefined();
  });
  it('reoffers durable queued work after Redis queue data is lost',async()=>{
    const row=await fixture();await dispatcher.tick();await queue.obliterate({force:true});await db.outboxEvent.updateMany({where:{executionId:row.id},data:{publishedAt:new Date(Date.now()-11000)}});await jobs.maintain();await dispatcher.tick();expect(await queue.getJob(`exec-${row.id}-g0`)).toBeTruthy();
  });
  it('keeps failed dispatch pending and retries after queue recovery',async()=>{
    const row=await fixture();const down=new Queue(`${name}-down`,{connection:{...redisOptions(process.env.TEST_REDIS_URL!),port:56380,retryStrategy:()=>null}});down.on('error',()=>{});
    await new OutboxDispatcher(db,down).tick();await down.close();const event=await db.outboxEvent.findFirstOrThrow({where:{executionId:row.id}});expect(event.publishedAt).toBeNull();expect(event.dispatchToken).toBeNull();expect(event.dispatchAttempts).toBe(1);
    await db.outboxEvent.update({where:{id:event.id},data:{nextDispatchAt:new Date(0)}});await dispatcher.tick();expect(await queue.getJob(`exec-${row.id}-g0`)).toBeTruthy();
  });
  it('never publishes hidden-case or Submit output',async()=>{
    const row=await fixture('SUBMIT');const lease=(await jobs.claim(row.id))!.lease;
    await expect(jobs.console(lease,caseId,'stdout','SECRET')).rejects.toThrow('PRIVATE_OUTPUT_REJECTED');await expect(jobs.finish(lease,{verdict:'ACCEPTED',publicCaseResults:[{caseId,verdict:'ACCEPTED',stdout:'SECRET'}]})).rejects.toThrow('PRIVATE_OUTPUT_REJECTED');
    await jobs.finish(lease,{verdict:'ACCEPTED'});expect(JSON.stringify(await jobs.replay(userId,row.id,1,0))).not.toMatch(/SECRET|PRIVATE_SOURCE_SENTINEL|leaseToken|payloadHash/);
    const run=await fixture();const runLease=(await jobs.claim(run.id))!.lease;await expect(jobs.console(runLease,hiddenId,'stdout','SECRET')).rejects.toThrow('PRIVATE_OUTPUT_REJECTED');await expect(jobs.finish(runLease,{verdict:'ACCEPTED',publicCaseResults:[{caseId:hiddenId,verdict:'ACCEPTED'}]})).rejects.toThrow('PRIVATE_OUTPUT_REJECTED');
  });
  it('sanitizes terminal controls and rejects oversized console chunks',async()=>{
    const row=await fixture();const lease=(await jobs.claim(row.id))!.lease;await jobs.console(lease,caseId,'stdout','\x1b[31mred\x1b[0m\x00\u202e\n');const replay=await jobs.replay(userId,row.id,1,0);const output=replay.events.at(-1)!;expect(output.kind).toBe('console_output');if(output.kind==='console_output') expect(output.text).toBe('red\n');await expect(jobs.console(lease,caseId,'stdout','x'.repeat(4097))).rejects.toThrow();
  });
  it('bounds replay rows and bytes and reports a gap with a durable snapshot',async()=>{
    const row=await fixture();const lease=(await jobs.claim(row.id))!.lease;
    for(let i=0;i<270;i++) await jobs.console(lease,caseId,'stdout','x'.repeat(1500));
    const stored=await db.executionEvent.findMany({where:{executionId:row.id}});expect(stored.length).toBeLessThanOrEqual(REPLAY_ROWS);expect(stored.reduce((a,e)=>a+e.bytes,0)).toBeLessThanOrEqual(REPLAY_BYTES);
    const replay=await jobs.replay(userId,row.id,1,0);expect(replay.replayAvailable).toBe(false);expect(replay.events).toEqual([]);expect(replay.snapshot.lastSequence).toBe(271);
    const tail=await jobs.replay(userId,row.id,1,270);expect(tail.events).toHaveLength(1);expect(tail.replayAvailable).toBe(true);
  });
  it('handles replay expiry, wrong attempt and cursor ahead without inventing events',async()=>{
    const row=await fixture();await jobs.claim(row.id);await db.executionEvent.updateMany({where:{executionId:row.id},data:{expiresAt:new Date(0)}});
    expect((await jobs.replay(userId,row.id,1,0)).replayAvailable).toBe(false);expect((await jobs.replay(userId,row.id,0,0)).replayAvailable).toBe(false);expect((await jobs.replay(userId,row.id,1,999)).replayAvailable).toBe(false);await jobs.maintain();expect(await db.executionEvent.count({where:{executionId:row.id}})).toBe(0);
  });
  it('rejects malformed stored payloads instead of leaking unknown fields',async()=>{
    const row=await fixture();await jobs.claim(row.id);await db.executionEvent.updateMany({where:{executionId:row.id},data:{payload:{executionId:row.id,attempt:1,sequence:1,kind:'execution_status',state:'COMPILING',sourceCode:'SECRET'}}});const result=await jobs.replay(userId,row.id,1,0);expect(result.replayAvailable).toBe(false);expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('filters accidentally stored hidden RUN results and rejects hidden replay',async()=>{
    const row=await fixture();await jobs.claim(row.id);await db.execution.update({where:{id:row.id},data:{publicResults:[{caseId:hiddenId,verdict:'ACCEPTED',stdout:'SECRET'}]}});
    expect((await jobs.replay(userId,row.id,1,0)).snapshot.publicCaseResults).toEqual([]);
    await db.executionEvent.updateMany({where:{executionId:row.id},data:{payload:{executionId:row.id,attempt:1,sequence:1,kind:'console_output',caseId:hiddenId,stream:'stdout',text:'SECRET'}}});
    const result=await jobs.replay(userId,row.id,1,0);expect(result.replayAvailable).toBe(false);expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  it('enforces the overall deadline for an abandoned active job',async()=>{
    const row=await db.execution.create({data:{userId,problemVersionId:sampleVersionId,language:'python',mode:'RUN',sourceCode:'x',payloadHash:'a'.repeat(64),idempotencyKey:randomUUID(),createdAt:new Date(Date.now()-1200000),queueExpiresAt:new Date(Date.now()-1100000)}});
    await db.execution.update({where:{id:row.id},data:{state:'COMPILING',attempt:1,leaseToken:randomUUID(),leaseExpiresAt:new Date(Date.now()-1000)}});await jobs.maintain();expect((await db.execution.findUniqueOrThrow({where:{id:row.id}})).failureCode).toBe('JOB_TIMEOUT');
  });
  it('rejects cross-owner replay without revealing existence',async()=>{const row=await fixture();await expect(jobs.replay(otherId,row.id,0,0)).rejects.toThrow('Execution not found.');});
  it('authenticates websocket cookies and exact browser Origin',async()=>{await expect(connect(0,{origin:'http://localhost:3000'})).rejects.toThrow();await expect(connect(0,{cookie,origin:'https://evil.test'})).rejects.toThrow();expect((await connect()).connected).toBe(true);});
  it('authorizes subscriptions and rejects unknown fields',async()=>{
    const socket=await connect();const row=await fixture('RUN',otherId);expect((await subscribe(socket,row.id)).error!.code).toBe('NOT_FOUND');
    const reply=await socket.timeout(3000).emitWithAck('subscribe_execution',{executionId:row.id,attempt:0,afterSequence:0,userId:otherId});expect(reply.error.code).toBe('INVALID_REQUEST');
  });
  it('delivers events to two gateways and replays from the acknowledged cursor',async()=>{
    const row=await fixture();const lease=(await jobs.claim(row.id))!.lease;const a=await connect(0),b=await connect(1);const initial=await subscribe(a,row.id,1,0);await subscribe(b,row.id,1,initial.snapshot.lastSequence);
    const seenA:unknown[]=[],seenB:unknown[]=[];a.on('console_output',e=>seenA.push(e));b.on('console_output',e=>seenB.push(e));await jobs.console(lease,caseId,'stdout','first');await until(()=>seenA.length===1&&seenB.length===1);a.disconnect();
    await jobs.console(lease,caseId,'stdout','second');const reconnected=await connect();const replay=await subscribe(reconnected,row.id,1,2);expect(replay.events).toHaveLength(1);expect(JSON.stringify(replay.events)).toContain('second');expect(JSON.stringify(replay)).not.toContain('PRIVATE_SOURCE_SENTINEL');
  });
  it('disconnects sockets when the session is revoked',async()=>{const socket=await connect();await db.session.update({where:{id:sessionId},data:{revokedAt:new Date()}});await until(()=>!socket.connected);});
  it('disconnects sockets when their session expires',async()=>{const socket=await connect();await db.session.update({where:{id:sessionId},data:{expiresAt:new Date(0)}});await until(()=>!socket.connected);});
  it('bounds subscription count and rejects excess commands',async()=>{
    const socket=await connect();for(let i=0;i<5;i++) expect((await subscribe(socket,(await fixture()).id)).ok).toBe(true);
    expect((await subscribe(socket,(await fixture()).id)).error!.code).toBe('SUBSCRIPTION_LIMIT');
    let reply;for(let i=0;i<61;i++) reply=await subscribe(socket,randomUUID());expect(reply!.error!.code).toBe('SOCKET_RATE_LIMIT');
  });
});
