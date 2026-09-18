import { ExecutionSnapshot, Language, ExecutionMode, ExecutionState, Verdict, PublicCaseResult, ExecutionFailureCode } from '@arenacore/contracts';
import { z } from 'zod';
import { verdictSchema } from '@arenacore/contracts';

const publicResultsSchema = z.array(z.strictObject({
  caseId: z.string(), verdict: verdictSchema,
  stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().int().optional(),
  runtimeMs: z.number().nonnegative().optional(), memoryKiB: z.number().nonnegative().optional(),
}));
interface StoredExecution {
  id: string; problemVersion: {problemId: string}; language: Language; mode: ExecutionMode;
  state: ExecutionState; attempt: number; lastSequence: number; verdict: Verdict | null;
  runtimeMs: number | null; memoryKiB: number | null; publicResults: unknown;
  failureCode: ExecutionFailureCode | null;
}
export function publicSnapshot(row: StoredExecution): ExecutionSnapshot {
  const dto: ExecutionSnapshot = {
    executionId: row.id, problemId: row.problemVersion.problemId, language: row.language,
    mode: row.mode, state: row.state, attempt: row.attempt, lastSequence: row.lastSequence,
    ...(row.verdict !== null ? {verdict: row.verdict} : {}),
    ...(row.runtimeMs !== null ? {runtimeMs: row.runtimeMs} : {}),
    ...(row.memoryKiB !== null ? {memoryKiB: row.memoryKiB} : {}),
    ...(row.failureCode !== null ? {failureCode: row.failureCode} : {}),
  };
  // A defensive serialization boundary even if private data was stored accidentally.
  if (row.mode === 'RUN' && row.publicResults !== null) {
    dto.publicCaseResults = publicResultsSchema.parse(row.publicResults) as PublicCaseResult[];
  }
  return dto;
}
