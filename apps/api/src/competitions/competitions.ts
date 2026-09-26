import {Body, Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req, UseGuards} from '@nestjs/common';
import {CompetitionKind,Prisma} from '@prisma/client';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {ApiError, validate} from '../common/errors';
import {Database} from '../database/database';

const slugSchema=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const querySchema=z.strictObject({kind:z.enum(['CONTEST','TOURNAMENT']).optional()});
const createSchema=z.strictObject({slug:slugSchema,kind:z.enum(['CONTEST','TOURNAMENT']),title:z.string().trim().min(3).max(160),description:z.string().trim().min(10).max(1000),rulesMarkdown:z.string().trim().min(10).max(20_000),prizeLabel:z.string().trim().max(100).optional(),startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),rounds:z.array(z.strictObject({title:z.string().trim().min(2).max(100),startsAt:z.iso.datetime(),endsAt:z.iso.datetime(),problemSlugs:z.array(slugSchema).min(1).max(30)})).min(1).max(10)});

function status(startsAt:Date,endsAt:Date,now=new Date()) {
  if(now<startsAt)return 'UPCOMING' as const;
  if(now>=endsAt)return 'FINISHED' as const;
  return 'LIVE' as const;
}

@Injectable()
export class Competitions {
  constructor(@Inject(Database) private readonly db:Database){}

  async list(kind?:CompetitionKind) {
    const rows=await this.db.competition.findMany({where:{published:true,...(kind?{kind}:{})},select:{id:true,slug:true,kind:true,title:true,description:true,prizeLabel:true,startsAt:true,endsAt:true,_count:{select:{registrations:true,rounds:true}}},orderBy:[{startsAt:'asc'},{id:'asc'}]});
    return {items:rows.map(row=>({...row,startsAt:row.startsAt.toISOString(),endsAt:row.endsAt.toISOString(),status:status(row.startsAt,row.endsAt),registrations:row._count.registrations,rounds:row._count.rounds,_count:undefined}))};
  }

  async detail(slug:string) {
    const row=await this.db.competition.findFirst({where:{slug,published:true},select:{id:true,slug:true,kind:true,title:true,description:true,rulesMarkdown:true,prizeLabel:true,startsAt:true,endsAt:true,_count:{select:{registrations:true}},rounds:{select:{id:true,title:true,ordinal:true,startsAt:true,endsAt:true,problems:{select:{ordinal:true,points:true,problem:{select:{id:true,slug:true,currentVersion:{select:{title:true,difficulty:true,tags:true}}}}},orderBy:{ordinal:'asc'}}},orderBy:{ordinal:'asc'}}}});
    if(!row)throw new ApiError(404,'NOT_FOUND','Competition not found.');
    return {...row,startsAt:row.startsAt.toISOString(),endsAt:row.endsAt.toISOString(),status:status(row.startsAt,row.endsAt),registrations:row._count.registrations,_count:undefined,rounds:row.rounds.map(round=>({...round,startsAt:round.startsAt.toISOString(),endsAt:round.endsAt.toISOString(),status:status(round.startsAt,round.endsAt),problems:round.problems.flatMap(item=>item.problem.currentVersion?[{id:item.problem.id,slug:item.problem.slug,title:item.problem.currentVersion.title,difficulty:item.problem.currentVersion.difficulty,tags:item.problem.currentVersion.tags,points:item.points,ordinal:item.ordinal}]:[])}))};
  }

  async register(userId:string,slug:string) {
    const competition=await this.db.competition.findFirst({where:{slug,published:true},select:{id:true,startsAt:true,endsAt:true}});
    if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');
    if(new Date()>=competition.endsAt)throw new ApiError(409,'REGISTRATION_CLOSED','This competition has finished.');
    const registration=await this.db.competitionRegistration.upsert({where:{competitionId_userId:{competitionId:competition.id,userId}},create:{competitionId:competition.id,userId},update:{},select:{joinedAt:true}});
    return {registered:true,joinedAt:registration.joinedAt.toISOString()};
  }

