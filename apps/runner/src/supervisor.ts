import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CAPS, containerArgs, manifestSchema, profiles, RuntimeManifest, SandboxRequest, sandboxRequestSchema } from '@arenacore/runtime-policy';
import { SandboxCleanupError } from '@arenacore/contracts';
import { DockerError, DockerTransport } from './transport';
import { normalizeJavaArtifacts, packFiles } from './artifacts';
import { CgroupV2Metrics, metricDelta, MetricsReader } from './metrics';

export interface CaseObservation {caseId:string;stdout:string;stderr:string;exitCode?:number;failure?:'TIME_LIMIT_EXCEEDED'|'MEMORY_LIMIT_EXCEEDED'|'OUTPUT_LIMIT_EXCEEDED';wallMs:number;cpuMs?:number;memoryKiB?:number}
export interface ExecutionObservation {cancellationConfirmed?:true;compilation?:{ok:boolean;stdout:string;stderr:string};cases:CaseObservation[]}
const infoSchema=z.object({OSType:z.literal('linux'),CgroupVersion:z.literal('2'),CgroupDriver:z.enum(['systemd','cgroupfs']),Runtimes:z.record(z.string(),z.unknown()),SecurityOptions:z.array(z.string()),MemoryLimit:z.literal(true),PidsLimit:z.literal(true),CPUCfsQuota:z.literal(true)});
// Docker's `{{json .}}` output is not a stable API: Docker 29 omits the
// CPUCfsQuota property even though the named template field is available.
// Construct the bounded capability record explicitly so every required gate is
// represented and validated.
const dockerInfoFormat='{"OSType":{{json .OSType}},"CgroupVersion":{{json .CgroupVersion}},"CgroupDriver":{{json .CgroupDriver}},"Runtimes":{{json .Runtimes}},"SecurityOptions":{{json .SecurityOptions}},"MemoryLimit":{{json .MemoryLimit}},"PidsLimit":{{json .PidsLimit}},"CPUCfsQuota":{{json .CPUCfsQuota}}}';
export class SandboxSupervisor {
  private manifest:RuntimeManifest;private ready=false;private readonly active=new Map<string,AbortController>();private shuttingDown=false;
  private readonly metrics:MetricsReader;
  constructor(private readonly docker:DockerTransport,manifest:unknown,metrics?:MetricsReader){this.manifest=manifestSchema.parse(manifest);this.metrics=metrics??new CgroupV2Metrics(docker);}
  async preflight() {
    this.ready=false;
    const info=infoSchema.parse(JSON.parse((await this.docker.command(['info','--format',dockerInfoFormat])).stdout.toString()));
    if(!('runsc' in info.Runtimes)||!info.SecurityOptions.some(v=>v.includes('seccomp')))throw new Error('ISOLATION_UNAVAILABLE');
    for(const image of Object.values(this.manifest)) {
      const result=await this.docker.command(['image','inspect',image,'--format','{{json .}}']);
      const data=z.object({RepoDigests:z.array(z.string()),Config:z.object({User:z.literal('10001:10001'),Env:z.array(z.string()).nullable()})}).parse(JSON.parse(result.stdout.toString()));
      if(!data.RepoDigests.includes(image) || (data.Config.Env??[]).some(v=>!/^(PATH|LANG|LANGUAGE|LC_ALL|JAVA_HOME|JAVA_VERSION|NODE_VERSION|YARN_VERSION|PYTHON_VERSION|PYTHON_SHA256|GPG_KEY)=/.test(v)))throw new Error('UNTRUSTED_RUNTIME_IMAGE');
    }
    this.ready=true;
  }
  private async destroy(name:string) {
    // Independently verify absence: CLI success alone is not a cleanup acknowledgement.
    await this.docker.command(['rm','--force',name],{allowFailure:true});
    const result=await this.docker.command(['ps','--all','--quiet','--filter',`name=^/${name}$`]);
    if(result.stdout.toString().trim())throw new SandboxCleanupError();
  }
  private async sandbox(request:SandboxRequest,phase:string,archive:Buffer,signal:AbortSignal,deadline:number,body:(name:string)=>Promise<void>) {
    const name=`ac-${randomUUID()}`;
    try {
      if(signal.aborted)throw new DockerError('ABORTED');
      await this.docker.command(containerArgs(name,this.manifest[request.language],phase==='compile'?CAPS.compileMemoryMiB:request.memoryMiB,{executionId:request.executionId,attempt:request.attempt,deadline}),{signal});
      if(signal.aborted)throw new DockerError('ABORTED');
      await this.verifyContainer(name,phase==='compile'?CAPS.compileMemoryMiB:request.memoryMiB);
      await this.docker.command(['start',name],{signal});
      // Docker refuses `docker cp` into a read-only container even when the
      // destination is a writable tmpfs. Extract the trusted, normalized
      // archive as the nonroot guest instead; source bytes remain on stdin and
      // never enter argv, an image layer, or the host filesystem.
      await this.docker.command(['exec','--interactive',name,'/bin/tar','-x','-f','-','-C','/work'],{input:archive,signal});
      await body(name);
    } finally {
      try {await this.destroy(name);} catch {this.ready=false;throw new SandboxCleanupError();}
    }
  }
  private async verifyContainer(name:string,memoryMiB:number) {
    const result=await this.docker.command(['inspect',name,'--format','{{json .}}']);
    const data=z.object({Config:z.object({User:z.literal('10001:10001')}),Mounts:z.array(z.unknown()).max(0),HostConfig:z.object({Runtime:z.literal('runsc'),NetworkMode:z.literal('none'),ReadonlyRootfs:z.literal(true),Privileged:z.literal(false),Memory:z.literal(memoryMiB*1024*1024),MemorySwap:z.literal(memoryMiB*1024*1024),NanoCpus:z.literal(1000000000),PidsLimit:z.literal(CAPS.pids),CapDrop:z.array(z.string()),SecurityOpt:z.array(z.string()),Binds:z.null(),Ulimits:z.array(z.object({Name:z.string(),Hard:z.number(),Soft:z.number()}))})}).parse(JSON.parse(result.stdout.toString()));
    const nproc=data.HostConfig.Ulimits.find(v=>v.Name==='nproc');
    if(!data.HostConfig.CapDrop.includes('ALL') || !data.HostConfig.SecurityOpt.some(v=>v.startsWith('no-new-privileges')) || nproc?.Hard!==CAPS.pids || nproc.Soft!==CAPS.pids)throw new Error('SANDBOX_POLICY_MISMATCH');
  }
  private async terminalOom(name:string) {
    const result=await this.docker.command(['inspect',name,'--format','{{json .State}}']);
    const parsed=z.object({OOMKilled:z.boolean(),Running:z.boolean(),Pid:z.number().int().nonnegative()}).safeParse(JSON.parse(result.stdout.toString()));
    return parsed.success&&parsed.data.OOMKilled&&!parsed.data.Running&&parsed.data.Pid===0;
  }
  async execute(input:unknown,signal:AbortSignal):Promise<ExecutionObservation> {
    const request=sandboxRequestSchema.parse(input);
    if(!this.ready || this.shuttingDown)throw new Error('RUNNER_NOT_READY');
    if(this.active.size>=2)throw new Error('RUNNER_CAPACITY');
    const key=`${request.executionId}:${request.attempt}`;
    if(this.active.has(key))throw new Error('DUPLICATE_ATTEMPT');
    const abort=new AbortController();const forward=()=>abort.abort();signal.addEventListener('abort',forward,{once:true});if(signal.aborted)abort.abort();this.active.set(key,abort);
    const deadline=Date.now()+CAPS.totalMs;const timer=setTimeout(()=>abort.abort(),CAPS.totalMs);timer.unref();
    const observation:ExecutionObservation={cases:[]};let budget=CAPS.outputBytes;
    try {
      let archive=await packFiles([{name:profiles[request.language].filename,data:Buffer.from(request.sourceCode)}]);
      if(request.language==='java') {
        await this.sandbox(request,'compile',archive,abort.signal,deadline,async name=>{
          await this.docker.command(['exec',name,'/bin/mkdir','/work/classes'],{signal:abort.signal});
          const result=await this.docker.command(['exec',name,'/opt/java/openjdk/bin/javac','-J-Xmx256m','-proc:none','-encoding','UTF-8','-d','/work/classes','/work/Solution.java'],{signal:abort.signal,timeoutMs:Math.min(CAPS.compileMs,deadline-Date.now()),maxBytes:budget,allowFailure:true});
          budget-=result.stdout.length+result.stderr.length;observation.compilation={ok:result.exitCode===0,stdout:result.stdout.toString(),stderr:result.stderr.toString()};
          if(result.exitCode===0)archive=await normalizeJavaArtifacts((await this.docker.command(['exec',name,'/bin/tar','-c','-f','-','-C','/work/classes','.'],{signal:abort.signal,maxBytes:CAPS.artifactBytes})).stdout);
        });
        if(!observation.compilation?.ok)return observation;
      }
      for(const test of request.cases) {
        if(abort.signal.aborted)throw new DockerError('ABORTED');
        if(budget<=0){observation.cases.push({caseId:test.id,stdout:'',stderr:'',failure:'OUTPUT_LIMIT_EXCEEDED',wallMs:0});break;}
        await this.sandbox(request,'run',archive,abort.signal,deadline,async name=>{
          const started=Date.now();
          try {
            const before=await this.metrics.snapshot(name);
            const result=await this.docker.command(['exec','--interactive',name,...profiles[request.language].command],{input:Buffer.from(test.input),signal:abort.signal,timeoutMs:Math.max(1,Math.min(request.timeMs,deadline-Date.now())),maxBytes:budget,allowFailure:true});
            budget-=result.stdout.length+result.stderr.length;
            let measured;
            try {measured=metricDelta(before,await this.metrics.snapshot(name));}
            catch(e) {
              if(await this.terminalOom(name)){observation.cases.push({caseId:test.id,stdout:result.stdout.toString(),stderr:result.stderr.toString(),exitCode:result.exitCode,wallMs:Date.now()-started,failure:'MEMORY_LIMIT_EXCEEDED'});return;}
              throw e;
            }
            observation.cases.push({caseId:test.id,stdout:result.stdout.toString(),stderr:result.stderr.toString(),exitCode:result.exitCode,wallMs:Date.now()-started,cpuMs:measured.cpuMs,memoryKiB:measured.memoryKiB,...(measured.oomKilled?{failure:'MEMORY_LIMIT_EXCEEDED' as const}:{})});
          } catch(e) {
            if(e instanceof DockerError && (e.code==='COMMAND_TIMEOUT'||e.code==='OUTPUT_LIMIT')) {observation.cases.push({caseId:test.id,stdout:'',stderr:'',failure:e.code==='COMMAND_TIMEOUT'?'TIME_LIMIT_EXCEEDED':'OUTPUT_LIMIT_EXCEEDED',wallMs:Date.now()-started});budget=e.code==='OUTPUT_LIMIT'?0:budget;}
            else throw e;
          }
        });
        if(observation.cases.at(-1)?.failure)break;
      }
      return observation;
    } finally {clearTimeout(timer);signal.removeEventListener('abort',forward);this.active.delete(key);}
  }
  async reapExpired(now=Date.now()) {
    const result=await this.docker.command(['ps','--all','--quiet','--filter','label=arenacore.managed=true']);
    for(const id of result.stdout.toString().trim().split('\n').filter(Boolean).slice(0,100)) {
      if(!/^[a-f0-9]{12,64}$/.test(id))throw new Error('INVALID_CONTAINER_ID');
      const detail=await this.docker.command(['inspect',id,'--format','{{json .Config.Labels}}']);
      const labels=z.record(z.string(),z.string()).parse(JSON.parse(detail.stdout.toString()));
      const deadline=Number(labels['arenacore.deadline']);
      if(!Number.isSafeInteger(deadline)||deadline<=now) {await this.docker.command(['rm','--force',id]);const remaining=await this.docker.command(['ps','--all','--quiet','--filter',`id=${id}`]);if(remaining.stdout.toString().trim()){this.ready=false;throw new SandboxCleanupError();}}
    }
  }
  stopAccepting(){this.shuttingDown=true;for(const abort of this.active.values())abort.abort();}
}
