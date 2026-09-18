import { describe, it, expect } from 'vitest';
import { canTransition, createExecutionSchema, isTerminal } from '@arenacore/contracts';
import { compareOutput } from '@arenacore/judge';
import { publicSnapshot } from '../apps/api/src/executions/serialization';
import { payloadHash } from '../apps/api/src/executions/executions';
import { parseConfig } from '../apps/api/src/config/config';
const input = {problemId: '00000000-0000-4000-8000-000000000001', language: 'python' as const, mode: 'RUN' as const, sourceCode: 'print(5)'};

describe('request boundaries', () => {
  it('rejects client-owned runtime/owner fields', () => {
    expect(createExecutionSchema.safeParse({...input, userId: 'attacker'}).success).toBe(false);
    expect(createExecutionSchema.safeParse({...input, image: 'privileged'}).success).toBe(false);
  });
  it('limits UTF-8 source bytes, including multibyte text', () => {
    expect(createExecutionSchema.safeParse({...input, sourceCode: 'a'.repeat(65536)}).success).toBe(true);
    expect(createExecutionSchema.safeParse({...input, sourceCode: 'é'.repeat(32769)}).success).toBe(false);
  });
  it('rejects unsupported language and empty source', () => {
    expect(createExecutionSchema.safeParse({...input, language: 'bash'}).success).toBe(false);
    expect(createExecutionSchema.safeParse({...input, sourceCode: ''}).success).toBe(false);
  });
  it('hashes payloads in a stable field order and separates Run from Submit', () => {
    expect(payloadHash({...input})).toBe(payloadHash({sourceCode: input.sourceCode, mode: input.mode, language: input.language, problemId: input.problemId}));
    expect(payloadHash(input)).not.toBe(payloadHash({...input, mode: 'SUBMIT'}));
  });
});
describe('judge comparator', () => {
  it('permits CRLF and one final newline difference', () => {
    expect(compareOutput('5\r\n', '5')).toBe(true);
    expect(compareOutput('5', '5\n')).toBe(true);
  });
  it('preserves significant whitespace and additional blank lines', () => {
    expect(compareOutput(' 5', '5')).toBe(false);
    expect(compareOutput('5 \n', '5\n')).toBe(false);
    expect(compareOutput('5\n\n', '5')).toBe(false);
  });
});
describe('lifecycle and confidentiality', () => {
  it('does not allow terminal-state regression', () => {
    for (const state of ['FINISHED', 'CANCELLED', 'INTERNAL_ERROR'] as const) {
      expect(isTerminal(state)).toBe(true);
      expect(canTransition(state, 'RUNNING')).toBe(false);
    }
    expect(canTransition('QUEUED', 'FINISHED')).toBe(false);
    expect(canTransition('RUNNING', 'FINISHED')).toBe(true);
  });
  it('removes all private results and source from Submit snapshots', () => {
    const dto = publicSnapshot({id: 'job', problemVersion: {problemId: 'problem'}, language: 'python', mode: 'SUBMIT', state: 'FINISHED', attempt: 1, lastSequence: 2, verdict: 'WRONG_ANSWER', runtimeMs: null, memoryKiB: null, failureCode: null, publicResults: [{input: 'HIDDEN_SECRET', stdout: 'HIDDEN_SECRET'}], sourceCode: 'PRIVATE_SOURCE'} as Parameters<typeof publicSnapshot>[0]);
    expect(JSON.stringify(dto)).not.toContain('HIDDEN_SECRET');
    expect(dto).not.toHaveProperty('sourceCode');
    expect(dto).not.toHaveProperty('publicCaseResults');
    expect(dto).not.toHaveProperty('runtimeMs');
  });
});
describe('deployment config', () => {
  it('requires a stable canonical quota key when job creation is enabled', () => {
    const base = {DATABASE_URL: 'postgresql://localhost/db', EXECUTIONS_ENABLED: 'true'};
    expect(() => parseConfig(base)).toThrow('EXECUTION_RATE_LIMIT_KEY');
    expect(() => parseConfig({...base, EXECUTION_RATE_LIMIT_KEY: 'PRIVATE_BAD_KEY'})).toThrow('Invalid configuration: EXECUTION_RATE_LIMIT_KEY');
    expect(parseConfig({...base, EXECUTION_RATE_LIMIT_KEY: Buffer.alloc(32, 1).toString('base64')}).QUEUE_TTL_SECONDS).toBe(120);
  });
  it('rejects unbounded capacity, invalid quota values, and unsafe queue deadlines', () => {
    const base = {DATABASE_URL: 'postgresql://localhost/db'};
    for (const [key, value] of [['MAX_ACTIVE_JOBS_GLOBAL', '0'], ['EXECUTION_CREATIONS_PER_MINUTE', '-1'],
      ['EXECUTION_IP_CREATIONS_PER_MINUTE', '1.5'], ['EXECUTION_GLOBAL_CREATIONS_PER_MINUTE', '100001'],
      ['QUEUE_TTL_SECONDS', '9'], ['QUEUE_TTL_SECONDS', '3601'], ['JOB_MAINTENANCE_INTERVAL_SECONDS', '0']]) {
      expect(() => parseConfig({...base, [key!]: value})).toThrow();
    }
  });
  it('fails closed on missing database, insecure production origin and typo switches', () => {
    expect(() => parseConfig({})).toThrow();
    expect(() => parseConfig({DATABASE_URL: 'postgresql://localhost/db', NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://app.example'})).toThrow();
    expect(() => parseConfig({DATABASE_URL: 'postgresql://localhost/db', EXECUTIONS_ENABLED: 'yes'})).toThrow();
  });
  it('does not expose configuration secrets in validation errors', () => {
    expect(() => parseConfig({DATABASE_URL: 'secret-password'})).toThrow('Invalid configuration: DATABASE_URL');
  });
});
