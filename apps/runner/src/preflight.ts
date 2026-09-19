import { readFile } from 'node:fs/promises';
import { SandboxSupervisor } from './supervisor';
import { DockerCli } from './transport';
async function main(){
  const path=process.env.RUNNER_IMAGE_MANIFEST;
  if(!path)throw new Error('RUNNER_IMAGE_MANIFEST_REQUIRED');
  const supervisor=new SandboxSupervisor(new DockerCli(),JSON.parse(await readFile(path,'utf8')));
  await supervisor.preflight();await supervisor.reapExpired();
  console.log('RUNNER_PREFLIGHT_PASSED_CONFIGURATION_ONLY');
}
void main().catch(()=>{console.error('RUNNER_PREFLIGHT_FAILED');process.exitCode=1;});
