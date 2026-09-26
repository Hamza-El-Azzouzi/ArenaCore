import {z} from 'zod';
import {ExecutionMode,Language,PublicCaseResult,Verdict,languageSchema} from '@arenacore/contracts';
import {stripVTControlCharacters} from 'node:util';
export interface JudgeCase {id:string;ordinal:number;visibility:'PUBLIC'|'HIDDEN';input:string;files?:{name:string;content:string}[];expectedOutput:string}
export interface JudgePlan {versionId:string;comparator:'EXACT_NEWLINE';timeMs:number;memoryKiB:number;cases:JudgeCase[]}
const observedCaseSchema=z.strictObject({caseId:z.uuid(),stdout:z.string(),stderr:z.string(),exitCode:z.number().int().min(0).max(255).optional(),failure:z.enum(['TIME_LIMIT_EXCEEDED','MEMORY_LIMIT_EXCEEDED','OUTPUT_LIMIT_EXCEEDED']).optional(),wallMs:z.number().finite().nonnegative(),cpuMs:z.number().int().nonnegative().optional(),memoryKiB:z.number().int().nonnegative().optional()}).superRefine((value,context)=>{if((value.cpuMs===undefined)!==(value.memoryKiB===undefined))context.addIssue({code:'custom',message:'Metric pair required'});});
export const observationSchema=z.strictObject({cancellationConfirmed:z.literal(true).optional(),compilation:z.strictObject({ok:z.boolean(),stdout:z.string(),stderr:z.string()}).optional(),cases:z.array(observedCaseSchema).max(100)});
export type JudgeObservation=z.infer<typeof observationSchema>;
export type LearnerVerdict=Exclude<Verdict,'CANCELLED'|'INTERNAL_ERROR'>;
export type JudgedCaseResult=Omit<PublicCaseResult,'verdict'> & {verdict:LearnerVerdict};
export interface JudgedResult {verdict:LearnerVerdict;runtimeMs?:number;memoryKiB?:number;publicCaseResults?:JudgedCaseResult[]}
export class JudgeProtocolError extends Error {constructor(){super('INVALID_JUDGE_PROTOCOL');}}
export function selectCases(plan:JudgePlan,mode:ExecutionMode) {
  if(plan.comparator!=='EXACT_NEWLINE'||!['RUN','SUBMIT'].includes(mode)||!plan.cases.length||plan.cases.length>100||new Set(plan.cases.map(c=>c.id)).size!==plan.cases.length||new Set(plan.cases.map(c=>c.ordinal)).size!==plan.cases.length||plan.cases.some(c=>!z.uuid().safeParse(c.id).success||!Number.isInteger(c.ordinal)||c.ordinal<0||!['PUBLIC','HIDDEN'].includes(c.visibility)))throw new JudgeProtocolError();
  const cases=plan.cases.filter(c=>mode==='SUBMIT'||c.visibility==='PUBLIC').sort((a,b)=>a.ordinal-b.ordinal);
  if(!cases.length)throw new JudgeProtocolError();return cases;
}
export function compareOutput(actual:string,expected:string) {const a=actual.replace(/\r\n/g,'\n'),e=expected.replace(/\r\n/g,'\n');return a===e||a===`${e}\n`||`${a}\n`===e;}
function sanitized(text:string){return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,'');}
function display(text:string,bytes:number){let result='',size=0;for(const point of sanitized(text)){const n=Buffer.byteLength(point);if(size+n>bytes)break;result+=point;size+=n;}return result;}
export function judge(plan:JudgePlan,mode:ExecutionMode,language:Language,input:unknown):JudgedResult {
  if(!languageSchema.safeParse(language).success)throw new JudgeProtocolError();
  const cases=selectCases(plan,mode),parsed=observationSchema.safeParse(input);
  if(!parsed.success)throw new JudgeProtocolError();const observed=parsed.data;
  const outputBytes=observed.cases.reduce((n,c)=>n+Buffer.byteLength(c.stdout)+Buffer.byteLength(c.stderr),0)+(observed.compilation?Buffer.byteLength(observed.compilation.stdout)+Buffer.byteLength(observed.compilation.stderr):0);
  if(outputBytes>1024*1024)throw new JudgeProtocolError();
  if(observed.cancellationConfirmed)throw new Error('SANDBOX_CANCELLED');
  if((language==='java'&&!observed.compilation)||(language!=='java'&&observed.compilation))throw new JudgeProtocolError();
  if(observed.compilation?.ok===false){if(observed.cases.length)throw new JudgeProtocolError();return {verdict:'COMPILATION_ERROR'};}
  if(!observed.cases.length||observed.cases.length>cases.length)throw new JudgeProtocolError();
  const last=observed.cases.at(-1)!;
  if(observed.cases.length!==cases.length&&!last.failure)throw new JudgeProtocolError();
  let verdict:JudgedResult['verdict']='ACCEPTED',budget=24*1024;const publicCaseResults:JudgedCaseResult[]=[];
  observed.cases.forEach((o,i)=>{
    const test=cases[i]!;
    if(o.caseId!==test.id||(!o.failure&&o.exitCode===undefined)||(o.failure&&i!==observed.cases.length-1))throw new JudgeProtocolError();
    const current:JudgedResult['verdict']=o.failure??(o.exitCode!==0?'RUNTIME_ERROR':compareOutput(o.stdout,test.expectedOutput)?'ACCEPTED':'WRONG_ANSWER');
    if(verdict==='ACCEPTED'&&current!=='ACCEPTED')verdict=current;
    if(mode==='RUN'){
      const stdout=display(o.stdout,Math.min(4096,budget));budget-=Buffer.byteLength(stdout);const stderr=display(o.stderr,Math.min(4096,budget));budget-=Buffer.byteLength(stderr);
      const outputTruncated=Buffer.byteLength(sanitized(o.stdout))>Buffer.byteLength(stdout)||Buffer.byteLength(sanitized(o.stderr))>Buffer.byteLength(stderr);
      publicCaseResults.push({caseId:test.id,verdict:current,stdout,stderr,...(outputTruncated?{outputTruncated:true}:{}),...(o.exitCode!==undefined?{exitCode:o.exitCode}:{}),...(o.cpuMs!==undefined?{runtimeMs:o.cpuMs,memoryKiB:o.memoryKiB}:{})});
    }
  });
  const measured=observed.cases.every(c=>c.cpuMs!==undefined&&c.memoryKiB!==undefined);
  return {verdict,...(measured?{runtimeMs:Math.max(...observed.cases.map(c=>c.cpuMs!)),memoryKiB:Math.max(...observed.cases.map(c=>c.memoryKiB!))}:{}),...(mode==='RUN'?{publicCaseResults}:{})};
}
