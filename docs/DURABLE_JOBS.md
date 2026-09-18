# Stage 4: durable jobs

Status: complete for the API/database milestone. Automated verification passed 72 tests, including 54 PostgreSQL/API/protocol checks. The new migration was checked against an existing schema; the complete five-migration history and repeatable seed were also checked on a fresh database. Dependency audit reported zero known vulnerabilities. No queue consumer or code runner exists yet.

## Accepted-job behavior

`POST /api/v1/executions` requires a live session, exact Origin, session-bound CSRF header, strict Run/Submit body, and user-scoped Idempotency-Key. New jobs return 202 with executionId and QUEUED. Matching retries return the same executionId and its current state, including a terminal state. Changing the payload while reusing a key returns 409. The availability switch is checked before retries and still returns 503 when disabled.

A new job locks its user row, checks owner concurrency, resolves the current published problem version, and obtains the shared admission advisory lock. It checks global active capacity, reserves global/IP/user creation quotas, and writes execution plus EXECUTION_CREATED outbox intent in one transaction. Any failure rolls back all new-job and quota writes. Matching retries do not reserve again.

Jobs preserve source, language, mode, owner, payload/key, version reference, creation timestamp, and queue deadline under updates. SQL enforces the contract state graph and terminal verdict/timestamp consistency, and rejects terminal rewrites. These protections do not establish current worker ownership; lease/fencing checks belong to stage 5.

## Configuration

All settings are validated in [Config](../apps/api/src/config/config.ts); the example environment includes them.

| Setting | Default | Meaning |
| --- | --- | --- |
| EXECUTIONS_ENABLED | false | Creation/retry availability switch; true is still rejected in production |
| MAX_ACTIVE_JOBS_PER_USER | 1 | QUEUED + COMPILING + RUNNING jobs per owner |
| MAX_ACTIVE_JOBS_GLOBAL | 1000 | Total unfinished jobs admitted through the API |
| EXECUTION_CREATIONS_PER_MINUTE | 10 | Committed new jobs per user in a fixed minute window |
| EXECUTION_IP_CREATIONS_PER_MINUTE | 60 | Committed new jobs per trusted client IP |
| EXECUTION_GLOBAL_CREATIONS_PER_MINUTE | 300 | Committed new jobs across API replicas |
| EXECUTION_RATE_LIMIT_KEY | unset | Canonical Base64 of 32 random bytes, required when creation is enabled |
| QUEUE_TTL_SECONDS | 120 | Persisted deadline after acceptance for leaving QUEUED |
| JOB_MAINTENANCE_INTERVAL_SECONDS | 15 | Startup sweep followed by this interval between scheduled ticks |

Generate a quota secret independently of the OIDC encryption secret:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Keep it stable and identical across replicas. Rotation changes quota identities and resets the current budget. Counts measure successful new creations, whereas login limits measure requests. Fixed windows permit bursts across boundaries; these quotas do not replace edge request throttling or measured runner capacity. Trusted proxy settings determine the client IP; direct untrusted forwarding headers cannot change it.

## Cancellation and queue expiry

Owner-authorized queued cancellation commits CANCELLED, its verdict/finish time, and one EXECUTION_CANCELLED intent. Repetition returns the existing state. A terminal job is not retroactively cancelled. With the pipeline disabled, COMPILING/RUNNING cancellation returns CANCELLATION_UNAVAILABLE. Stage 5 enables a durable active cancellation request; terminal cancellation waits for trusted backend cleanup acknowledgement. See [the pipeline protocol](STAGE_5_PIPELINE.md).

Every API instance runs bounded maintenance. It selects up to 100 overdue QUEUED rows using FOR UPDATE SKIP LOCKED, atomically records INTERNAL_ERROR + QUEUE_TIMEOUT and EXECUTION_EXPIRED intents, and removes expired creation counters. Multiple instances can sweep safely. Each instance avoids overlapping its own ticks. Large backlogs and locked rows can delay reconciliation beyond the persisted eligibility deadline.

The stage 5 worker protocol checks the deadline while claiming, refuses terminal jobs, and fences its mutations. Expiry handles queue waiting; it does not bound a running job. Maintenance failures produce only the safe JOB_MAINTENANCE_FAILED log code and retry on a later tick. Its timer stops and pending work finishes before database disconnection during Nest shutdown.

## Public reads and errors

Snapshots select explicit fields and omit source, lease secrets, and worker internals. Submit omits case results. History is owner-filtered, Submit-only, and sorts by createdAt/id with a matching composite index. Its cursor is resolved using the same owner/mode/problem filters. QUEUE_TIMEOUT is an allowlisted public code, not free-form infrastructure diagnostics.

| Code | HTTP | Meaning |
| --- | --- | --- |
| IDEMPOTENCY_CONFLICT | 409 | Key reused with different request content |
| ACTIVE_JOB_LIMIT | 429 | Owner's unfinished-job limit reached |
| EXECUTION_RATE_LIMIT | 429 | Successful new-creation quota reached |
| EXECUTION_CAPACITY | 503 | Global unfinished-job capacity reached |
| EXECUTIONS_DISABLED | 503 | Creation/retry switch is off |
| CANCELLATION_UNAVAILABLE | 503 | Active cancellation unavailable while pipeline is disabled |

Capacity and quota errors include Retry-After. An expired job is read successfully with terminal state/verdict and `failureCode: 'QUEUE_TIMEOUT'`; expiry is not an HTTP authentication or ownership error.

## Acceptance evidence and next stage

[Stage 4 integration scenarios](../tests/executions.integration.test.ts) cover independent API instances, owner/key scoping, rapid cancellation quotas, forwarded-IP spoofing, global-slot races, outbox rollback, version pinning, parallel cancellation, expiry/claim races, bounded concurrent sweeps, automatic scheduling, immutable facts, every distinct state pair, terminal consistency, history timestamp ties, and outbox integrity.

Stage 5 will dispatch durable intents, consume BullMQ jobs with lease/fencing authority, reconcile duplicate delivery/failures, and deliver authenticated bounded Socket.IO replay. The dispatcher must inspect durable job state before enqueueing work; a created intent may coexist with a later cancellation or expiry intent. Execution remains disabled for launch until isolation and trusted judging acceptance gates pass.

For the concepts, read [admission quotas](learning/61-durable-admission-and-creation-quotas.md), [advisory locks](learning/62-postgresql-advisory-locks.md), and [background maintenance](learning/63-background-maintenance-and-skip-locked.md).
