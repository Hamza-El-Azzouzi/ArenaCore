import {Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, Patch, Post, Query, Req, UseGuards} from '@nestjs/common';
import {DiscussionStatus, Prisma, Role} from '@prisma/client';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {RequireRoles, RolesGuard} from '../auth/roles.guard';
import {ApiError, validate} from '../common/errors';
import {Database} from '../database/database';

const uuid = z.uuid();
const cursorQuery = z.strictObject({cursor: uuid.optional()});
const analyticsQuery=z.strictObject({days:z.coerce.number().int().refine(value=>[7,30,90].includes(value),'Choose a 7, 30, or 90 day period.').default(30)});
const userQuery=z.strictObject({cursor:uuid.optional(),search:z.string().trim().min(2).max(100).optional(),role:z.enum(['USER','MODERATOR','ADMIN']).optional(),restriction:z.enum(['ACTIVE','SUSPENDED','BANNED']).optional()});
const roleInput = z.strictObject({role: z.enum(['USER', 'MODERATOR','ADMIN'])});
const moderationInput = z.strictObject({status: z.enum(['VISIBLE', 'HIDDEN', 'DELETED'])});
const resolveReportInput=z.strictObject({status:z.enum(['RESOLVED','DISMISSED']),moderatorNote:z.string().trim().min(3).max(1000),postStatus:z.enum(['VISIBLE','HIDDEN','DELETED']).optional()});
const restrictionInput=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('SUSPEND'),until:z.iso.datetime(),reason:z.string().trim().min(3).max(500)}),
  z.strictObject({action:z.literal('BAN'),reason:z.string().trim().min(3).max(500)}),
  z.strictObject({action:z.literal('CLEAR')}),
]);
const publicationInput=z.strictObject({published:z.boolean()});
const slug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const testFileName=z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(name=>!['Solution.java','Solution.class','solution.py','solution.js'].includes(name)&&!name.endsWith('.class'),'Reserved or unsafe input filename');
const testFile=z.strictObject({name:testFileName,content:z.string().max(64_000)});
const createProblemInput = z.strictObject({
  slug,
  title: z.string().trim().min(3).max(160),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  tags: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,29}$/)).max(12),
  statementMarkdown: z.string().trim().min(20).max(50_000),
  constraints: z.array(z.string().trim().min(1).max(500)).max(30),
  timeMs: z.number().int().min(100).max(30_000),
  memoryKiB: z.number().int().min(16_384).max(1_048_576),
  inputMode:z.enum(['STDIN','FILES']).default('STDIN'),
  templates: z.strictObject({java: z.string().max(64_000), python: z.string().max(64_000), javascript: z.string().max(64_000)}),
  tests: z.array(z.strictObject({visibility: z.enum(['PUBLIC', 'HIDDEN']), input: z.string().max(64_000), files:z.array(testFile).max(16).default([]), expectedOutput: z.string().max(64_000)}).superRefine((test,context)=>{if(new Set(test.files.map(file=>file.name)).size!==test.files.length)context.addIssue({code:'custom',path:['files'],message:'Input filenames must be unique'});})).min(2).max(100),
  publish: z.boolean(),
}).superRefine((value, context) => {
  if (!value.tests.some(test => test.visibility === 'PUBLIC')) context.addIssue({code: 'custom', path: ['tests'], message: 'At least one public example is required'});
  if (!value.tests.some(test => test.visibility === 'HIDDEN')) context.addIssue({code: 'custom', path: ['tests'], message: 'At least one hidden test is required'});
  value.tests.forEach((test,index)=>{
    if(value.inputMode==='STDIN'&&test.files.length)context.addIssue({code:'custom',path:['tests',index,'files'],message:'STDIN problems cannot define input files'});
    if(value.inputMode==='FILES'&&(!test.files.length||test.input.length))context.addIssue({code:'custom',path:['tests',index],message:'File problems require files and an empty stdin value'});
  });
});
const createCompetitionInput=z.strictObject({
  slug,
  kind:z.enum(['CONTEST','TOURNAMENT']),
  title:z.string().trim().min(3).max(160),
  description:z.string().trim().min(10).max(1000),
  rulesMarkdown:z.string().trim().min(10).max(20_000),
  prizeLabel:z.string().trim().max(100).optional(),
  startsAt:z.iso.datetime(),
  endsAt:z.iso.datetime(),
  published:z.boolean(),
  rounds:z.array(z.strictObject({title:z.string().trim().min(2).max(100),startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),problemSlugs:z.array(slug).min(1).max(30)})).min(1).max(20),
});

