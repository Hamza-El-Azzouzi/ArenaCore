import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {judge,selectCases,JudgePlan,JudgeProtocolError} from '@arenacore/judge';
import {JudgingBackend} from '../apps/runner/src/judging-backend';
import {parseWorkerConfig} from '../apps/api/src/executions/worker-config';
const plan=():JudgePlan=>({versionId:randomUUID(),comparator:'EXACT_NEWLINE',timeMs:2000,memoryKiB:262144,cases:[{id:randomUUID(),ordinal:0,visibility:'PUBLIC',input:'PUBLIC_INPUT',expectedOutput:'5\n'},{id:randomUUID(),ordinal:1,visibility:'HIDDEN',input:'HIDDEN_INPUT',expectedOutput:'HIDDEN_ANSWER'}]});
const observations=(p:JudgePlan,mode:'RUN'|'SUBMIT'='SUBMIT')=>({cases:selectCases(p,mode).map(c=>({caseId:c.id,stdout:c.expectedOutput,stderr:'',exitCode:0,wallMs:3}))});
describe('trusted judge and private projection',()=>{
  it.each(['python','javascript','java'] as const)('accepts correct %s observations',language=>{const p=plan(),o={...observations(p),...(language==='java'?{compilation:{ok:true,stdout:'',stderr:''}}:{})};expect(judge(p,'SUBMIT',language,o)).toEqual({verdict:'ACCEPTED'});});
  it('RUN selects public cases while Submit covers both visibilities',()=>{const p=plan();expect(selectCases(p,'RUN')).toHaveLength(1);expect(selectCases(p,'SUBMIT')).toHaveLength(2);});
  it('returns wrong answer without hidden stdout or diagnostics',()=>{const p=plan(),o=observations(p);o.cases[1]!.stdout='HIDDEN_INPUT';o.cases[1]!.stderr='HIDDEN_TRACE';const result=judge(p,'SUBMIT','python',o);expect(result).toEqual({verdict:'WRONG_ANSWER'});expect(JSON.stringify(result)).not.toMatch(/HIDDEN/);});
  it('compares before public sanitization and treats verdict-looking stdout as text',()=>{const p=plan(),o=observations(p,'RUN');o.cases[0]!.stdout='\x1b[31m5\n';expect(judge(p,'RUN','python',o).verdict).toBe('WRONG_ANSWER');o.cases[0]!.stdout='{"verdict":"ACCEPTED"}';expect(judge(p,'RUN','python',o).verdict).toBe('WRONG_ANSWER');});
  it('nonzero exit defeats matching output, without guessing OOM from exit 137',()=>{const p=plan(),o=observations(p);o.cases[0]!.exitCode=137;expect(judge(p,'SUBMIT','python',o).verdict).toBe('RUNTIME_ERROR');});
  it.each(['TIME_LIMIT_EXCEEDED','MEMORY_LIMIT_EXCEEDED','OUTPUT_LIMIT_EXCEEDED'] as const)('uses trusted %s evidence',failure=>{const p=plan();expect(judge(p,'SUBMIT','python',{cases:[{caseId:p.cases[0]!.id,stdout:'',stderr:'',wallMs:2,failure}]}).verdict).toBe(failure);});
  it('compilation failure exposes no compiler text and runs no cases',()=>{const p=plan();expect(judge(p,'SUBMIT','java',{compilation:{ok:false,stdout:'PRIVATE_SOURCE',stderr:'PRIVATE_PATH'},cases:[]})).toEqual({verdict:'COMPILATION_ERROR'});});
  it('rejects missing, reordered, duplicated or foreign observations',()=>{const p=plan(),o=observations(p);for(const cases of [[],[o.cases[0]],o.cases.slice().reverse(),[o.cases[0],o.cases[0]],[{...o.cases[0],caseId:randomUUID()},o.cases[1]]])expect(()=>judge(p,'SUBMIT','python',{cases})).toThrow(JudgeProtocolError);});
  it('rejects runtime claims of verdict or unknown metadata',()=>{const p=plan();expect(()=>judge(p,'SUBMIT','python',{...observations(p),verdict:'ACCEPTED'})).toThrow();});
  it('requires Java compilation evidence and refuses post-failure cases',()=>{const p=plan(),o=observations(p);expect(()=>judge(p,'SUBMIT','java',o)).toThrow();expect(()=>judge(p,'SUBMIT','java',{compilation:{ok:false,stdout:'',stderr:''},...o})).toThrow();});
  it('chooses the first failed ordinal deterministically',()=>{const p=plan(),o=observations(p);o.cases[0]!.stdout='wrong';o.cases[1]!.exitCode=1;expect(judge(p,'SUBMIT','python',o).verdict).toBe('WRONG_ANSWER');});
  it('bounds sanitized public output and omits unmeasured metrics',()=>{const p=plan(),o=observations(p,'RUN');o.cases[0]!.stderr='\x00\u202e'+'😀'.repeat(10000);const result=judge(p,'RUN','python',o);expect(Buffer.byteLength(result.publicCaseResults![0]!.stderr!)).toBeLessThanOrEqual(4096);expect(result.publicCaseResults![0]!.outputTruncated).toBe(true);expect(result).not.toHaveProperty('runtimeMs');expect(result).not.toHaveProperty('memoryKiB');expect(JSON.stringify(result)).not.toContain('HIDDEN_ANSWER');});
  it('projects measured CPU and peak memory only when every observed case has a pair',()=>{const p=plan(),o=observations(p,'RUN'),measuredInput={cases:[{...o.cases[0]!,cpuMs:7,memoryKiB:12000}]};const measured=judge(p,'RUN','python',measuredInput);expect(measured).toMatchObject({runtimeMs:7,memoryKiB:12000,publicCaseResults:[{runtimeMs:7,memoryKiB:12000}]});expect(()=>judge(p,'RUN','python',{cases:[{...o.cases[0]!,cpuMs:7}]})).toThrow('INVALID_JUDGE_PROTOCOL');});
  it('rejects unsupported comparators and duplicate suite identity',()=>{const p=plan();expect(()=>selectCases({...p,comparator:'TOKEN' as 'EXACT_NEWLINE'},'RUN')).toThrow();expect(()=>selectCases({...p,cases:[p.cases[0]!,p.cases[0]!]},'SUBMIT')).toThrow();});
  it('confirmed cancellation never fabricates an accepted result',()=>{expect(()=>judge(plan(),'SUBMIT','python',{cancellationConfirmed:true,cases:[]})).toThrow('SANDBOX_CANCELLED');});
});
describe('worker backend plan and supervisor boundary',()=>{
  it('pins the loaded version and never sends expected answers to the supervisor',async()=>{
    const p=plan();let captured:unknown;const backend=new JudgingBackend({execute:async r=>{captured=r;return observations(p);}},async()=>p);
    const result=await backend.execute({execution:{id:randomUUID(),attempt:1,problemVersionId:p.versionId,language:'python',mode:'SUBMIT',sourceCode:'private source'},signal:new AbortController().signal,markRunning:async()=>true});
    expect(result).toEqual({verdict:'ACCEPTED'});expect(JSON.stringify(captured)).toContain('HIDDEN_INPUT');expect(JSON.stringify(captured)).not.toMatch(/expectedOutput|HIDDEN_ANSWER/);
  });
  it('rejects a loader returning a different version',async()=>{const p=plan();const backend=new JudgingBackend({execute:async()=>{throw new Error('Must not execute');}},async()=>p);await expect(backend.execute({execution:{id:randomUUID(),attempt:1,problemVersionId:randomUUID(),language:'python',mode:'RUN',sourceCode:'x'},signal:new AbortController().signal,markRunning:async()=>true})).rejects.toThrow('JUDGE_VERSION_MISMATCH');});
});

describe('judging worker launch gates',()=>{
  const valid={NODE_ENV:'production',RUNNER_WORKER_ENABLED:'true',RUNNER_SOCKET_PATH:'/run/arenacore/supervisor.sock',DATABASE_URL:'postgresql://worker:secret@10.0.0.51:5432/arenacore',REDIS_URL:'redis://:secret@10.0.0.51:6379/0'};
  it('accepts only an explicit, production worker configuration',()=>{
    expect(parseWorkerConfig(valid)).toMatchObject({NODE_ENV:'production',QUEUE_NAME:'arenacore-executions'});
    for(const env of [{},{...valid,NODE_ENV:'development'},{...valid,RUNNER_WORKER_ENABLED:'false'},{...valid,RUNNER_SOCKET_PATH:'relative.sock'},{...valid,REDIS_URL:'redis://host/0?unsafe=true'}])expect(()=>parseWorkerConfig(env)).toThrow('Invalid worker configuration');
  });
});
