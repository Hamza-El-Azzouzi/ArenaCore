import { randomUUID } from 'node:crypto';
import { SupervisorClient } from './client';
import type { ExecutionObservation } from './supervisor';

function assertMeasured(observation:ExecutionObservation,expectedOutput:string) {
  const measured=observation.cases[0];
  if(observation.cases.length!==1||measured?.stdout!==expectedOutput||measured.exitCode!==0||measured.failure!==undefined||typeof measured.cpuMs!=='number'||!Number.isInteger(measured.cpuMs)||measured.cpuMs<=0||typeof measured.memoryKiB!=='number'||!Number.isInteger(measured.memoryKiB)||measured.memoryKiB<32*1024||measured.memoryKiB>128*1024)throw new Error('MEASURED_CASE_INVALID');
}

function assertOom(observation:ExecutionObservation) {
  const measured=observation.cases[0];
  if(observation.cases.length!==1||measured?.failure!=='MEMORY_LIMIT_EXCEEDED'||typeof measured.cpuMs!=='number'||!Number.isInteger(measured.cpuMs)||typeof measured.memoryKiB!=='number'||!Number.isInteger(measured.memoryKiB)||measured.memoryKiB<=0||measured.memoryKiB>64*1024)throw new Error('OOM_CASE_INVALID');
}

async function main() {
  if(process.env.RUNNER_METRICS_ACCEPTANCE!=='true')throw new Error('ACCEPTANCE_DISABLED');
  const socket=process.env.RUNNER_SOCKET_PATH;
  if(!socket?.startsWith('/'))throw new Error('SOCKET_REQUIRED');
  const client=new SupervisorClient(socket);
  stage='MEASURED_EXECUTION';
  const measured=await client.execute({executionId:randomUUID(),attempt:1,language:'python',sourceCode:"x=bytearray(32*1024*1024)\ns=sum(range(3000000))\nprint('MEASURED')",cases:[{id:randomUUID(),input:''}],timeMs:5000,memoryMiB:128},new AbortController().signal);
  stage='MEASURED_ASSERTION';
  assertMeasured(measured,'MEASURED\n');
  stage='OOM_EXECUTION';
  const oom=await client.execute({executionId:randomUUID(),attempt:1,language:'python',sourceCode:"x=bytearray(512*1024*1024)\nprint('LEAK')",cases:[{id:randomUUID(),input:''}],timeMs:5000,memoryMiB:64},new AbortController().signal);
  stage='OOM_ASSERTION';
  assertOom(oom);
  console.log('RUNNER_METRICS_ACCEPTANCE_PASSED');
}

let stage='STARTUP';
void main().catch(()=>{console.error(`RUNNER_METRICS_ACCEPTANCE_FAILED ${stage}`);process.exitCode=1;});
