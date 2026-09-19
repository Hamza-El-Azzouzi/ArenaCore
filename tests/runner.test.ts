import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as tar from 'tar-stream';
import { CAPS,containerArgs,manifestSchema,sandboxRequestSchema } from '@arenacore/runtime-policy';
import { SandboxCleanupError } from '@arenacore/contracts';
import { DEFAULT_DOCKER_BINARY,DockerCli,DockerError,DockerTransport,CommandResult } from '../apps/runner/src/transport';
import { SandboxSupervisor } from '../apps/runner/src/supervisor';
import { normalizeJavaArtifacts,packFiles } from '../apps/runner/src/artifacts';
const manifest={java:`registry.example/java@sha256:${'a'.repeat(64)}`,python:`registry.example/python@sha256:${'b'.repeat(64)}`,javascript:`registry.example/node@sha256:${'c'.repeat(64)}`};
const request=()=>({executionId:randomUUID(),attempt:1,language:'python' as const,sourceCode:'print(5)',cases:[{id:randomUUID(),input:'2 3\n'}],timeMs:100,memoryMiB:128});
const result=(stdout='',exitCode=0):CommandResult=>({stdout:Buffer.from(stdout),stderr:Buffer.alloc(0),exitCode});
class Engine implements DockerTransport {
  calls:string[][]=[];containers=new Map<string,readonly string[]>();missingRuntime=false;unsafe=false;cleanupFails=false;execError?:DockerError;artifact?:Buffer;onExec?:()=>void;
  async command(args:readonly string[]):Promise<CommandResult> {
    this.calls.push([...args]);
    if(args[0]==='info')return result(JSON.stringify({OSType:'linux',CgroupVersion:'2',CgroupDriver:'systemd',Runtimes:this.missingRuntime?{}:{runsc:{}},SecurityOptions:['name=seccomp,profile=builtin'],MemoryLimit:true,PidsLimit:true,CPUCfsQuota:true}));
    if(args[0]==='image')return result(JSON.stringify({RepoDigests:[args[2]],Config:{User:'10001:10001',Env:['PATH=/usr/bin:/bin']}}));
    if(args[0]==='create'){this.containers.set(args[2]!,args);return result('id');}
    if(args[0]==='inspect'){
      if(args.at(-1)==='{{json .Config.Labels}}')return result(JSON.stringify({'arenacore.deadline':'1'}));
      const options=this.containers.get(args[1]!)!;const memory=Number(options[options.indexOf('--memory')+1]!.slice(0,-1))*1024*1024;
      return result(JSON.stringify({Config:{User:'10001:10001'},Mounts:[],HostConfig:{Runtime:this.unsafe?'runc':'runsc',NetworkMode:'none',ReadonlyRootfs:true,Privileged:false,Memory:memory,MemorySwap:memory,NanoCpus:1e9,PidsLimit:64,CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],Binds:null}}));
    }
    if(args[0]==='rm'){if(!this.cleanupFails)this.containers.delete(args.at(-1)!);return result();}
    if(args[0]==='ps')return result([...this.containers.keys()].join('\n'));
    if(args[0]==='exec'){this.onExec?.();if(this.execError)throw this.execError;return result('5\n');}
    if(args[0]==='cp'&&args.at(-1)==='-')return {stdout:this.artifact!,stderr:Buffer.alloc(0),exitCode:0};
    return result();
  }
}
async function ready(engine=new Engine()){const supervisor=new SandboxSupervisor(engine,manifest);await supervisor.preflight();return {engine,supervisor};}
describe('isolated runner policy and supervisor failure boundaries',()=>{
  it('rejects mutable image tags and request-controlled runtime fields',()=>{expect(()=>manifestSchema.parse({...manifest,python:'python:latest'})).toThrow();expect(()=>sandboxRequestSchema.parse({...request(),image:manifest.java})).toThrow();});
  it('rejects oversized UTF-8 source, case input and duplicate cases',()=>{expect(()=>sandboxRequestSchema.parse({...request(),sourceCode:'😀'.repeat(CAPS.sourceBytes)})).toThrow();const r=request();expect(()=>sandboxRequestSchema.parse({...r,cases:[r.cases[0],r.cases[0]]})).toThrow();expect(()=>sandboxRequestSchema.parse({...r,cases:[{id:randomUUID(),input:'x'.repeat(CAPS.inputBytes+1)}]})).toThrow();});
  it('refuses work before preflight and rejects missing gVisor',async()=>{const e=new Engine();const s=new SandboxSupervisor(e,manifest);await expect(s.execute(request(),new AbortController().signal)).rejects.toThrow('RUNNER_NOT_READY');e.missingRuntime=true;await expect(s.preflight()).rejects.toThrow('ISOLATION_UNAVAILABLE');expect(e.calls.some(a=>a[0]==='create')).toBe(false);});
  it('requests every required Docker capability through explicit template fields',async()=>{const {engine}=await ready();const call=engine.calls.find(a=>a[0]==='info')!;expect(call[1]).toBe('--format');expect(call[2]).toContain('{{json .CPUCfsQuota}}');expect(call[2]).toContain('{{json .PidsLimit}}');expect(call[2]).not.toContain('{{json .}}');});
  it('uses fresh containers per case and destroys them before returning',async()=>{const {engine,supervisor}=await ready();const r=request();r.cases.push({id:randomUUID(),input:'3 2\n'});const observation=await supervisor.execute(r,new AbortController().signal);expect(observation.cases).toHaveLength(2);const names=engine.calls.filter(a=>a[0]==='create').map(a=>a[2]);expect(new Set(names).size).toBe(2);expect(engine.containers.size).toBe(0);expect(engine.calls.at(-1)![0]).toBe('ps');});
  it('rejects policy drift before copying source or starting a program',async()=>{const {engine,supervisor}=await ready();engine.unsafe=true;await expect(supervisor.execute(request(),new AbortController().signal)).rejects.toThrow();expect(engine.calls.some(a=>a[0]==='cp'||a[0]==='exec')).toBe(false);expect(engine.containers.size).toBe(0);});
  it.each([['COMMAND_TIMEOUT','TIME_LIMIT_EXCEEDED'],['OUTPUT_LIMIT','OUTPUT_LIMIT_EXCEEDED']] as const)('cleans resources after %s and returns bounded failure',async(code,failure)=>{const {engine,supervisor}=await ready();engine.execError=new DockerError(code);const observation=await supervisor.execute(request(),new AbortController().signal);expect(observation.cases[0]!.failure).toBe(failure);expect(engine.containers.size).toBe(0);});
  it('does not acknowledge cleanup when removal cannot be verified',async()=>{const {engine,supervisor}=await ready();engine.cleanupFails=true;await expect(supervisor.execute(request(),new AbortController().signal)).rejects.toBeInstanceOf(SandboxCleanupError);await expect(supervisor.execute(request(),new AbortController().signal)).rejects.toThrow('RUNNER_NOT_READY');});
  it('creates no resources for an already cancelled request',async()=>{const {engine,supervisor}=await ready();const abort=new AbortController();abort.abort();await expect(supervisor.execute(request(),abort.signal)).rejects.toThrow('ABORTED');expect(engine.calls.some(a=>a[0]==='create')).toBe(false);});
  it('cleans after abort during command execution',async()=>{const {engine,supervisor}=await ready();const abort=new AbortController();engine.onExec=()=>abort.abort();engine.execError=new DockerError('ABORTED');await expect(supervisor.execute(request(),abort.signal)).rejects.toThrow('ABORTED');expect(engine.containers.size).toBe(0);});
  it('rejects intake once shutdown starts',async()=>{const {supervisor}=await ready();supervisor.stopAccepting();await expect(supervisor.execute(request(),new AbortController().signal)).rejects.toThrow('RUNNER_NOT_READY');});
  it('generates hardened policies without source in command arguments',()=>{const r=request();const args=containerArgs(`ac-${randomUUID()}`,manifest.python,128,{executionId:r.executionId,attempt:1,deadline:Date.now()+30000});expect(args).toContain('--runtime=runsc');expect(args).toContain('--network=none');expect(args).toContain('--pull=never');expect(args.join(' ')).not.toContain(r.sourceCode);expect(args.some(a=>a.startsWith('--volume')||a.startsWith('--privileged'))).toBe(false);});
  it('uses Ubuntu Docker path and rejects unsafe transport paths',()=>{expect(DEFAULT_DOCKER_BINARY).toBe('/usr/bin/docker');expect(()=>new DockerCli('docker')).toThrow();});
});
async function archive(name:string,type:'file'|'symlink',linkname?:string) {
  const pack=tar.pack();const chunks:Buffer[]=[];const done=new Promise<Buffer>((resolve,reject)=>{pack.on('data',(b:Buffer)=>chunks.push(b));pack.on('end',()=>resolve(Buffer.concat(chunks)));pack.on('error',reject);});pack.entry({name,type,linkname},type==='file'?Buffer.from('class'):undefined);pack.finalize();return done;
}
describe('compiler artifact transfer',()=>{
  it('normalizes only bounded class files and requires the fixed entrypoint',async()=>{const bytes=await packFiles([{name:'Solution.class',data:Buffer.from('class')},{name:'pkg/Helper.class',data:Buffer.from('helper')}]);expect((await normalizeJavaArtifacts(bytes)).length).toBeGreaterThan(0);await expect(normalizeJavaArtifacts(await packFiles([{name:'Helper.class',data:Buffer.from('class')}]))).rejects.toThrow('MISSING_ENTRYPOINT');});
  it.each(['../Solution.class','/Solution.class','Solution.java','pkg/../../Solution.class'])('rejects artifact name %s',async name=>{await expect(normalizeJavaArtifacts(await archive(name,'file'))).rejects.toThrow();});
  it('rejects links and oversize archives without host extraction',async()=>{await expect(normalizeJavaArtifacts(await archive('Solution.class','symlink','/etc/passwd'))).rejects.toThrow();await expect(normalizeJavaArtifacts(Buffer.alloc(CAPS.artifactBytes+1))).rejects.toThrow('ARTIFACT_LIMIT');});
});
