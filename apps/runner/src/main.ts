import { readFile } from 'node:fs/promises';
import { SandboxSupervisor } from './supervisor';
import { DockerCli } from './transport';
import { listenSupervisor } from './server';
async function main(){
  const path=process.env.RUNNER_IMAGE_MANIFEST;if(!path)throw new Error('MANIFEST_REQUIRED');
  const supervisor=new SandboxSupervisor(new DockerCli(),JSON.parse(await readFile(path,'utf8')));
  if(process.argv.includes('--janitor')) {await supervisor.reapExpired();console.log('RUNNER_JANITOR_PASSED');return;}
  await supervisor.preflight();await supervisor.reapExpired();
  const socketPath=process.env.RUNNER_SOCKET_PATH;if(!socketPath)throw new Error('SOCKET_REQUIRED');
  const host=await listenSupervisor(supervisor,socketPath);
  let closing=false;const stop=()=>{if(closing)return;closing=true;void host.close().catch(()=>{console.error('RUNNER_SHUTDOWN_FAILED');process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);console.log('RUNNER_SUPERVISOR_READY');
}
void main().catch(()=>{console.error('RUNNER_STARTUP_FAILED');process.exitCode=1;});
