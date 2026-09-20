import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { Config } from '../config/config';
import { Database } from '../database/database';
import { redisOptions } from './queue';

type Language='python'|'javascript'|'java';
type Mode='RUN'|'SUBMIT';
type Expected='ACCEPTED'|'WRONG_ANSWER';
interface Fixture {id:string;language:Language;mode:Mode;expected:Expected}

const sources:Record<Language,string>={
  python:"import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n",
  javascript:"const fs=require('node:fs');const [a,b]=fs.readFileSync(0,'utf8').trim().split(/\\s+/).map(Number);console.log(a+b);\n",
  java:"import java.util.Scanner; public class Solution { public static void main(String[] args) { Scanner s=new Scanner(System.in); long a=s.nextLong(); long b=s.nextLong(); System.out.println(a+b); } }\n",
};
const hiddenSentinels=['1000000000 1000000000','2000000000'];
let stage='CONFIGURATION';

const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
async function within<T>(promise:Promise<T>,milliseconds:number) {
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('TIMEOUT')),milliseconds);})]);}
  finally{if(timer)clearTimeout(timer);}
}
function hash(language:Language,mode:Mode,sourceCode:string){return createHash('sha256').update(JSON.stringify({language,mode,sourceCode})).digest('hex');}

async function main(){
  const config=new Config();
  if(process.env.LIVE_JUDGING_ACCEPTANCE!=='true'||config.values.NODE_ENV!=='production'||config.values.EXECUTIONS_ENABLED!=='false'||config.values.PIPELINE_ENABLED!=='false'||!config.values.REDIS_URL)throw new Error('ACCEPTANCE_DISABLED');
  const db=new Database(config),queue=new Queue(config.values.QUEUE_NAME,{connection:redisOptions(config.values.REDIS_URL)});queue.on('error',()=>{});
  const fixtures:Fixture[]=[];let userId:string|undefined;
  try{
    stage='DEPENDENCY_CONNECTION';await Promise.all([db.$connect(),within(queue.waitUntilReady(),10000)]);
    stage='IDLE_PREFLIGHT';
    const [unfinished,waiting,active,delayed,prioritized]=await Promise.all([
      db.execution.count({where:{state:{in:['QUEUED','COMPILING','RUNNING']}}}),queue.getWaitingCount(),queue.getActiveCount(),queue.getDelayedCount(),queue.getPrioritizedCount(),
    ]);
    if(unfinished||waiting||active||delayed||prioritized)throw new Error('ACCEPTANCE_REQUIRES_IDLE_SYSTEM');
    const version=await db.problemVersion.findFirst({where:{published:true,problem:{slug:'sum-two-numbers'}},select:{id:true,testCases:{orderBy:{ordinal:'asc'},select:{id:true,visibility:true,input:true,expectedOutput:true}}}});
    if(!version||version.testCases.filter(test=>test.visibility==='PUBLIC').length!==2||version.testCases.filter(test=>test.visibility==='HIDDEN').length!==1)throw new Error('ACCEPTANCE_FIXTURE_UNAVAILABLE');

    stage='FIXTURE_CREATION';const runId=randomUUID();
    userId=(await db.user.create({data:{issuer:'urn:arenacore:live-acceptance',subject:runId,displayName:'Live judging acceptance'}})).id;
    const plans:Array<{language:Language;mode:Mode;sourceCode:string;expected:Expected}>=[];
    for(const language of ['python','javascript','java'] as const){plans.push({language,mode:'RUN',sourceCode:sources[language],expected:'ACCEPTED'},{language,mode:'SUBMIT',sourceCode:sources[language],expected:'ACCEPTED'});}
    plans.push({language:'python',mode:'SUBMIT',sourceCode:"import sys\nprint(sys.stdin.read(), end='')\n",expected:'WRONG_ANSWER'});
    for(const plan of plans){
      const row=await db.execution.create({data:{userId,problemVersionId:version.id,language:plan.language,mode:plan.mode,sourceCode:plan.sourceCode,payloadHash:hash(plan.language,plan.mode,plan.sourceCode),idempotencyKey:`live-acceptance-${randomUUID()}`,queueExpiresAt:new Date(Date.now()+300000)}});
      fixtures.push({id:row.id,language:plan.language,mode:plan.mode,expected:plan.expected});
      await queue.add('execution',{executionId:row.id},{jobId:`exec-${row.id}-g0`,attempts:1,removeOnComplete:{age:3600,count:100},removeOnFail:{age:3600,count:100}});
    }

    stage='LIVE_EXECUTION';const deadline=Date.now()+180000;
    for(;;){
      const rows=await db.execution.findMany({where:{id:{in:fixtures.map(f=>f.id)}},select:{state:true}});
      if(rows.length===fixtures.length&&rows.every(row=>['FINISHED','INTERNAL_ERROR','CANCELLED'].includes(row.state)))break;
      if(Date.now()>deadline)throw new Error('ACCEPTANCE_EXECUTION_TIMEOUT');
      await sleep(250);
    }

    stage='RESULT_VERIFICATION';
    const rows=await db.execution.findMany({where:{id:{in:fixtures.map(f=>f.id)}},select:{id:true,state:true,verdict:true,attempt:true,failureCode:true,leaseToken:true,leaseExpiresAt:true,publicResults:true,publicEvents:{orderBy:{sequence:'asc'},select:{kind:true,payload:true}}}});
    const publicIds=new Set(version.testCases.filter(test=>test.visibility==='PUBLIC').map(test=>test.id));
    for(const fixture of fixtures){
      const row=rows.find(candidate=>candidate.id===fixture.id);
      if(!row||row.state!=='FINISHED'||row.verdict!==fixture.expected||row.attempt!==1||row.failureCode||row.leaseToken||row.leaseExpiresAt)throw new Error('ACCEPTANCE_TERMINAL_MISMATCH');
      const stored=JSON.stringify({publicResults:row.publicResults,events:row.publicEvents});
      if(hiddenSentinels.some(sentinel=>stored.includes(sentinel)))throw new Error('ACCEPTANCE_HIDDEN_DATA_LEAK');
      if(fixture.mode==='SUBMIT'){
        if(row.publicResults!==null||row.publicEvents.some(event=>event.kind==='console_output'))throw new Error('ACCEPTANCE_SUBMIT_DISCLOSURE');
      }else{
        if(!Array.isArray(row.publicResults)||row.publicResults.length!==publicIds.size)throw new Error('ACCEPTANCE_RUN_RESULTS');
        const resultIds=new Set(row.publicResults.map(value=>typeof value==='object'&&value!==null&&'caseId' in value?String(value.caseId):''));
        if(resultIds.size!==publicIds.size||[...resultIds].some(id=>!publicIds.has(id)))throw new Error('ACCEPTANCE_RUN_VISIBILITY');
      }
    }
    stage='CLEANUP';const cleanupDeadline=Date.now()+10000;
    for(;;){
      const states=await Promise.all(fixtures.map(async fixture=>(await queue.getJob(`exec-${fixture.id}-g0`))?.getState()));
      if(states.every(state=>state!=='active'))break;
      if(Date.now()>cleanupDeadline)throw new Error('ACCEPTANCE_QUEUE_DRAIN_TIMEOUT');
      await sleep(100);
    }
    for(const fixture of fixtures){const job=await queue.getJob(`exec-${fixture.id}-g0`);await job?.remove();}
    await db.execution.deleteMany({where:{id:{in:fixtures.map(f=>f.id)}}});
    await db.user.deleteMany({where:{id:userId}});userId=undefined;
    console.log('LIVE_JUDGING_ACCEPTANCE_PASSED');
  }finally{
    await queue.close().catch(()=>{});await db.$disconnect().catch(()=>{});
  }
}

void main().catch(()=>{console.error(`LIVE_JUDGING_ACCEPTANCE_FAILED ${stage}`);process.exitCode=1;});
