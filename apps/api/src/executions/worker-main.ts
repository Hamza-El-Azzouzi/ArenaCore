// Separate process on the dedicated runner VM. Never imported by HTTP bootstrap.
import { Database } from '../database/database';
import { JobStore } from './job-store';
import { redisOptions, startExecutionWorker } from './queue';
import { parseWorkerConfig } from './worker-config';
import { SupervisorClient,JudgingBackend,loadJudgePlan } from '@arenacore/runner';
import { Queue } from 'bullmq';
import { request as httpRequest } from 'node:http';

type StartupStage='CONFIGURATION'|'DATABASE_CONNECTION'|'DATABASE_PRIVILEGES'|'REDIS_CONNECTION'|'SUPERVISOR_CONNECTION'|'WORKER_INITIALIZATION'|'READY';
let startupStage:StartupStage='CONFIGURATION';

async function within<T>(promise:Promise<T>,milliseconds:number) {
  let timer:NodeJS.Timeout|undefined;
  try {return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('WORKER_READY_TIMEOUT')),milliseconds);})]);}
  finally {if(timer)clearTimeout(timer);}
}
async function checkSupervisor(socketPath:string) {
  const status=await within(new Promise<number>((resolve,reject)=>{
    const request=httpRequest({socketPath,path:'/health',method:'GET'},response=>{response.resume();response.once('end',()=>resolve(response.statusCode??0));});
    request.once('error',reject);request.end();
  }),2000);
  // The private protocol currently rejects GET and therefore proves that the
  // expected bounded HTTP server, rather than an arbitrary socket, answered.
  if(status!==400)throw new Error('SUPERVISOR_CHECK_FAILED');
}
async function main(){
  if(process.argv.length>3 || (process.argv[2] && process.argv[2]!=='--check'))throw new Error('WORKER_ARGUMENT_INVALID');
  const config=parseWorkerConfig(process.env);
  const client=new SupervisorClient(config.RUNNER_SOCKET_PATH),db=new Database({values:{DATABASE_URL:config.DATABASE_URL}});
  startupStage='DATABASE_CONNECTION';await db.$connect();
  if(process.argv[2]==='--check') {
    const queue=new Queue(config.QUEUE_NAME,{connection:redisOptions(config.REDIS_URL)});queue.on('error',()=>{});
    try {
      startupStage='DATABASE_PRIVILEGES';
      const [permissions]=await db.$queryRaw<Array<{ok:boolean}>>`SELECT has_schema_privilege(current_user, 'public', 'USAGE') AND has_table_privilege(current_user, 'public."Execution"', 'SELECT,UPDATE') AND has_table_privilege(current_user, 'public."ExecutionEvent"', 'SELECT,INSERT,DELETE') AND has_table_privilege(current_user, 'public."ProblemVersion"', 'SELECT') AND has_table_privilege(current_user, 'public."TestCase"', 'SELECT') AS ok`;
      if(!permissions?.ok)throw new Error('WORKER_DATABASE_PRIVILEGES_REQUIRED');
      startupStage='REDIS_CONNECTION';await within(queue.waitUntilReady(),10000);
      startupStage='SUPERVISOR_CONNECTION';await checkSupervisor(config.RUNNER_SOCKET_PATH);
      startupStage='READY';console.log('WORKER_DEPENDENCY_CHECK_PASSED');
    }
    finally {await queue.close().catch(()=>{});await db.$disconnect().catch(()=>{});}
    return;
  }
  startupStage='WORKER_INITIALIZATION';
  const backend=new JudgingBackend(client,(id,mode)=>loadJudgePlan(db,id,mode));
  const worker=startExecutionWorker(new JobStore(db),config.REDIS_URL,config.QUEUE_NAME,backend);
  try {
    await within(worker.waitUntilReady(),10000);
  } catch(error) {
    await worker.close(true).catch(()=>{});await db.$disconnect().catch(()=>{});throw error;
  }
  startupStage='READY';
  let closing=false;const close=()=>{if(closing)return;closing=true;void worker.close().finally(()=>db.$disconnect()).catch(()=>{console.error('WORKER_SHUTDOWN_FAILED');process.exitCode=1;});};
  process.once('SIGTERM',close);process.once('SIGINT',close);console.log('JUDGING_WORKER_STARTED');
}
void main().catch(()=>{console.error(`JUDGING_WORKER_STARTUP_FAILED ${startupStage}`);process.exitCode=1;});
