import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {SandboxCleanupError} from '@arenacore/contracts';
import {SandboxSupervisor} from '../apps/runner/src/supervisor';
import {listenSupervisor} from '../apps/runner/src/server';
import {SupervisorClient} from '../apps/runner/src/client';
const suite=process.env.TEST_RUNNER_RPC==='true'?describe:describe.skip;
suite('private supervisor Unix socket protocol',()=>{
  let directory:string,path:string,host:Awaited<ReturnType<typeof listenSupervisor>>,client:SupervisorClient;
  let failing=false,block=false,aborted=false;
  const supervisor:Pick<SandboxSupervisor,'execute'|'stopAccepting'|'reapExpired'>={
    execute:async(_input,signal)=>{if(failing)throw new SandboxCleanupError();if(block)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));return {cases:[]};},stopAccepting:()=>{},reapExpired:async()=>{},
  };
  const input=()=>({executionId:randomUUID(),attempt:1,language:'python',sourceCode:'print(5)',cases:[{id:randomUUID(),input:''}],timeMs:100,memoryMiB:128});
  beforeAll(async()=>{directory=await mkdtemp(join(tmpdir(),'ac-rpc-'));path=join(directory,'supervisor.sock');host=await listenSupervisor(supervisor,path);client=new SupervisorClient(path);});
  afterAll(async()=>{await host?.close();await rm(directory,{recursive:true,force:true});});
  it('restricts socket filesystem permissions and exchanges validated observations',async()=>{expect((await stat(path)).mode&0o777).toBe(0o660);expect(await client.execute(input(),new AbortController().signal)).toEqual({cases:[]});});
  it('rejects request-controlled expected answers before making RPC',()=>{expect(()=>client.execute({...input(),expectedOutput:'SECRET'},new AbortController().signal)).toThrow();});
  it('preserves cleanup uncertainty across the private channel',async()=>{failing=true;await expect(client.execute(input(),new AbortController().signal)).rejects.toBeInstanceOf(SandboxCleanupError);failing=false;});
  it('requests cancellation while awaiting cleanup acknowledgement',async()=>{block=true;const abort=new AbortController();const call=client.execute(input(),abort.signal);setTimeout(()=>abort.abort(),1);expect((await call).cancellationConfirmed).toBe(true);const end=Date.now()+3000;while(!aborted&&Date.now()<end)await new Promise(r=>setTimeout(r,20));expect(aborted).toBe(true);block=false;});
});
