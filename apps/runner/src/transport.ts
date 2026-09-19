import { spawn } from 'node:child_process';

export class DockerError extends Error {constructor(readonly code:'DOCKER_UNAVAILABLE'|'COMMAND_FAILED'|'COMMAND_TIMEOUT'|'OUTPUT_LIMIT'|'ABORTED'){super(code);}}
export interface CommandResult {stdout:Buffer;stderr:Buffer;exitCode:number}
export interface DockerTransport {
  command(args:readonly string[],options?:{input?:Buffer;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;allowFailure?:boolean}):Promise<CommandResult>;
}
export const DEFAULT_DOCKER_BINARY='/usr/bin/docker';
// Narrow environment: never inherit API/database/cloud credentials into CLI calls.
export class DockerCli implements DockerTransport {
  constructor(private readonly binary=DEFAULT_DOCKER_BINARY,private readonly socket='/var/run/docker.sock',private readonly configDir='/var/empty/arenacore-docker') {
    if(!binary.startsWith('/') || !socket.startsWith('/') || !configDir.startsWith('/')) throw new Error('ABSOLUTE_PATH_REQUIRED');
  }
  command(args:readonly string[],options:{input?:Buffer;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;allowFailure?:boolean}={}):Promise<CommandResult> {
    if(options.signal?.aborted)return Promise.reject(new DockerError('ABORTED'));
    return new Promise((resolve,reject)=>{
      const child=spawn(this.binary,[...args],{shell:false,env:{PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',DOCKER_HOST:`unix://${this.socket}`,DOCKER_CONFIG:this.configDir},stdio:['pipe','pipe','pipe']});
      const out:Buffer[]=[],err:Buffer[]=[];let bytes=0,reason:DockerError|undefined;
      const stop=(code:DockerError['code'])=>{reason??=new DockerError(code);child.kill('SIGKILL');};
      const collect=(target:Buffer[],chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(options.maxBytes??65536))stop('OUTPUT_LIMIT');else target.push(chunk);};
      child.stdout.on('data',(b:Buffer)=>collect(out,b));child.stderr.on('data',(b:Buffer)=>collect(err,b));
      child.stdin.on('error',()=>{});
      const abort=()=>stop('ABORTED');options.signal?.addEventListener('abort',abort,{once:true});
      const timer=setTimeout(()=>stop('COMMAND_TIMEOUT'),options.timeoutMs??5000);timer.unref();
      child.once('error',()=>{reason??=new DockerError('DOCKER_UNAVAILABLE');});
      child.once('close',code=>{
        clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
        const result={stdout:Buffer.concat(out),stderr:Buffer.concat(err),exitCode:code??-1};
        if(reason)reject(reason);else if(result.exitCode!==0&&!options.allowFailure)reject(new DockerError('COMMAND_FAILED'));else resolve(result);
      });
      child.stdin.end(options.input);
    });
  }
}
