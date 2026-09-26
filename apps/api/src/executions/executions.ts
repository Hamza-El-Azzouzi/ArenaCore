import { Controller, Get, Headers, HttpCode, Inject, Injectable, Param, Post, Query, Req, Body, UseGuards } from '@nestjs/common';
import { activeStates, CreateExecution, createExecutionSchema, ExecutionReceipt, idempotencyKeySchema, MAX_SOURCE_BYTES, submissionsQuerySchema, uuidSchema } from '@arenacore/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../database/database';
import { Config } from '../config/config';
import { ApiError, validate } from '../common/errors';
import { AuthenticatedRequest, SessionGuard } from '../auth/session';
import { publicSnapshot } from './serialization';
import { JobStore } from './job-store';
import { ExecutionAdmission } from './admission';

export function payloadHash(input: CreateExecution): string {
  // Explicit field order; transport JSON order never changes the hash.
  return createHash('sha256').update(JSON.stringify([input.problemId, input.language, input.mode, input.sourceCode, input.competitionSlug ?? null])).digest('hex');
}
@Injectable()
export class Executions {
  constructor(@Inject(Database) private readonly db: Database, @Inject(Config) private readonly config: Config, @Inject(ExecutionAdmission) private readonly admission: ExecutionAdmission, @Inject(JobStore) private readonly jobs: JobStore) {}
  async create(userId: string, input: CreateExecution, key: string, ip: string): Promise<ExecutionReceipt> {
    if (!this.config.executionsEnabled) throw new ApiError(503, 'EXECUTIONS_DISABLED', 'Code execution is not available yet.');
    const hash = payloadHash(input);
    // Lock the owner row: concurrent creates for the same user are serialized.
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
      const previous = await tx.execution.findUnique({where: {userId_idempotencyKey: {userId, idempotencyKey: key}}});
      if (previous) {
        if (previous.payloadHash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was already used with different content.');
        return {executionId: previous.id, state: previous.state};
      }
      const count = await tx.execution.count({where: {userId, state: {in: [...activeStates]}}});
      if (count >= this.config.values.MAX_ACTIVE_JOBS_PER_USER) throw new ApiError(429, 'ACTIVE_JOB_LIMIT', 'Wait for your active execution to finish.', 5);
      const problem = await tx.problem.findUnique({where: {id: input.problemId}, select: {currentVersion: {select: {id: true, published: true}}}});
      if (!problem?.currentVersion?.published) throw new ApiError(404, 'NOT_FOUND', 'Problem not found.');
      let competitionRoundId: string | undefined;
      if (input.competitionSlug) {
        const now=new Date();
        const competition=await tx.competition.findFirst({where:{slug:input.competitionSlug,published:true},select:{id:true,startsAt:true,endsAt:true,registrations:{where:{userId},select:{userId:true}},rounds:{where:{startsAt:{lte:now},endsAt:{gt:now},problems:{some:{problemId:input.problemId}}},select:{id:true},take:1}}});
        if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');
        if(now<competition.startsAt)throw new ApiError(409,'COMPETITION_NOT_STARTED','This competition has not started yet.');
        if(now>=competition.endsAt)throw new ApiError(409,'COMPETITION_FINISHED','This competition has finished.');
        if(!competition.registrations.length)throw new ApiError(403,'REGISTRATION_REQUIRED','Register for this competition before solving its problems.');
        if(!competition.rounds[0])throw new ApiError(409,'ROUND_NOT_ACTIVE','This problem is not available in an active round.');
        competitionRoundId=competition.rounds[0].id;
      }
      await this.admission.reserve(tx, userId, ip);
      const row = await tx.execution.create({data: {userId, problemVersionId: problem.currentVersion.id, competitionRoundId, language: input.language, mode: input.mode, sourceCode: input.sourceCode, payloadHash: hash, idempotencyKey: key, queueExpiresAt: new Date(Date.now() + this.config.values.QUEUE_TTL_SECONDS * 1000)}});
      const sequence = await this.jobs.event(tx, row, {kind: 'execution_status', state: 'QUEUED'});
      await tx.execution.update({where: {id: row.id}, data: {lastSequence: sequence}});
      await tx.outboxEvent.create({data: {kind: 'EXECUTION_CREATED', executionId: row.id}});
      return {executionId: row.id, state: row.state};
    });
  }
  async snapshot(userId: string, id: string) {
    const row = await this.db.execution.findFirst({where: {id, userId}, select: {
      id: true, problemVersion: {select: {problemId: true, testCases: {where: {visibility: 'PUBLIC'}, select: {id: true}}}}, language: true, mode: true,
      state: true, attempt: true, lastSequence: true, verdict: true, runtimeMs: true,
      memoryKiB: true, publicResults: true, failureCode: true, cancellationRequestedAt: true,
    }});
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Execution not found.');
    return publicSnapshot(row);
  }
  async cancel(userId: string, id: string): Promise<ExecutionReceipt> {
    return this.jobs.cancel(userId, id, this.config.values.PIPELINE_ENABLED === 'true');
  }
  async history(userId: string, query: z.infer<typeof submissionsQuerySchema>) {
    const cursor = query.cursor ? await this.db.execution.findFirst({where: {id: query.cursor, userId, mode: 'SUBMIT', ...(query.problemId ? {problemVersion: {problemId: query.problemId}} : {})}, select: {id: true, createdAt: true}}) : null;
    if (query.cursor && !cursor) throw new ApiError(400, 'INVALID_CURSOR', 'Submission cursor is invalid.');
    const rows = await this.db.execution.findMany({where: {
      userId, mode: 'SUBMIT',
      ...(cursor ? {OR: [{createdAt: {lt: cursor.createdAt}}, {createdAt: cursor.createdAt, id: {lt: cursor.id}}]} : {}),
      ...(query.problemId ? {problemVersion: {problemId: query.problemId}} : {}),
    }, select: {id: true, language: true, state: true, verdict: true, createdAt: true, runtimeMs: true, memoryKiB: true, failureCode: true, problemVersion: {select: {problemId: true, title: true}}}, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: 21});
    const items = rows.slice(0,20).map(row => ({executionId: row.id, problemId: row.problemVersion.problemId, problemTitle: row.problemVersion.title, language: row.language, state: row.state, createdAt: row.createdAt.toISOString(), ...(row.verdict !== null ? {verdict: row.verdict} : {}), ...(row.runtimeMs !== null ? {runtimeMs: row.runtimeMs} : {}), ...(row.memoryKiB !== null ? {memoryKiB: row.memoryKiB} : {}), ...(row.failureCode !== null ? {failureCode: row.failureCode} : {})}));
    return {items, nextCursor: rows.length > 20 ? items.at(-1)!.executionId : null};
  }
}
@Controller()
@UseGuards(SessionGuard)
export class ExecutionsController {
  constructor(@Inject(Executions) private readonly executions: Executions) {}
  @Post('executions') @HttpCode(202)
  create(@Req() req: AuthenticatedRequest, @Body() body: unknown, @Headers('idempotency-key') key: unknown) {
    // Differentiate byte cap from invalid shape without leaking user source.
    if (body && typeof body === 'object' && 'sourceCode' in body && typeof body.sourceCode === 'string' && Buffer.byteLength(body.sourceCode, 'utf8') > MAX_SOURCE_BYTES) throw new ApiError(413, 'SOURCE_TOO_LARGE', 'Source exceeds 64 KiB.');
    return this.executions.create(req.principal.userId, validate(createExecutionSchema, body), validate(idempotencyKeySchema, key), req.ip ?? req.socket.remoteAddress ?? 'unknown');
  }
  @Get('executions/:id') snapshot(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.executions.snapshot(req.principal.userId, validate(uuidSchema, id)); }
  @Post('executions/:id/cancel') @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) { return this.executions.cancel(req.principal.userId, validate(uuidSchema, id)); }
  @Get('submissions') history(@Req() req: AuthenticatedRequest, @Query() query: unknown) { return this.executions.history(req.principal.userId, validate(submissionsQuerySchema, query)); }
}
