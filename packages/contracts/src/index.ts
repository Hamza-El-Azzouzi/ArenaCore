import { z } from 'zod';

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024;
export const languageSchema = z.enum(['java', 'python', 'javascript']);
export const modeSchema = z.enum(['RUN', 'SUBMIT']);
export const stateSchema = z.enum(['QUEUED', 'COMPILING', 'RUNNING', 'FINISHED', 'CANCELLED', 'INTERNAL_ERROR']);
export const verdictSchema = z.enum(['ACCEPTED', 'WRONG_ANSWER', 'COMPILATION_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'CANCELLED', 'INTERNAL_ERROR']);
export const executionFailureCodeSchema = z.enum(['QUEUE_TIMEOUT', 'JOB_FAILURE', 'LEASE_EXPIRED', 'JOB_TIMEOUT', 'CANCELLATION_TIMEOUT']);
export type ExecutionFailureCode = z.infer<typeof executionFailureCodeSchema>;
export type Language = z.infer<typeof languageSchema>;
export type ExecutionMode = z.infer<typeof modeSchema>;
export type ExecutionState = z.infer<typeof stateSchema>;
export type Verdict = z.infer<typeof verdictSchema>;

// TextEncoder also works in browser clients; do not count UTF-16 code units.
export const createExecutionSchema = z.strictObject({
  problemId: z.uuid(),
  language: languageSchema,
  mode: modeSchema,
  sourceCode: z.string().min(1).refine(value => new TextEncoder().encode(value).byteLength <= MAX_SOURCE_BYTES, 'Source exceeds 64 KiB'),
});
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const uuidSchema = z.uuid();
export const paginationSchema = z.strictObject({ cursor: uuidSchema.optional() });
export const problemQuerySchema = z.strictObject({
  cursor: uuidSchema.optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  search: z.string().trim().max(100).optional(),
});
export const submissionsQuerySchema = paginationSchema.extend({ problemId: uuidSchema.optional() });
export type CreateExecution = z.infer<typeof createExecutionSchema>;

export interface ProblemSummary {
  id: string; slug: string; title: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD'; tags: string[]; successRate?: number;
}
export interface ProblemDetail extends ProblemSummary {
  statementMarkdown: string; constraints: string[];
  limits: { timeMs: number; memoryKiB: number };
  examples: { id: string; input: string; expectedOutput: string }[];
  templates: Record<Language, string>;
}
export interface PublicCaseResult {
  caseId: string; verdict: Verdict; stdout?: string; stderr?: string; exitCode?: number; runtimeMs?: number; memoryKiB?: number;
}
export interface ExecutionSnapshot {
  executionId: string; problemId: string; language: Language; mode: ExecutionMode;
  state: ExecutionState; attempt: number; lastSequence: number; verdict?: Verdict; cancellationRequested?: boolean;
  runtimeMs?: number; memoryKiB?: number; publicCaseResults?: PublicCaseResult[];
  failureCode?: ExecutionFailureCode;
}
export interface SubmissionSummary {
  executionId: string; problemId: string; problemTitle: string; language: Language; state: ExecutionState;
  verdict?: Verdict; createdAt: string; runtimeMs?: number; memoryKiB?: number;
  failureCode?: ExecutionFailureCode;
}
export interface ExecutionReceipt { executionId: string; state: ExecutionState; cancellationRequested?: boolean }

const transitions: Record<ExecutionState, readonly ExecutionState[]> = {
  QUEUED: ['COMPILING', 'CANCELLED', 'INTERNAL_ERROR'],
  COMPILING: ['RUNNING', 'FINISHED', 'CANCELLED', 'INTERNAL_ERROR'],
  RUNNING: ['FINISHED', 'CANCELLED', 'INTERNAL_ERROR'],
  FINISHED: [], CANCELLED: [], INTERNAL_ERROR: [],
};
export const activeStates = ['QUEUED', 'COMPILING', 'RUNNING'] as const;
export function isTerminal(state: ExecutionState): boolean { return transitions[state].length === 0; }
export function canTransition(from: ExecutionState, to: ExecutionState): boolean { return transitions[from].includes(to); }

// Clients acknowledge a cursor in an attempt; sequence numbers reset on recovery.
export const executionSubscriptionSchema = z.strictObject({executionId: uuidSchema, attempt: z.number().int().nonnegative(), afterSequence: z.number().int().nonnegative()});
export interface PublicExecutionEvent {
  executionId: string; attempt: number; sequence: number;
  kind: 'execution_status' | 'console_output' | 'final_verdict';
  state?: ExecutionState; verdict?: Verdict; failureCode?: ExecutionFailureCode;
  cancellationRequested?: boolean; caseId?: string; stream?: 'stdout' | 'stderr'; text?: string;
}

const eventIdentity = {executionId: uuidSchema, attempt: z.number().int().nonnegative(), sequence: z.number().int().positive()};
export const publicExecutionEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({...eventIdentity, kind: z.literal('execution_status'), state: stateSchema, cancellationRequested: z.boolean().optional()}),
  z.strictObject({...eventIdentity, kind: z.literal('console_output'), caseId: uuidSchema, stream: z.enum(['stdout', 'stderr']), text: z.string().refine(v => new TextEncoder().encode(v).byteLength <= 4096)}),
  z.strictObject({...eventIdentity, kind: z.literal('final_verdict'), state: stateSchema, verdict: verdictSchema, failureCode: executionFailureCodeSchema.optional()}),
]);
