import { Inject, Injectable } from '@nestjs/common';
import { Execution, Prisma, ExecutionFailureCode } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { isTerminal, verdictSchema, PublicExecutionEvent, publicExecutionEventSchema, MAX_OUTPUT_BYTES } from '@arenacore/contracts';
import { Database } from '../database/database';
import { ApiError } from '../common/errors';
import { publicSnapshot } from './serialization';

export const LEASE_MS = 30000, CANCEL_GRACE_MS = 15000, MAX_ATTEMPTS = 3;
export const REPLAY_ROWS = 256, REPLAY_BYTES = 256 * 1024, REPLAY_TTL_MS = 600000;
export interface Lease { executionId: string; attempt: number; token: string }
export const resultSchema = z.strictObject({
  verdict: verdictSchema.exclude(['CANCELLED', 'INTERNAL_ERROR']),
  runtimeMs: z.number().int().nonnegative().optional(), memoryKiB: z.number().int().nonnegative().optional(),
  publicCaseResults: z.array(z.strictObject({caseId: z.uuid(), verdict: verdictSchema.exclude(['CANCELLED','INTERNAL_ERROR']), stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().int().optional(), runtimeMs: z.number().int().nonnegative().optional(), memoryKiB: z.number().int().nonnegative().optional()})).max(100).optional(),
});
export type WorkerResult = z.infer<typeof resultSchema>;
export function safeConsole(text: string) {
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
@Injectable()
export class JobStore {
  constructor(@Inject(Database) readonly db: Database) {}
  private async locked(tx: Prisma.TransactionClient, id: string) {
    const rows = await tx.$queryRaw<(Execution & {now: Date})[]>`SELECT *, clock_timestamp() AS now FROM "Execution" WHERE id=${id}::uuid FOR UPDATE`;
    return rows[0];
  }
  private valid(row: Execution & {now: Date}, lease: Lease) {
    return !isTerminal(row.state) && row.state !== 'QUEUED' && row.attempt === lease.attempt && row.leaseToken === lease.token && !!row.leaseExpiresAt && row.leaseExpiresAt > row.now && row.now.getTime() < this.deadline(row);
  }
  private deadline(row: Execution) { return row.queueExpiresAt.getTime() + 600000; }
  // Caller owns the parent row lock. Event and sequence updates share its transaction.
  async event(tx: Prisma.TransactionClient, row: Execution, fields: Omit<PublicExecutionEvent,'executionId'|'attempt'|'sequence'>) {
    const sequence = row.lastSequence + 1;
    const payload = publicExecutionEventSchema.parse({...fields, executionId: row.id, attempt: row.attempt, sequence});
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > 16384) throw new Error('PUBLIC_EVENT_TOO_LARGE');
    await tx.executionEvent.create({data: {executionId: row.id, attempt: row.attempt, sequence, kind: fields.kind, payload: payload as unknown as Prisma.InputJsonValue, bytes, expiresAt: new Date(Date.now() + REPLAY_TTL_MS)}});
    const events = await tx.executionEvent.findMany({where: {executionId: row.id}, select: {id: true, bytes: true}, orderBy: [{attempt:'desc'}, {sequence:'desc'}]});
    let total = 0;
    const discard: string[] = [];
    events.forEach((e,i) => {total += e.bytes; if (i >= REPLAY_ROWS || total > REPLAY_BYTES) discard.push(e.id);});
    if (discard.length) await tx.executionEvent.deleteMany({where: {id: {in: discard}}});
    row.lastSequence = sequence;
    return sequence;
  }
  private async terminal(tx: Prisma.TransactionClient, row: Execution, state: 'INTERNAL_ERROR'|'CANCELLED', failureCode?: ExecutionFailureCode) {
    const seq = await this.event(tx, row, {kind:'final_verdict',state, verdict: state, ...(failureCode ? {failureCode}: {})});
    await tx.execution.update({where:{id:row.id},data:{state,verdict:state,failureCode:failureCode ?? null,finishedAt:new Date(),leaseToken:null,leaseExpiresAt:null,lastSequence:seq}});
  }
  async claim(id: string): Promise<{lease: Lease; execution: Execution}|null> {
    return this.db.$transaction(async tx => {
      const row = await this.locked(tx,id);
      if (!row || isTerminal(row.state)) return null;
      if (row.state === 'QUEUED' && row.queueExpiresAt <= row.now) {await this.terminal(tx,row,'INTERNAL_ERROR','QUEUE_TIMEOUT'); return null;}
      if (row.state !== 'QUEUED' && row.leaseExpiresAt && row.leaseExpiresAt > row.now) return null;
      if (row.cancellationRequestedAt) {await this.terminal(tx,row,'INTERNAL_ERROR','CANCELLATION_TIMEOUT');return null;}
      if (row.now.getTime() >= this.deadline(row) || row.attempt >= MAX_ATTEMPTS) {await this.terminal(tx,row,'INTERNAL_ERROR',row.attempt >= MAX_ATTEMPTS ? 'LEASE_EXPIRED':'JOB_TIMEOUT');return null;}
      const token = randomUUID();
      row.attempt++; row.lastSequence = 0; row.state = 'COMPILING';
      await tx.executionEvent.deleteMany({where: {executionId:id}});
      const sequence = await this.event(tx,row,{kind:'execution_status',state:'COMPILING'});
      const execution = await tx.execution.update({where:{id},data:{state:'COMPILING',attempt:row.attempt,lastSequence:sequence,leaseToken:token,leaseExpiresAt:new Date(Math.min(row.now.getTime()+LEASE_MS,this.deadline(row)))}});
      return {lease:{executionId:id,attempt:row.attempt,token},execution};
    });
  }
  async renew(lease: Lease): Promise<'ACTIVE'|'CANCEL'|'LOST'> {
    return this.db.$transaction(async tx => {
      const row = await this.locked(tx,lease.executionId);
      if (!row || !this.valid(row,lease)) return 'LOST';
      const end = Math.min(row.now.getTime()+LEASE_MS,this.deadline(row),row.cancellationRequestedAt ? row.cancellationRequestedAt.getTime()+CANCEL_GRACE_MS : Infinity);
      if (end <= row.now.getTime()) return 'LOST';
      await tx.execution.update({where:{id:row.id},data:{leaseExpiresAt:new Date(end)}});
      return row.cancellationRequestedAt ? 'CANCEL' : 'ACTIVE';
    });
  }
  async markRunning(lease: Lease) {
    return this.db.$transaction(async tx => {
      const row=await this.locked(tx,lease.executionId);
      if (!row || !this.valid(row,lease) || row.cancellationRequestedAt || row.state !== 'COMPILING') return false;
      const sequence=await this.event(tx,row,{kind:'execution_status',state:'RUNNING'});
      await tx.execution.update({where:{id:row.id},data:{state:'RUNNING',lastSequence:sequence}});return true;
    });
  }
  async console(lease: Lease, caseId: string, stream: 'stdout'|'stderr', text: string) {
    if (!z.uuid().safeParse(caseId).success || !['stdout','stderr'].includes(stream) || Buffer.byteLength(text) > 4096) throw new Error('INVALID_PUBLIC_OUTPUT');
    return this.db.$transaction(async tx => {
      const row=await this.locked(tx,lease.executionId);
      if (!row || !this.valid(row,lease) || row.cancellationRequestedAt) return false;
      if (row.mode !== 'RUN' || !await tx.testCase.findFirst({where:{id:caseId,problemVersionId:row.problemVersionId,visibility:'PUBLIC'},select:{id:true}})) throw new Error('PRIVATE_OUTPUT_REJECTED');
      const sequence=await this.event(tx,row,{kind:'console_output',caseId,stream,text:safeConsole(text)});
      await tx.execution.update({where:{id:row.id},data:{lastSequence:sequence}});return true;
    });
  }
  async finish(lease: Lease, input: WorkerResult) {
    const result=resultSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES) throw new Error('PUBLIC_RESULT_TOO_LARGE');
    return this.db.$transaction(async tx => {
      const row=await this.locked(tx,lease.executionId);
      if (!row || !this.valid(row,lease)) return false;
      // The backend promise must settle only after its sandbox has stopped.
      if (row.cancellationRequestedAt) {await this.terminal(tx,row,'CANCELLED');return true;}
      if (result.publicCaseResults) {
        if (row.mode !== 'RUN') throw new Error('PRIVATE_OUTPUT_REJECTED');
        const ids=result.publicCaseResults.map(r=>r.caseId);
        if (new Set(ids).size !== ids.length || await tx.testCase.count({where:{id:{in:ids},problemVersionId:row.problemVersionId,visibility:'PUBLIC'}}) !== ids.length) throw new Error('PRIVATE_OUTPUT_REJECTED');
      }
      const seq=await this.event(tx,row,{kind:'final_verdict',state:'FINISHED',verdict:result.verdict});
      const results=result.publicCaseResults?.map(r=>({...r,...(r.stdout!==undefined?{stdout:safeConsole(r.stdout)}:{}),...(r.stderr!==undefined?{stderr:safeConsole(r.stderr)}:{})}));
      await tx.execution.update({where:{id:row.id},data:{state:'FINISHED',verdict:result.verdict,finishedAt:new Date(),lastSequence:seq,leaseToken:null,leaseExpiresAt:null,runtimeMs:result.runtimeMs,memoryKiB:result.memoryKiB,...(results?{publicResults:results}:{})}});return true;
    });
  }
  async fail(lease: Lease) {
    return this.db.$transaction(async tx => {
      const row=await this.locked(tx,lease.executionId);
      if (!row || !this.valid(row,lease)) return false;
      await this.terminal(tx,row,row.cancellationRequestedAt?'CANCELLED':'INTERNAL_ERROR',row.cancellationRequestedAt?undefined:'JOB_FAILURE');return true;
    });
  }
  async cancel(userId: string, id: string, activeAllowed: boolean) {
    return this.db.$transaction(async tx => {
      const row=await this.locked(tx,id);
      if (!row || row.userId !== userId) throw new ApiError(404,'NOT_FOUND','Execution not found.');
      if (row.state === 'QUEUED') {await this.terminal(tx,row,'CANCELLED');await tx.outboxEvent.create({data:{executionId:id,kind:'EXECUTION_CANCELLED'}});return {executionId:id,state:'CANCELLED' as const};}
      if (!isTerminal(row.state)) {
        if (!activeAllowed) throw new ApiError(503,'CANCELLATION_UNAVAILABLE','Active runner cancellation is not available yet.');
        if (!row.cancellationRequestedAt) {
          const sequence=await this.event(tx,row,{kind:'execution_status',state:row.state,cancellationRequested:true});
          await tx.execution.update({where:{id},data:{cancellationRequestedAt:row.now,lastSequence:sequence}});
        }
        return {executionId:id,state:row.state,cancellationRequested:true};
      }
      return {executionId:id,state:row.state};
    });
  }
  async replay(userId: string, id: string, attempt: number, after: number) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Execution" WHERE id=${id}::uuid AND "userId"=${userId}::uuid FOR SHARE`;
      const row=await tx.execution.findFirst({where:{id,userId},include:{problemVersion:{select:{problemId:true,testCases:{where:{visibility:'PUBLIC'},select:{id:true}}}}}});
      if (!row) throw new ApiError(404,'NOT_FOUND','Execution not found.');
      const events=await tx.executionEvent.findMany({where:{executionId:id,attempt:row.attempt,sequence:{gt:after},expiresAt:{gt:new Date()}},orderBy:{sequence:'asc'},take:REPLAY_ROWS});
      const parsed=events.map(e=>publicExecutionEventSchema.safeParse(e.payload));
      const publicIds=new Set(row.problemVersion.testCases.map(c=>c.id));
      const safe=parsed.every((e,i)=>e.success && e.data.executionId===id && e.data.attempt===row.attempt && e.data.sequence===events[i]!.sequence && (e.data.kind !== 'console_output' || (row.mode === 'RUN' && publicIds.has(e.data.caseId))));
      const contiguous=safe && attempt===row.attempt && after<=row.lastSequence && events.length===row.lastSequence-after && events.every((e,i)=>e.sequence===after+i+1);
      return {snapshot:publicSnapshot(row),replayAvailable:contiguous,events:contiguous?parsed.map(e=>{if (!e.success) throw new Error('INVALID_PUBLIC_EVENT');return e.data;}):[]};
    });
  }
  async maintain() {
    // Bounded locks let multiple API instances reconcile without owning one leader.
    return this.db.$transaction(async tx => {
      const rows=await tx.$queryRaw<(Execution & {now:Date})[]>`SELECT *, clock_timestamp() AS now FROM "Execution" WHERE state IN ('COMPILING','RUNNING') AND ("leaseExpiresAt" <= clock_timestamp() OR "cancellationRequestedAt" <= clock_timestamp()-interval '15 seconds') ORDER BY "leaseExpiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED`;
      for (const row of rows) {
        if (row.cancellationRequestedAt || row.attempt >= MAX_ATTEMPTS || row.now.getTime() >= this.deadline(row)) {
          await this.terminal(tx,row,'INTERNAL_ERROR',row.cancellationRequestedAt?'CANCELLATION_TIMEOUT':row.attempt>=MAX_ATTEMPTS?'LEASE_EXPIRED':'JOB_TIMEOUT');
        } else {
          await tx.outboxEvent.upsert({where:{executionId_kind_generation:{executionId:row.id,kind:'EXECUTION_RECOVERY',generation:row.attempt}},create:{executionId:row.id,kind:'EXECUTION_RECOVERY',generation:row.attempt},update:{}});
        }
      }
      // Reoffer old published intents. Redis loss cannot erase a durable accepted job.
      await tx.$executeRaw`UPDATE "OutboxEvent" o SET "publishedAt"=NULL WHERE o.id IN (SELECT o.id FROM "OutboxEvent" o JOIN "Execution" e ON e.id=o."executionId" WHERE o."publishedAt" < clock_timestamp()-interval '10 seconds' AND ((e.state='QUEUED' AND o.kind='EXECUTION_CREATED') OR (e.state IN ('COMPILING','RUNNING') AND e."leaseExpiresAt"<=clock_timestamp() AND o.kind='EXECUTION_RECOVERY' AND o.generation=e.attempt)) LIMIT 100 FOR UPDATE OF o SKIP LOCKED)`;
      await tx.$executeRaw`DELETE FROM "ExecutionEvent" WHERE id IN (SELECT id FROM "ExecutionEvent" WHERE "expiresAt" < clock_timestamp() LIMIT 1000)`;
    });
  }
}
