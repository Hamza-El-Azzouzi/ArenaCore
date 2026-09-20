import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { chmod, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SandboxSupervisor } from './supervisor';
import { z } from 'zod';
import { sandboxRequestSchema } from '@arenacore/runtime-policy';
import { DockerError } from './transport';
import { SandboxCleanupError } from '@arenacore/contracts';
import { METRIC_ERROR_CODES } from './metrics';

export async function listenSupervisor(supervisor:Pick<SandboxSupervisor,'execute'|'stopAccepting'|'reapExpired'>,socketPath:string) {
  if(!socketPath.startsWith('/')||socketPath.includes('\0'))throw new Error('INVALID_SUPERVISOR_SOCKET');
  const parent=await stat(dirname(socketPath));
  if(!parent.isDirectory() || (parent.mode & 0o007)!==0)throw new Error('PRIVATE_SOCKET_DIRECTORY_REQUIRED');
  let closing=false,admitted=0;const pending=new Set<Promise<void>>();const controllers=new Map<string,AbortController>();
  const reply=(res:ServerResponse,status:number,value:unknown)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}};
  async function handle(req:IncomingMessage,res:ServerResponse) {
    if(closing || admitted>=8){reply(res,503,{error:{code:'RUNNER_CAPACITY'}});return;}
    if(req.method!=='POST'||!['/execute','/cancel'].includes(req.url??'')||req.headers['content-type']!=='application/json'){reply(res,400,{error:{code:'INVALID_REQUEST'}});return;}
    admitted++;
    const abort=new AbortController();req.once('aborted',()=>abort.abort());res.once('close',()=>{if(!res.writableEnded)abort.abort();});
    let key:string|undefined;
    try {
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>2*1024*1024){reply(res,413,{error:{code:'REQUEST_TOO_LARGE'}});req.destroy();return;}chunks.push(Buffer.from(chunk));}
      const input:unknown=JSON.parse(Buffer.concat(chunks).toString());
      if(req.url==='/cancel') {
        const cancel=z.strictObject({executionId:z.uuid(),attempt:z.number().int().positive()}).parse(input);const controller=controllers.get(`${cancel.executionId}:${cancel.attempt}`);if(!controller){reply(res,409,{requested:false});return;}controller.abort();reply(res,200,{requested:true});return;
      }
      const execution=sandboxRequestSchema.parse(input);key=`${execution.executionId}:${execution.attempt}`;
      if(controllers.has(key)){reply(res,503,{error:{code:'DUPLICATE_ATTEMPT'}});key=undefined;return;}
      controllers.set(key,abort);
      const result=await supervisor.execute(execution,abort.signal);reply(res,200,{...result,...(abort.signal.aborted?{cancellationConfirmed:true}:{})});
    } catch(e) {
      if(e instanceof Error&&METRIC_ERROR_CODES.has(e.message))console.error(`RUNNER_METRICS_FAILED ${e.message}`);
      if(e instanceof DockerError && e.code==='ABORTED' && abort.signal.aborted)reply(res,200,{cases:[],cancellationConfirmed:true});
      else reply(res,503,{error:{code:e instanceof SandboxCleanupError?'SANDBOX_CLEANUP_UNCONFIRMED':'EXECUTION_UNAVAILABLE'}});
    } finally {if(key)controllers.delete(key);admitted--;}
  }
  const server=createServer((req,res)=>{const task=handle(req,res);pending.add(task);void task.finally(()=>pending.delete(task));});
  server.maxConnections=16;server.headersTimeout=5000;server.requestTimeout=5000;server.keepAliveTimeout=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});});
  try {await chmod(socketPath,0o660);} catch(e){server.close();throw e;}
  return {server,async close(){closing=true;supervisor.stopAccepting();const closed=new Promise<void>(resolve=>server.close(()=>resolve()));server.closeIdleConnections();await Promise.allSettled([...pending]);await closed;await unlink(socketPath).catch(()=>{});}};
}
