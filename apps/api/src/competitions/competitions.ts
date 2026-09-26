import {Controller, Get, HttpCode, Inject, Injectable, Param, Post, Query, Req, UseGuards} from '@nestjs/common';
import {CompetitionKind} from '@prisma/client';
import {z} from 'zod';
import {AuthenticatedRequest, SessionGuard} from '../auth/session';
import {ApiError, validate} from '../common/errors';
import {Database} from '../database/database';

const slugSchema=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const querySchema=z.strictObject({kind:z.enum(['CONTEST','TOURNAMENT']).optional()});

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

  async leaderboard(slug:string) {
    const competition=await this.db.competition.findFirst({where:{slug,published:true},select:{id:true,startsAt:true,endsAt:true,rounds:{select:{problems:{select:{problemId:true,points:true}}}}}});
    if(!competition)throw new ApiError(404,'NOT_FOUND','Competition not found.');
    const points=new Map<string,number>();
    for(const round of competition.rounds)for(const problem of round.problems)points.set(problem.problemId,Math.max(points.get(problem.problemId)??0,problem.points));
    const registrations=await this.db.competitionRegistration.findMany({where:{competitionId:competition.id},select:{joinedAt:true,user:{select:{id:true,username:true,displayName:true,executions:{where:{mode:'SUBMIT',createdAt:{gte:competition.startsAt,lte:competition.endsAt},problemVersion:{problemId:{in:[...points.keys()]}}},select:{verdict:true,createdAt:true,problemVersion:{select:{problemId:true}}},orderBy:{createdAt:'asc'}}}}}});
    const items=registrations.map(registration=>{
      const solved=new Map<string,Date>(); let wrongAttempts=0;
      for(const execution of registration.user.executions){const problemId=execution.problemVersion.problemId;if(solved.has(problemId))continue;if(execution.verdict==='ACCEPTED')solved.set(problemId,execution.createdAt);else wrongAttempts++;}
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
  @Post(':slug/register') @HttpCode(200) @UseGuards(SessionGuard)
  register(@Req() req:AuthenticatedRequest,@Param('slug') slug:string){return this.competitions.register(req.principal.userId,validate(slugSchema,slug));}
}
