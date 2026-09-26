import { z } from 'zod';
import { languageSchema, MAX_SOURCE_BYTES } from '@arenacore/contracts';

// Operator-owned manifest. No API request may select a runtime or image.
export const imageSchema=z.string().regex(/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/);
export const manifestSchema=z.strictObject({java:imageSchema,python:imageSchema,javascript:imageSchema});
export type RuntimeManifest=z.infer<typeof manifestSchema>;
export const CAPS=Object.freeze({sourceBytes:MAX_SOURCE_BYTES,outputBytes:256*1024,artifactBytes:8*1024*1024,artifactFiles:256,inputBytes:256*1024,inputFiles:16,maxCases:100,scratchBytes:32*1024*1024,pids:64,compileMs:15000,totalMs:30000,caseMs:10000,compileMemoryMiB:512,maxMemoryMiB:1024,maxFileBytes:8*1024*1024});
export const inputFileNameSchema=z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).refine(name=>!['Solution.java','Solution.class','solution.py','solution.js'].includes(name)&&!name.endsWith('.class'),'Reserved or unsafe input filename');
const inputFileSchema=z.strictObject({name:inputFileNameSchema,content:z.string().refine(v=>Buffer.byteLength(v)<=CAPS.inputBytes)});
export const sandboxRequestSchema=z.strictObject({
  executionId:z.uuid(),attempt:z.number().int().positive(),language:languageSchema,
  sourceCode:z.string().min(1).refine(v=>Buffer.byteLength(v)<=CAPS.sourceBytes),
  cases:z.array(z.strictObject({id:z.uuid(),input:z.string().refine(v=>Buffer.byteLength(v)<=CAPS.inputBytes),files:z.array(inputFileSchema).max(CAPS.inputFiles).default([])}).superRefine((test,c)=>{if(new Set(test.files.map(file=>file.name)).size!==test.files.length)c.addIssue({code:'custom',path:['files'],message:'Duplicate input filenames'});})).min(1).max(CAPS.maxCases),
  timeMs:z.number().int().min(1).max(CAPS.caseMs),memoryMiB:z.number().int().min(32).max(CAPS.maxMemoryMiB),
}).superRefine((r,c)=>{
  if(new Set(r.cases.map(t=>t.id)).size!==r.cases.length)c.addIssue({code:'custom',path:['cases'],message:'Duplicate case IDs'});
  if(r.cases.reduce((n,t)=>n+Buffer.byteLength(t.input)+t.files.reduce((m,file)=>m+Buffer.byteLength(file.content),0),0)>1024*1024)c.addIssue({code:'custom',path:['cases'],message:'Input budget exceeded'});
});
export type SandboxRequest=z.infer<typeof sandboxRequestSchema>;
export const profiles={
  java:{filename:'Solution.java',command:['/opt/java/openjdk/bin/java','-XX:ActiveProcessorCount=1','-XX:+UseSerialGC','-Xmx128m','-XX:MaxMetaspaceSize=96m','-XX:ReservedCodeCacheSize=32m','-cp','/work','Solution']},
  python:{filename:'solution.py',command:['/usr/local/bin/python3','-I','-B','/work/solution.py']},
  javascript:{filename:'solution.js',command:['/usr/local/bin/node','--max-old-space-size=128','/work/solution.js']},
} as const;
export function containerArgs(name:string,image:string,memoryMiB:number,owner:{executionId:string;attempt:number;deadline:number}) {
  if(!/^ac-[a-f0-9-]{36}$/.test(name))throw new Error('INVALID_CONTAINER_NAME');
  imageSchema.parse(image);
  if(!Number.isInteger(memoryMiB)||memoryMiB<32||memoryMiB>CAPS.maxMemoryMiB)throw new Error('INVALID_MEMORY_LIMIT');
  return ['create','--name',name,'--pull=never','--runtime=runsc','--network=none','--ipc=private','--read-only','--user=10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges:true','--pids-limit',String(CAPS.pids),'--cpus=1','--memory',`${memoryMiB}m`,'--memory-swap',`${memoryMiB}m`,'--ulimit','nofile=128:128','--ulimit',`fsize=${CAPS.maxFileBytes}:${CAPS.maxFileBytes}`,'--ulimit','core=0:0','--ulimit',`nproc=${CAPS.pids}:${CAPS.pids}`,'--tmpfs',`/work:rw,nosuid,nodev,noexec,size=${CAPS.scratchBytes},mode=1777`,'--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=8388608,mode=1777','--workdir=/work','--log-driver=none','--label','arenacore.managed=true','--label',`arenacore.execution=${owner.executionId}`,'--label',`arenacore.attempt=${owner.attempt}`,'--label',`arenacore.deadline=${owner.deadline}`,'--entrypoint=/bin/sleep',image,'infinity'];
}
