import {PrismaClient} from '@prisma/client';
import {ExecutionMode,Language} from '@arenacore/contracts';
import {JudgePlan,judge,selectCases} from '@arenacore/judge';
import {SandboxRequest,sandboxRequestSchema} from '@arenacore/runtime-policy';
export interface ObservationExecutor {execute(request:SandboxRequest,signal:AbortSignal):Promise<unknown>}
export async function loadJudgePlan(db:PrismaClient,versionId:string,mode:ExecutionMode):Promise<JudgePlan> {
  const version=await db.problemVersion.findFirst({where:{id:versionId,published:true},select:{id:true,comparator:true,timeMs:true,memoryKiB:true,testCases:{where:mode==='RUN'?{visibility:'PUBLIC'}:{},orderBy:{ordinal:'asc'},select:{id:true,ordinal:true,visibility:true,input:true,expectedOutput:true}}}});
  if(!version||version.comparator!=='EXACT_NEWLINE')throw new Error('JUDGE_PLAN_UNAVAILABLE');
  return {versionId:version.id,comparator:version.comparator,timeMs:version.timeMs,memoryKiB:version.memoryKiB,cases:version.testCases};
}
export class JudgingBackend {
  constructor(private readonly executor:ObservationExecutor,private readonly load:(versionId:string,mode:ExecutionMode)=>Promise<JudgePlan>){}
  async execute(context:{execution:{id:string;attempt:number;problemVersionId:string;language:Language;mode:ExecutionMode;sourceCode:string};signal:AbortSignal;markRunning:()=>Promise<boolean>;console?:(caseId:string,stream:'stdout'|'stderr',text:string)=>Promise<boolean>}) {
    const e=context.execution,plan=await this.load(e.problemVersionId,e.mode);
    if(plan.versionId!==e.problemVersionId)throw new Error('JUDGE_VERSION_MISMATCH');
    const selected=selectCases(plan,e.mode);
    const request=sandboxRequestSchema.parse({executionId:e.id,attempt:e.attempt,language:e.language,sourceCode:e.sourceCode,cases:selected.map(c=>({id:c.id,input:c.input})),timeMs:plan.timeMs,memoryMiB:plan.memoryKiB/1024});
    const observed=await this.executor.execute(request,context.signal);
    const result=judge(plan,e.mode,e.language,observed);
    if(result.verdict!=='COMPILATION_ERROR'&&!await context.markRunning())throw new Error('WORKER_AUTHORITY_LOST');
    if(e.mode==='RUN'&&context.console)for(const c of result.publicCaseResults??[]){
      for(const stream of ['stdout','stderr'] as const){const text=c[stream];if(text&&!await context.console(c.caseId,stream,text))throw new Error('WORKER_AUTHORITY_LOST');}
    }
    return result;
  }
}