  async registration(userId:string,slug:string){const competition=await this.db.competition.findFirst({where:{slug,published:true},select:{id:true}});if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');const row=await this.db.competitionRegistration.findUnique({where:{competitionId_userId:{competitionId:competition.id,userId}},select:{joinedAt:true}});return row?{registered:true,joinedAt:row.joinedAt.toISOString()}:{registered:false};}

  async create(userId:string,input:z.infer<typeof createSchema>){const startsAt=new Date(input.startsAt),endsAt=new Date(input.endsAt),now=new Date();if(startsAt.getTime()<now.getTime()+5*60_000)throw new ApiError(400,'INVALID_SCHEDULE','Competition must start at least five minutes in the future.');if(endsAt<=startsAt)throw new ApiError(400,'INVALID_SCHEDULE','Competition end must be after its start.');if(input.kind==='CONTEST'&&input.rounds.length!==1)throw new ApiError(400,'INVALID_ROUNDS','A contest must contain exactly one round.');for(const round of input.rounds){const start=new Date(round.startsAt),end=new Date(round.endsAt);if(start<startsAt||end>endsAt||end<=start)throw new ApiError(400,'INVALID_SCHEDULE','Every round must fit inside the competition schedule.');}const slugs=[...new Set(input.rounds.flatMap(round=>round.problemSlugs))];const problems=await this.db.problem.findMany({where:{slug:{in:slugs},currentVersion:{published:true}},select:{id:true,slug:true}});if(problems.length!==slugs.length)throw new ApiError(400,'INVALID_PROBLEM','Every round problem must reference a published problem.');const ids=new Map(problems.map(problem=>[problem.slug,problem.id]));try{return await this.db.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userId}::uuid FOR UPDATE`;const active=await tx.competition.count({where:{ownerId:userId,endsAt:{gt:now}}});if(active>=5)throw new ApiError(429,'COMPETITION_LIMIT','You can manage at most five upcoming or live competitions.');const competition=await tx.competition.create({data:{ownerId:userId,slug:input.slug,kind:input.kind,title:input.title,description:input.description,rulesMarkdown:input.rulesMarkdown,prizeLabel:input.prizeLabel,startsAt,endsAt,published:true}});for(const [index,round] of input.rounds.entries()){const created=await tx.competitionRound.create({data:{competitionId:competition.id,title:round.title,ordinal:index+1,startsAt:new Date(round.startsAt),endsAt:new Date(round.endsAt)}});await tx.competitionProblem.createMany({data:round.problemSlugs.map((problemSlug,ordinal)=>({roundId:created.id,problemId:ids.get(problemSlug)!,ordinal:ordinal+1,points:100}))});}await tx.competitionRegistration.create({data:{competitionId:competition.id,userId}});await tx.auditEvent.create({data:{actorId:userId,action:'USER_COMPETITION_CREATE',targetId:competition.id}});return {id:competition.id,slug:competition.slug,kind:competition.kind};});}catch(error){if(error instanceof Prisma.PrismaClientKnownRequestError&&error.code==='P2002')throw new ApiError(409,'SLUG_TAKEN','That competition slug is already in use.');throw error;}}

  async leaderboard(slug:string) {
    const competition=await this.db.competition.findFirst({where:{slug,published:true},select:{id:true,startsAt:true,endsAt:true,rounds:{select:{problems:{select:{problemId:true,points:true}}}}}});
    if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');
    const points=new Map<string,number>();
    for(const round of competition.rounds)for(const problem of round.problems)points.set(problem.problemId,Math.max(points.get(problem.problemId)??0,problem.points));
    const registrations=await this.db.competitionRegistration.findMany({where:{competitionId:competition.id},select:{joinedAt:true,user:{select:{id:true,username:true,displayName:true,executions:{where:{mode:'SUBMIT',competitionRound:{competitionId:competition.id}},select:{verdict:true,createdAt:true,problemVersion:{select:{problemId:true}}},orderBy:{createdAt:'asc'}}}}}});
    const items=registrations.map(registration=>{
      const solved=new Map<string,Date>(); let wrongAttempts=0;
      for(const execution of registration.user.executions){if(execution.createdAt<registration.joinedAt)continue;const problemId=execution.problemVersion.problemId;if(solved.has(problemId))continue;if(execution.verdict==='ACCEPTED')solved.set(problemId,execution.createdAt);else wrongAttempts++;}
      const score=[...solved.keys()].reduce((sum,id)=>sum+(points.get(id)??0),0);
      const elapsedMinutes=[...solved.values()].reduce((sum,date)=>sum+Math.max(0,Math.floor((date.getTime()-competition.startsAt.getTime())/60_000)),0);
      return {username:registration.user.username,displayName:registration.user.displayName,score,solved:solved.size,penalty:elapsedMinutes+wrongAttempts*20,joinedAt:registration.joinedAt.toISOString()};
    }).sort((a,b)=>b.score-a.score||b.solved-a.solved||a.penalty-b.penalty||a.username.localeCompare(b.username)).map((entry,index)=>({rank:index+1,...entry}));
    return {items};
  }
}

@Controller('competitions')
export class CompetitionsController {
  constructor(@Inject(Competitions) private readonly competitions:Competitions){}
  @Get() list(@Query() query:unknown){return this.competitions.list(validate(querySchema,query).kind);}
  @Get(':slug') detail(@Param('slug') slug:string){return this.competitions.detail(validate(slugSchema,slug));}
  @Get(':slug/leaderboard') leaderboard(@Param('slug') slug:string){return this.competitions.leaderboard(validate(slugSchema,slug));}
  @Get(':slug/registration') @UseGuards(SessionGuard)
  registration(@Req() req:AuthenticatedRequest,@Param('slug') slug:string){return this.competitions.registration(req.principal.userId,validate(slugSchema,slug));}
  @Post() @HttpCode(201) @UseGuards(SessionGuard)
  create(@Req() req:AuthenticatedRequest,@Body() body:unknown){return this.competitions.create(req.principal.userId,validate(createSchema,body));}
  @Post(':slug/register') @HttpCode(200) @UseGuards(SessionGuard)
  register(@Req() req:AuthenticatedRequest,@Param('slug') slug:string){return this.competitions.register(req.principal.userId,validate(slugSchema,slug));}
}
