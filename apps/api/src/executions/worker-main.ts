// Separate process on the dedicated runner VM. Never imported by HTTP bootstrap.
import { Config } from '../config/config';
import { Database } from '../database/database';
import { JobStore } from './job-store';
import { startExecutionWorker } from './queue';
import { SupervisorClient,JudgingBackend,loadJudgePlan } from '@arenacore/runner';
async function main(){
  if(process.env.RUNNER_WORKER_ENABLED!=='true'||process.env.NODE_ENV==='production')throw new Error('WORKER_DISABLED');
  const config=new Config(),url=config.values.REDIS_URL,path=process.env.RUNNER_SOCKET_PATH;
  if(!url||!path)throw new Error('WORKER_CONFIGURATION_REQUIRED');
  const client=new SupervisorClient(path),db=new Database(config);await db.$connect();
  const backend=new JudgingBackend(client,(id,mode)=>loadJudgePlan(db,id,mode));
  const worker=startExecutionWorker(new JobStore(db),url,config.values.QUEUE_NAME,backend);
  let closing=false;const close=()=>{if(closing)return;closing=true;void worker.close().finally(()=>db.$disconnect()).catch(()=>{console.error('WORKER_SHUTDOWN_FAILED');process.exitCode=1;});};
  process.once('SIGTERM',close);process.once('SIGINT',close);console.log('JUDGING_WORKER_STARTED');
}
void main().catch(()=>{console.error('JUDGING_WORKER_STARTUP_FAILED');process.exitCode=1;});
