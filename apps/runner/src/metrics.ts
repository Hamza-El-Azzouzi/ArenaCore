import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { DockerTransport } from './transport';

export interface CgroupSnapshot {path:string;cpuUsec:number;memoryPeakBytes:number;oomKills:number}
export interface MetricsReader {snapshot(container:string):Promise<CgroupSnapshot>}
export const METRIC_ERROR_CODES=new Set(['INVALID_CGROUP_PID','INVALID_CGROUP_COUNTER','UNIFIED_CGROUP_REQUIRED','SCOPED_CGROUP_REQUIRED','INVALID_CGROUP_PATH','INVALID_CGROUP_COUNTERS','CGROUP_FILES_UNAVAILABLE','CGROUP_METRICS_MISSING','INVALID_CGROUP_MEMORY_PEAK','CGROUP_IDENTITY_CHANGED','CGROUP_COUNTER_REGRESSION']);

function integer(value:string,name:string) {
  if(!/^[0-9]+$/.test(value))throw new Error(`INVALID_CGROUP_${name}`);
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed))throw new Error(`INVALID_CGROUP_${name}`);
  return parsed;
}

export function unifiedCgroupPath(value:string) {
  const matches=value.trim().split('\n').filter(line=>line.startsWith('0::'));
  if(matches.length!==1)throw new Error('UNIFIED_CGROUP_REQUIRED');
  const path=matches[0]!.slice(3);
  if(!path.startsWith('/')||path==='/'||path.includes('\0'))throw new Error('SCOPED_CGROUP_REQUIRED');
  return path;
}

export function keyedCounters(value:string) {
  const result=new Map<string,number>();
  for(const line of value.trim().split('\n')) {
    const match=/^([a-z0-9_.-]+) ([0-9]+)$/.exec(line);
    if(!match||result.has(match[1]!))throw new Error('INVALID_CGROUP_COUNTERS');
    result.set(match[1]!,integer(match[2]!,'COUNTER'));
  }
  return result;
}

export class CgroupV2Metrics implements MetricsReader {
  constructor(private readonly docker:DockerTransport,private readonly root='/sys/fs/cgroup',private readonly proc='/proc'){}
  async snapshot(container:string):Promise<CgroupSnapshot> {
    if(!/^ac-[a-f0-9-]{36}$/.test(container))throw new Error('INVALID_CONTAINER_NAME');
    const pidResult=await this.docker.command(['inspect',container,'--format','{{.State.Pid}}']);
    const pid=integer(pidResult.stdout.toString().trim(),'PID');
    if(pid<2)throw new Error('INVALID_CGROUP_PID');
    let membership:string;
    try {membership=await readFile(`${this.proc}/${pid}/cgroup`,'utf8');} catch {throw new Error('CGROUP_FILES_UNAVAILABLE');}
    const relative=unifiedCgroupPath(membership);
    const directory=resolve(this.root,`.${relative}`),root=resolve(this.root);
    if(!directory.startsWith(`${root}${sep}`))throw new Error('INVALID_CGROUP_PATH');
    let cpuText:string,peakText:string,eventText:string;
    try {
      [cpuText,peakText,eventText]=await Promise.all([
        readFile(`${directory}/cpu.stat`,'utf8'),
        readFile(`${directory}/memory.peak`,'utf8'),
        readFile(`${directory}/memory.events`,'utf8'),
      ]);
    } catch {throw new Error('CGROUP_FILES_UNAVAILABLE');}
    const cpu=keyedCounters(cpuText),events=keyedCounters(eventText);
    const cpuUsec=cpu.get('usage_usec'),oomKills=events.get('oom_kill');
    if(cpuUsec===undefined||oomKills===undefined)throw new Error('CGROUP_METRICS_MISSING');
    return {path:relative,cpuUsec,memoryPeakBytes:integer(peakText.trim(),'MEMORY_PEAK'),oomKills};
  }
}

export function metricDelta(before:CgroupSnapshot,after:CgroupSnapshot) {
  if(after.path!==before.path)throw new Error('CGROUP_IDENTITY_CHANGED');
  if(after.cpuUsec<before.cpuUsec||after.memoryPeakBytes<before.memoryPeakBytes||after.oomKills<before.oomKills)throw new Error('CGROUP_COUNTER_REGRESSION');
  return {cpuMs:Math.ceil((after.cpuUsec-before.cpuUsec)/1000),memoryKiB:Math.ceil(after.memoryPeakBytes/1024),oomKilled:after.oomKills>before.oomKills};
}
