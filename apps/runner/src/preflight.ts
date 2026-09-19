import { readFile } from 'node:fs/promises';
import { ZodError } from 'zod';
import { SandboxSupervisor } from './supervisor';
import { DockerCli, DockerError } from './transport';
async function main(){
  const path=process.env.RUNNER_IMAGE_MANIFEST;
  if(!path)throw new Error('RUNNER_IMAGE_MANIFEST_REQUIRED');
  const supervisor=new SandboxSupervisor(new DockerCli(),JSON.parse(await readFile(path,'utf8')));
  await supervisor.preflight();await supervisor.reapExpired();
  console.log('RUNNER_PREFLIGHT_PASSED_CONFIGURATION_ONLY');
}
void main().catch((error:unknown)=>{
  const expected=error instanceof Error&&['ISOLATION_UNAVAILABLE','UNTRUSTED_RUNTIME_IMAGE'].includes(error.message)?error.message
    :error instanceof DockerError?error.code
    :error instanceof ZodError?'PREFLIGHT_VALIDATION_FAILED'
    :'PREFLIGHT_UNKNOWN_FAILURE';
  console.error(`RUNNER_PREFLIGHT_FAILED ${expected}`);process.exitCode=1;
});
