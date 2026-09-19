import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Execution, OutboxEvent } from '@prisma/client';
import { SandboxCleanupError } from '@arenacore/contracts';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Config } from '../config/config';
import { Database } from '../database/database';
import { JobStore, WorkerResult } from './job-store';

export function redisOptions(url: string, worker=false) {
  const u=new URL(url);
  if (!['redis:','rediss:'].includes(u.protocol) || u.search || u.hash || ! /^(?:\/\d*)?$/.test(u.pathname)) throw new Error('INVALID_REDIS_URL');
  return {host:u.hostname,port:Number(u.port||6379),username:u.username?decodeURIComponent(u.username):undefined,password:u.password?decodeURIComponent(u.password):undefined,db:Number(u.pathname.slice(1)||0),...(u.protocol==='rediss:'?{tls:{}}:{}),maxRetriesPerRequest:worker?null:1,connectTimeout:2000,enableOfflineQueue:worker};
}
export const queuePayloadSchema=z.strictObject({executionId:z.uuid()});
export class OutboxDispatcher {
  constructor(readonly db: Database, readonly queue: Queue) {}
  async tick() {
    const token=randomUUID();
    const intents=await this.db.$transaction(async tx=>{
      const rows=await tx.$queryRaw<OutboxEvent[]>`SELECT * FROM "OutboxEvent" WHERE "publishedAt" IS NULL AND "nextDispatchAt"<=clock_timestamp() AND ("dispatchExpiresAt" IS NULL OR "dispatchExpiresAt"<=clock_timestamp()) ORDER BY "createdAt" LIMIT 20 FOR UPDATE SKIP LOCKED`;
      const claimed: OutboxEvent[]=[];
      for (const row of rows) {
        const updated=await tx.$queryRaw<OutboxEvent[]>`UPDATE "OutboxEvent" SET "dispatchToken"=${token}::uuid, "dispatchExpiresAt"=clock_timestamp()+interval '10 seconds', "dispatchAttempts"="dispatchAttempts"+1 WHERE id=${row.id}::uuid AND "publishedAt" IS NULL AND "nextDispatchAt"<=clock_timestamp() AND ("dispatchExpiresAt" IS NULL OR "dispatchExpiresAt"<=clock_timestamp()) RETURNING *`;
        claimed.push(...updated);
      }
      return claimed;
    });
    for (const row of intents) {
      try {
        if (row.kind==='EXECUTION_CREATED' || row.kind==='EXECUTION_RECOVERY') {
          const execution=await this.db.execution.findUnique({where:{id:row.executionId},select:{state:true,attempt:true,queueExpiresAt:true}});
          if (execution && ((execution.state==='QUEUED' && execution.queueExpiresAt>new Date()) || (['COMPILING','RUNNING'].includes(execution.state) && row.kind==='EXECUTION_RECOVERY' && row.generation===execution.attempt))) {
            await this.queue.add('execution',{executionId:row.executionId},{jobId:`exec-${row.executionId}-g${row.generation}`,attempts:1,removeOnComplete:{age:86400,count:10000},removeOnFail:{age:86400,count:10000}});
          }
        }
        await this.db.$executeRaw`UPDATE "OutboxEvent" SET "publishedAt"=clock_timestamp(), "dispatchToken"=NULL, "dispatchExpiresAt"=NULL WHERE id=${row.id}::uuid AND "dispatchToken"=${token}::uuid AND "dispatchExpiresAt">clock_timestamp()`;
      } catch {
        await this.db.outboxEvent.updateMany({where:{id:row.id,dispatchToken:token},data:{dispatchToken:null,dispatchExpiresAt:null,nextDispatchAt:new Date(Date.now()+Math.min(30000,1000*2**Math.min(row.dispatchAttempts,5)))}});
      }
    }
    return intents.length;
  }
}
export interface ExecutionBackend {
  // Normal settlement requires stopped processes; SandboxCleanupError explicitly reports uncertainty.
  execute(context: {execution:Execution;signal:AbortSignal;markRunning:()=>Promise<boolean>;console:(caseId:string,stream:'stdout'|'stderr',text:string)=>Promise<boolean>}):Promise<WorkerResult>;
}
export function startExecutionWorker(jobs: JobStore, url: string, queueName: string, backend: ExecutionBackend) {
  const worker=new Worker(queueName,async job=>{
    const {executionId}=queuePayloadSchema.parse(job.data);
    const claimed=await jobs.claim(executionId);
    if (!claimed) return;
    const {lease,execution}=claimed;
    const abort=new AbortController();
    let pending:Promise<void>|undefined;
    const heartbeat=async()=>{
      try {if (await jobs.renew(lease)!=='ACTIVE') abort.abort();} catch {abort.abort();}
    };
    const timer=setInterval(()=>{if (!pending) pending=heartbeat().finally(()=>{pending=undefined;});},1000);
    timer.unref();
    try {
      const result=await backend.execute({execution,signal:abort.signal,markRunning:()=>jobs.markRunning(lease),console:(caseId,stream,text)=>jobs.console(lease,caseId,stream,text)});
      await jobs.finish(lease,result);
    } catch(e) {await jobs.fail(lease, !(e instanceof SandboxCleanupError));} finally {clearInterval(timer);await pending;}
  },{connection:redisOptions(url,true),concurrency:2,lockDuration:30000,maxStalledCount:1});
  // Never log Redis credentials, queue data, source, or backend exception text.
  worker.on('error',()=>{});
  return worker;
}
@Injectable()
export class QueuePipeline implements OnApplicationBootstrap,OnModuleDestroy {
  private readonly logger=new Logger(QueuePipeline.name);
  private queue?:Queue; private timer?:NodeJS.Timeout; private pending?:Promise<void>;
  constructor(@Inject(Database) private readonly db:Database,@Inject(Config) private readonly config:Config,@Inject(JobStore) private readonly jobs:JobStore) {}
  onApplicationBootstrap() {
    if (this.config.values.PIPELINE_ENABLED!=='true') return;
    this.queue=new Queue(this.config.values.QUEUE_NAME,{connection:redisOptions(this.config.values.REDIS_URL!)});
    this.queue.on('error',()=>this.logger.warn('QUEUE_UNAVAILABLE'));
    const dispatcher=new OutboxDispatcher(this.db,this.queue);
    const tick=()=>{
      if (!this.pending) this.pending=(async()=>{await this.jobs.maintain();await dispatcher.tick();})().catch(()=>{this.logger.warn('PIPELINE_MAINTENANCE_FAILED');}).finally(()=>{this.pending=undefined;});
    };
    tick();this.timer=setInterval(tick,1000);this.timer.unref();
  }
  async onModuleDestroy() {if (this.timer) clearInterval(this.timer);await this.pending;await this.queue?.close();}
}