function pageBoundary<T extends {id:string; createdAt:Date}>(row: T | null) {
  return row ? {OR: [{createdAt: {lt: row.createdAt}}, {createdAt: row.createdAt, id: {lt: row.id}}]} : {};
}

@Injectable()
export class AdminService {
  constructor(@Inject(Database) private readonly db: Database) {}

  async overview() {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const active = ['QUEUED', 'COMPILING', 'RUNNING'] as const;
    const [users, submissionsToday, publishedProblems, moderationPending, activeExecutions, recent] = await Promise.all([
      this.db.user.count(),
      this.db.execution.count({where: {mode: 'SUBMIT', createdAt: {gte: today}}}),
      this.db.problemVersion.count({where: {published: true, currentFor: {isNot: null}}}),
      this.db.contentReport.count({where: {status: 'PENDING'}}),
      this.db.execution.count({where: {state: {in: [...active]}}}),
      this.db.execution.findMany({where: {mode: 'SUBMIT'}, select: {id:true, language:true, state:true, verdict:true, runtimeMs:true, createdAt:true, user:{select:{username:true,displayName:true}}, problemVersion:{select:{title:true,problem:{select:{slug:true}}}}}, orderBy:[{createdAt:'desc'},{id:'desc'}], take:8}),
    ]);
    return {stats: {users, submissionsToday, publishedProblems, moderationPending, activeExecutions}, recentSubmissions: recent.map(row => ({id:row.id, language:row.language, state:row.state, verdict:row.verdict, runtimeMs:row.runtimeMs, createdAt:row.createdAt.toISOString(), user:row.user, problem:{slug:row.problemVersion.problem.slug,title:row.problemVersion.title}}))};
  }

