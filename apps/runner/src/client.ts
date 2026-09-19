import { request as httpRequest } from 'node:http';
import { observationSchema } from '@arenacore/judge';
import { SandboxCleanupError } from '@arenacore/contracts';
import { CAPS, sandboxRequestSchema } from '@arenacore/runtime-policy';
import { ExecutionObservation } from './supervisor';

export class SupervisorClient {
  constructor(private readonly socketPath:string){if(!socketPath.startsWith('/'))throw new Error('INVALID_SUPERVISOR_SOCKET');}
  execute(input:unknown,signal:AbortSignal):Promise<ExecutionObservation> {
    const execution=sandboxRequestSchema.parse(input);
    if(signal.aborted)return Promise.resolve({cases:[],cancellationConfirmed:true});
    const payload=Buffer.from(JSON.stringify(execution));
    return new Promise((resolve,reject)=>{
      const req=httpRequest({socketPath:this.socketPath,path:'/execute',method:'POST',headers:{'content-type':'application/json','content-length':payload.length}},res=>{
        const chunks:Buffer[]=[];let bytes=0;
        res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2*1024*1024){req.destroy();reject(new SandboxCleanupError());}else chunks.push(chunk);});
        res.once('error',()=>reject(new SandboxCleanupError()));
        res.once('end',()=>{try{const data:unknown=JSON.parse(Buffer.concat(chunks).toString());if(res.statusCode!==200)throw new Error();resolve(observationSchema.parse(data));}catch{reject(new SandboxCleanupError());}});
      });
      // Losing RPC contact does not prove that the guest stopped. Conservative failure.
      const deadline=setTimeout(()=>req.destroy(),CAPS.totalMs+15000);deadline.unref();
      let finished=false;
      const cancel=()=>{
        const until=Date.now()+5000;
        const send=()=>{
          if(finished)return;
          const cancellation=Buffer.from(JSON.stringify({executionId:execution.executionId,attempt:execution.attempt}));
          const stop=httpRequest({socketPath:this.socketPath,path:'/cancel',method:'POST',headers:{'content-type':'application/json','content-length':cancellation.length}},response=>{
            response.resume();
            if(response.statusCode===409 && Date.now()<until && !finished)setTimeout(send,50).unref();
            else if(response.statusCode!==200 && !finished)req.destroy();
          });
          stop.once('error',()=>{if(!finished)req.destroy();});stop.setTimeout(5000,()=>stop.destroy());stop.end(cancellation);
        };
        send();
      };
      signal.addEventListener('abort',cancel,{once:true});
      req.once('close',()=>{clearTimeout(deadline);finished=true;signal.removeEventListener('abort',cancel);});
      req.once('error',()=>reject(new SandboxCleanupError()));req.setTimeout(CAPS.totalMs+15000,()=>req.destroy());req.end(payload);
    });
  }
}