  async analytics(days:number) {
    const until=new Date();
    const since=new Date(Date.UTC(until.getUTCFullYear(),until.getUTCMonth(),until.getUTCDate()-days+1));
    type DailyRow={date:string;submissions:number;accepted:number;activeUsers:number};
    type ActiveRow={count:number};
    type ProblemRow={slug:string;title:string;submissions:number;accepted:number};
    const [newUsers,submissions,accepted,activeRows,dailyRows,problemRows]=await Promise.all([
      this.db.user.count({where:{createdAt:{gte:since}}}),
      this.db.execution.count({where:{mode:'SUBMIT',createdAt:{gte:since}}}),
      this.db.execution.count({where:{mode:'SUBMIT',verdict:'ACCEPTED',createdAt:{gte:since}}}),
      this.db.$queryRaw<ActiveRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "Execution" WHERE mode='SUBMIT'::"ExecutionMode" AND "createdAt">=${since}`,
      this.db.$queryRaw<DailyRow[]>`SELECT to_char(date_trunc('day',e."createdAt"),'YYYY-MM-DD') AS date, COUNT(*)::int AS submissions, COUNT(*) FILTER (WHERE e.verdict='ACCEPTED'::"Verdict")::int AS accepted, COUNT(DISTINCT e."userId")::int AS "activeUsers" FROM "Execution" e WHERE e.mode='SUBMIT'::"ExecutionMode" AND e."createdAt">=${since} GROUP BY date_trunc('day',e."createdAt") ORDER BY date_trunc('day',e."createdAt")`,
      this.db.$queryRaw<ProblemRow[]>`SELECT p.slug,(array_agg(pv.title ORDER BY e."createdAt" DESC))[1] AS title,COUNT(*)::int AS submissions,COUNT(*) FILTER (WHERE e.verdict='ACCEPTED'::"Verdict")::int AS accepted FROM "Execution" e JOIN "ProblemVersion" pv ON pv.id=e."problemVersionId" JOIN "Problem" p ON p.id=pv."problemId" WHERE e.mode='SUBMIT'::"ExecutionMode" AND e."createdAt">=${since} GROUP BY p.id,p.slug ORDER BY submissions DESC,p.slug ASC LIMIT 10`,
    ]);
    const byDate=new Map(dailyRows.map(row=>[row.date,row]));
    const daily=Array.from({length:days},(_,offset)=>{const date=new Date(since);date.setUTCDate(since.getUTCDate()+offset);const key=date.toISOString().slice(0,10);return byDate.get(key)??{date:key,submissions:0,accepted:0,activeUsers:0};});
    return {period:{days,since:since.toISOString(),until:until.toISOString()},stats:{newUsers,submissions,accepted,activeUsers:activeRows[0]?.count??0,successRate:submissions?Math.round(accepted*1000/submissions)/10:0},daily,topProblems:problemRows.map(row=>({...row,successRate:row.submissions?Math.round(row.accepted*1000/row.submissions)/10:0}))};
  }

  async analyticsExport(days:number) {
    const report=await this.analytics(days);
    const quote=(value:string|number)=>`"${String(value).replaceAll('"','""')}"`;
    const rows=[['date','submissions','accepted','active_users'],...report.daily.map(row=>[row.date,row.submissions,row.accepted,row.activeUsers])];
    return {filename:`arenacore-analytics-${report.period.since.slice(0,10)}-${report.period.until.slice(0,10)}.csv`,contentType:'text/csv',content:rows.map(row=>row.map(quote).join(',')).join('\n')+'\n'};
  }

  async users(query:z.infer<typeof userQuery>) {
    const {cursor,search,role,restriction}=query;
    const boundary = cursor ? await this.db.user.findUnique({where:{id:cursor},select:{id:true,createdAt:true}}) : null;
    if (cursor && !boundary) throw new ApiError(400, 'INVALID_CURSOR', 'User cursor is invalid.');
    const now=new Date();
    const restrictionWhere=restriction==='BANNED'?{bannedAt:{not:null}}:restriction==='SUSPENDED'?{bannedAt:null,suspendedUntil:{gt:now}}:restriction==='ACTIVE'?{bannedAt:null,OR:[{suspendedUntil:null},{suspendedUntil:{lte:now}}]}:{};
    const rows = await this.db.user.findMany({where: {AND:[pageBoundary(boundary),role?{role}:{},search?{OR:[{username:{contains:search,mode:'insensitive' as const}},{displayName:{contains:search,mode:'insensitive' as const}},{credential:{is:{email:{contains:search,mode:'insensitive' as const}}}}]}:{},restrictionWhere]}, select:{id:true,username:true,displayName:true,role:true,createdAt:true,suspendedUntil:true,bannedAt:true,restrictionReason:true,_count:{select:{executions:true}}}, orderBy:[{createdAt:'desc'},{id:'desc'}], take:21});
    const items=rows.slice(0,20).map(row=>({id:row.id,username:row.username,displayName:row.displayName,role:row.role,joinedAt:row.createdAt.toISOString(),submissions:row._count.executions,restriction:row.bannedAt?{kind:'BANNED',reason:row.restrictionReason,until:null}:row.suspendedUntil&&row.suspendedUntil>now?{kind:'SUSPENDED',reason:row.restrictionReason,until:row.suspendedUntil.toISOString()}:null}));
    return {items,nextCursor:rows.length>20?items.at(-1)!.id:null};
  }

  async submissions(cursor?: string) {
    const boundary=cursor?await this.db.execution.findUnique({where:{id:cursor},select:{id:true,createdAt:true}}):null;
    if(cursor&&!boundary)throw new ApiError(400,'INVALID_CURSOR','Submission cursor is invalid.');
    const rows=await this.db.execution.findMany({where:{mode:'SUBMIT',...pageBoundary(boundary)},select:{id:true,language:true,state:true,verdict:true,runtimeMs:true,memoryKiB:true,failureCode:true,createdAt:true,user:{select:{username:true,displayName:true}},problemVersion:{select:{title:true,problem:{select:{slug:true}}}}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:51});
    const items=rows.slice(0,50).map(row=>({...row,createdAt:row.createdAt.toISOString(),problem:{slug:row.problemVersion.problem.slug,title:row.problemVersion.title},problemVersion:undefined}));
    return {items,nextCursor:rows.length>50?items.at(-1)!.id:null};
  }

  async problems() {
    const rows=await this.db.problem.findMany({select:{id:true,slug:true,createdAt:true,currentVersion:{select:{id:true,number:true,title:true,difficulty:true,tags:true,published:true,_count:{select:{executions:true}}}},versions:{orderBy:{number:'desc'},take:1,select:{id:true,number:true,title:true,difficulty:true,tags:true,published:true,_count:{select:{executions:true}}}}},orderBy:{createdAt:'desc'}});
    return {items:rows.map(row=>{const version=row.versions[0]??row.currentVersion;return {id:row.id,slug:row.slug,createdAt:row.createdAt.toISOString(),version:version?{...version,published:row.currentVersion?.id===version.id}:null};})};
  }

  async problem(id:string) {
    const row=await this.db.problem.findUnique({where:{id},select:{id:true,slug:true,currentVersionId:true,versions:{orderBy:{number:'desc'},take:1,select:{id:true,number:true,published:true,title:true,difficulty:true,tags:true,statementMarkdown:true,constraints:true,timeMs:true,memoryKiB:true,inputMode:true,templates:true,testCases:{orderBy:{ordinal:'asc'},select:{id:true,visibility:true,input:true,expectedOutput:true,files:{orderBy:{name:'asc'},select:{name:true,content:true}}}}}}}});
    if(!row||!row.versions[0])throw new ApiError(404,'NOT_FOUND','Problem not found.');
    const version=row.versions[0];
    return {id:row.id,slug:row.slug,currentVersionId:row.currentVersionId,version:{...version,templates:version.templates}};
  }

  async moderation() {
    const rows=await this.db.contentReport.findMany({where:{status:'PENDING'},select:{id:true,reason:true,details:true,status:true,createdAt:true,reporter:{select:{username:true,displayName:true}},post:{select:{id:true,title:true,body:true,status:true,createdAt:true,author:{select:{id:true,username:true,displayName:true}},problem:{select:{slug:true,currentVersion:{select:{title:true}}}}}}},orderBy:[{createdAt:'asc'},{id:'asc'}],take:100});
    return {items:rows.map(row=>({...row,createdAt:row.createdAt.toISOString(),post:{...row.post,createdAt:row.post.createdAt.toISOString(),problem:{slug:row.post.problem.slug,title:row.post.problem.currentVersion?.title??row.post.problem.slug}}}))};
  }

  async competitions() {
    const rows=await this.db.competition.findMany({select:{id:true,slug:true,kind:true,title:true,published:true,startsAt:true,endsAt:true,_count:{select:{rounds:true,registrations:true}}},orderBy:[{startsAt:'desc'},{id:'desc'}]});
    return {items:rows.map(row=>({...row,startsAt:row.startsAt.toISOString(),endsAt:row.endsAt.toISOString(),rounds:row._count.rounds,registrations:row._count.registrations,_count:undefined}))};
  }

  async setRole(actorId:string,userId:string,role:Role) {
    if(actorId===userId&&role!=='ADMIN')throw new ApiError(409,'SELF_DEMOTION_FORBIDDEN','You cannot remove your own admin role.');
    const user=await this.db.user.findUnique({where:{id:userId},select:{id:true,role:true}});
    if(!user)throw new ApiError(404,'NOT_FOUND','User not found.');
    if(user.role===role)return {id:user.id,role:user.role};
    return this.db.$transaction(async tx=>{if(user.role==='ADMIN'&&role!=='ADMIN'){await tx.$queryRaw`SELECT id FROM "User" WHERE role='ADMIN' FOR UPDATE`;if(await tx.user.count({where:{role:'ADMIN'}})<=1)throw new ApiError(409,'LAST_ADMIN_REQUIRED','At least one administrator must remain.');}const updated=await tx.user.update({where:{id:userId},data:{role},select:{id:true,role:true}});await tx.auditEvent.create({data:{actorId,action:'ADMIN_USER_ROLE_UPDATE',targetId:userId}});return updated;});
  }

  async restrict(actorId:string,userId:string,input:z.infer<typeof restrictionInput>){
    if(actorId===userId)throw new ApiError(409,'SELF_RESTRICTION_FORBIDDEN','You cannot restrict your own account.');
    const user=await this.db.user.findUnique({where:{id:userId},select:{id:true,role:true}});
    if(!user)throw new ApiError(404,'NOT_FOUND','User not found.');
    if(user.role==='ADMIN')throw new ApiError(409,'ADMIN_RESTRICTION_FORBIDDEN','Remove administrator access before restricting this account.');
    const now=new Date();
    let data:{bannedAt:Date|null;suspendedUntil:Date|null;restrictionReason:string|null};
    if(input.action==='BAN')data={bannedAt:now,suspendedUntil:null,restrictionReason:input.reason};
    else if(input.action==='SUSPEND'){const until=new Date(input.until);if(until<=now||until.getTime()>now.getTime()+365*24*60*60*1000)throw new ApiError(400,'INVALID_SUSPENSION','Suspension must end within the next 365 days.');data={bannedAt:null,suspendedUntil:until,restrictionReason:input.reason};}
    else data={bannedAt:null,suspendedUntil:null,restrictionReason:null};
    return this.db.$transaction(async tx=>{const updated=await tx.user.update({where:{id:userId},data,select:{id:true,bannedAt:true,suspendedUntil:true,restrictionReason:true}});if(input.action!=='CLEAR')await tx.session.updateMany({where:{userId,revokedAt:null},data:{revokedAt:now}});await tx.auditEvent.create({data:{actorId,action:`ADMIN_USER_RESTRICTION_${input.action}`,targetId:userId}});return {...updated,bannedAt:updated.bannedAt?.toISOString()??null,suspendedUntil:updated.suspendedUntil?.toISOString()??null};});
  }

  async moderate(actorId:string,postId:string,status:DiscussionStatus) {
    const post=await this.db.discussionPost.findUnique({where:{id:postId},select:{id:true}});
    if(!post)throw new ApiError(404,'NOT_FOUND','Discussion not found.');
    return this.db.$transaction(async tx=>{const updated=await tx.discussionPost.update({where:{id:postId},data:{status},select:{id:true,status:true}});await tx.auditEvent.create({data:{actorId,action:`DISCUSSION_${status}`,targetId:postId}});return updated;});
  }

  async resolveReport(actorId:string,reportId:string,input:z.infer<typeof resolveReportInput>){
    const report=await this.db.contentReport.findUnique({where:{id:reportId},select:{id:true,status:true,postId:true}});
    if(!report)throw new ApiError(404,'NOT_FOUND','Report not found.');
    if(report.status!=='PENDING')throw new ApiError(409,'REPORT_ALREADY_REVIEWED','This report has already been reviewed.');
    return this.db.$transaction(async tx=>{if(input.postStatus)await tx.discussionPost.update({where:{id:report.postId},data:{status:input.postStatus}});const updated=await tx.contentReport.update({where:{id:reportId},data:{status:input.status,moderatorId:actorId,moderatorNote:input.moderatorNote,resolvedAt:new Date()},select:{id:true,status:true,resolvedAt:true}});await tx.auditEvent.create({data:{actorId,action:`CONTENT_REPORT_${input.status}`,targetId:reportId}});return {...updated,resolvedAt:updated.resolvedAt!.toISOString()};});
  }

  async createProblem(actorId:string,input:z.infer<typeof createProblemInput>) {
    try {
      return await this.db.$transaction(async tx=>{
        const problem=await tx.problem.create({data:{slug:input.slug}});
        const version=await tx.problemVersion.create({data:{problemId:problem.id,number:1,title:input.title,difficulty:input.difficulty,tags:[...new Set(input.tags)],statementMarkdown:input.statementMarkdown,constraints:input.constraints,timeMs:input.timeMs,memoryKiB:input.memoryKiB,inputMode:input.inputMode,templates:input.templates,published:false}});
        for(const [index,test] of input.tests.entries())await tx.testCase.create({data:{problemVersionId:version.id,ordinal:index+1,visibility:test.visibility,input:test.input,expectedOutput:test.expectedOutput,files:{create:test.files}}});
        if(input.publish){await tx.problemVersion.update({where:{id:version.id},data:{published:true}});await tx.problem.update({where:{id:problem.id},data:{currentVersionId:version.id}});}
        await tx.auditEvent.create({data:{actorId,action:input.publish?'PROBLEM_PUBLISH':'PROBLEM_DRAFT_CREATE',targetId:problem.id}});
        return {id:problem.id,slug:problem.slug,versionId:version.id,published:input.publish};
      });
    } catch(error) {if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new ApiError(409,'SLUG_TAKEN','That problem slug is already in use.');throw error;}
  }

  async editProblem(actorId:string,id:string,input:z.infer<typeof createProblemInput>) {
    const problem=await this.db.problem.findUnique({where:{id},select:{id:true,slug:true,versions:{orderBy:{number:'desc'},take:1,select:{number:true}}}});
    if(!problem)throw new ApiError(404,'NOT_FOUND','Problem not found.');
    if(problem.slug!==input.slug)throw new ApiError(409,'SLUG_IMMUTABLE','A problem slug cannot change after creation.');
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "Problem" WHERE id=${id}::uuid FOR UPDATE`;
      const latest=await tx.problemVersion.findFirst({where:{problemId:id},orderBy:{number:'desc'},select:{number:true}});
      const version=await tx.problemVersion.create({data:{problemId:id,number:(latest?.number??0)+1,title:input.title,difficulty:input.difficulty,tags:[...new Set(input.tags)],statementMarkdown:input.statementMarkdown,constraints:input.constraints,timeMs:input.timeMs,memoryKiB:input.memoryKiB,inputMode:input.inputMode,templates:input.templates,published:false}});
      for(const [index,test] of input.tests.entries())await tx.testCase.create({data:{problemVersionId:version.id,ordinal:index+1,visibility:test.visibility,input:test.input,expectedOutput:test.expectedOutput,files:{create:test.files}}});
      if(input.publish){await tx.problemVersion.update({where:{id:version.id},data:{published:true}});await tx.problem.update({where:{id},data:{currentVersionId:version.id}});}
      await tx.auditEvent.create({data:{actorId,action:input.publish?'PROBLEM_VERSION_PUBLISH':'PROBLEM_VERSION_DRAFT_CREATE',targetId:id}});
      return {id,slug:problem.slug,versionId:version.id,published:input.publish};
    });
  }

  async setProblemPublication(actorId:string,id:string,published:boolean) {
    const problem=await this.db.problem.findUnique({where:{id},select:{id:true,currentVersionId:true,versions:{orderBy:{number:'desc'},take:1,select:{id:true,published:true}}}});
    if(!problem)throw new ApiError(404,'NOT_FOUND','Problem not found.');
    const latest=problem.versions[0];
    if(published&&!latest)throw new ApiError(409,'NO_VERSION','The problem has no version to publish.');
    return this.db.$transaction(async tx=>{
      if(published&&latest&&!latest.published)await tx.problemVersion.update({where:{id:latest.id},data:{published:true}});
      await tx.problem.update({where:{id},data:{currentVersionId:published?latest!.id:null}});
      await tx.auditEvent.create({data:{actorId,action:published?'PROBLEM_PUBLISH':'PROBLEM_UNPUBLISH',targetId:id}});
      return {id,published,currentVersionId:published?latest!.id:null};
    });
  }

  async deleteProblem(actorId:string,id:string) {
    const problem=await this.db.problem.findUnique({where:{id},select:{id:true,_count:{select:{competitionProblems:true}},versions:{select:{id:true,published:true,_count:{select:{executions:true}}}}}});
    if(!problem)throw new ApiError(404,'NOT_FOUND','Problem not found.');
    if(problem._count.competitionProblems||problem.versions.some(version=>version.published||version._count.executions))throw new ApiError(409,'PROBLEM_IN_USE','Unpublish this problem instead because published or historical records reference it.');
    await this.db.$transaction(async tx=>{await tx.problem.update({where:{id},data:{currentVersionId:null}});await tx.testCase.deleteMany({where:{problemVersion:{problemId:id}}});await tx.problemVersion.deleteMany({where:{problemId:id}});await tx.problem.delete({where:{id}});await tx.auditEvent.create({data:{actorId,action:'PROBLEM_DELETE',targetId:id}});});
    return {deleted:true};
  }

  async setCompetitionPublication(actorId:string,id:string,published:boolean){const competition=await this.db.competition.findUnique({where:{id},select:{id:true}});if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');const updated=await this.db.competition.update({where:{id},data:{published},select:{id:true,slug:true,published:true}});await this.db.auditEvent.create({data:{actorId,action:published?'COMPETITION_PUBLISH':'COMPETITION_UNPUBLISH',targetId:id}});return updated;}

  async deleteCompetition(actorId:string,id:string){const competition=await this.db.competition.findUnique({where:{id},select:{id:true,rounds:{select:{_count:{select:{executions:true}}}}}});if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');if(competition.rounds.some(round=>round._count.executions))throw new ApiError(409,'COMPETITION_IN_USE','Unpublish this competition instead because submission history references it.');await this.db.$transaction(async tx=>{await tx.competition.delete({where:{id}});await tx.auditEvent.create({data:{actorId,action:'COMPETITION_DELETE',targetId:id}});});return {deleted:true};}

  async createCompetition(actorId:string,input:z.infer<typeof createCompetitionInput>) {
    const startsAt=new Date(input.startsAt),endsAt=new Date(input.endsAt);
    if(endsAt<=startsAt)throw new ApiError(400,'INVALID_SCHEDULE','Competition end must be after its start.');
    if(input.kind==='CONTEST'&&input.rounds.length!==1)throw new ApiError(400,'INVALID_ROUNDS','A contest must contain exactly one round.');
    for(const round of input.rounds){const start=new Date(round.startsAt),end=new Date(round.endsAt);if(start<startsAt||end>endsAt||end<=start)throw new ApiError(400,'INVALID_SCHEDULE','Every round must fit inside the competition schedule.');}
    const problemSlugs=[...new Set(input.rounds.flatMap(round=>round.problemSlugs))];
    const problems=await this.db.problem.findMany({where:{slug:{in:problemSlugs},currentVersion:{published:true}},select:{id:true,slug:true}});
    if(problems.length!==problemSlugs.length)throw new ApiError(400,'INVALID_PROBLEM','Every round problem must reference a published problem.');
    const ids=new Map(problems.map(problem=>[problem.slug,problem.id]));
    try{return await this.db.$transaction(async tx=>{const competition=await tx.competition.create({data:{slug:input.slug,kind:input.kind,title:input.title,description:input.description,rulesMarkdown:input.rulesMarkdown,prizeLabel:input.prizeLabel,startsAt,endsAt,published:input.published}});for(const [index,round] of input.rounds.entries()){const created=await tx.competitionRound.create({data:{competitionId:competition.id,title:round.title,ordinal:index+1,startsAt:new Date(round.startsAt),endsAt:new Date(round.endsAt)}});await tx.competitionProblem.createMany({data:round.problemSlugs.map((problemSlug,problemIndex)=>({roundId:created.id,problemId:ids.get(problemSlug)!,ordinal:problemIndex+1,points:100}))});}await tx.auditEvent.create({data:{actorId,action:input.published?'COMPETITION_PUBLISH':'COMPETITION_DRAFT_CREATE',targetId:competition.id}});return {id:competition.id,slug:competition.slug,published:competition.published};});}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new ApiError(409,'SLUG_TAKEN','That competition slug is already in use.');throw error;}
  }
}

@Controller('admin')
@UseGuards(SessionGuard,RolesGuard)
@RequireRoles('ADMIN')
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin:AdminService){}
  @Get('overview') overview(){return this.admin.overview();}
  @Get('analytics') analytics(@Query() query:unknown){return this.admin.analytics(validate(analyticsQuery,query).days);}
  @Get('analytics/export') analyticsExport(@Query() query:unknown){return this.admin.analyticsExport(validate(analyticsQuery,query).days);}
  @Get('users') users(@Query() query:unknown){return this.admin.users(validate(userQuery,query));}
  @Get('submissions') submissions(@Query() query:unknown){return this.admin.submissions(validate(cursorQuery,query).cursor);}
  @Get('problems') problems(){return this.admin.problems();}
  @Get('problems/:id') problem(@Param('id') id:string){return this.admin.problem(validate(uuid,id));}
  @Get('moderation') @RequireRoles('ADMIN','MODERATOR') moderation(){return this.admin.moderation();}
  @Get('competitions') competitions(){return this.admin.competitions();}
  @Patch('users/:id/role') setRole(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.setRole(req.principal.userId,validate(uuid,id),validate(roleInput,body).role);}
  @Patch('users/:id/restriction') restrict(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.restrict(req.principal.userId,validate(uuid,id),validate(restrictionInput,body));}
  @Patch('reports/:id') @RequireRoles('ADMIN','MODERATOR') resolveReport(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.resolveReport(req.principal.userId,validate(uuid,id),validate(resolveReportInput,body));}
  @Patch('discussions/:id/status') @RequireRoles('ADMIN','MODERATOR') moderate(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.moderate(req.principal.userId,validate(uuid,id),validate(moderationInput,body).status);}
  @Post('problems') createProblem(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.admin.createProblem(req.principal.userId,validate(createProblemInput,body));}
  @Patch('problems/:id') editProblem(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.editProblem(req.principal.userId,validate(uuid,id),validate(createProblemInput,body));}
  @Patch('problems/:id/publication') setProblemPublication(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.setProblemPublication(req.principal.userId,validate(uuid,id),validate(publicationInput,body).published);}
  @Delete('problems/:id') @HttpCode(200) deleteProblem(@Req() req:AuthenticatedRequest,@Param('id') id:string){return this.admin.deleteProblem(req.principal.userId,validate(uuid,id));}
  @Post('competitions') createCompetition(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.admin.createCompetition(req.principal.userId,validate(createCompetitionInput,body));}
  @Patch('competitions/:id/publication') setCompetitionPublication(@Req() req:AuthenticatedRequest,@Param('id') id:string,@Body() body:unknown){return this.admin.setCompetitionPublication(req.principal.userId,validate(uuid,id),validate(publicationInput,body).published);}
  @Delete('competitions/:id') @HttpCode(200) deleteCompetition(@Req() req:AuthenticatedRequest,@Param('id') id:string){return this.admin.deleteCompetition(req.principal.userId,validate(uuid,id));}
}
