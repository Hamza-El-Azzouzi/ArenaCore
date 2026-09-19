# Stage 5: durable dispatch and authenticated public updates

The API accepts a job by committing its immutable request, a queued public event, and an outbox intent in one PostgreSQL transaction. BullMQ carries only `{executionId}`. PostgreSQL owns attempts, leases, results, cancellation requests, and bounded public replay. A lost Redis queue can be reconstructed from the durable intents while jobs remain eligible.

## Enable components deliberately

```dotenv
EXECUTIONS_ENABLED=false
PIPELINE_ENABLED=false
REALTIME_ENABLED=false
REDIS_URL=redis://127.0.0.1:6379/0
QUEUE_NAME=arenacore-executions
```

`PIPELINE_ENABLED=true` enables dispatch/reconciliation, and requires a Redis URL. `REALTIME_ENABLED=true` enables the `/executions` Socket.IO namespace on `/socket.io`, using WebSocket transport only. Either component can be enabled independently. Neither starts an execution backend. New execution creation stays disabled by default, and production creation is still rejected by configuration. During development, creation requires the existing execution quota key.

Local infrastructure is in `infra/compose.dev.yml`. Redis uses a volume, AOF, a 256 MiB limit and `noeviction`; random key eviction would corrupt queue coordination. Redis is a trusted internal service: use ACL credentials and TLS across network boundaries; do not expose its port publicly. The local Compose port binds only to loopback. Test suites use an isolated random queue name and never flush a shared Redis database.

## Dispatcher and recovery

`queue.ts` claims at most 20 pending outbox rows using `FOR UPDATE SKIP LOCKED`, with a UUID dispatch token and 10-second claim lease. It commits the claim before network I/O. A successful queue add is acknowledged only while that token still owns an unexpired claim. Failure leaves the intent pending with exponential backoff capped at 30 seconds. Redis errors are not returned to the browser or logged with connection credentials.

Queue job IDs are `exec-<executionId>-g<generation>`. Repeating a dispatch uses the same ID. BullMQ retains completed/failed IDs for at most a day and at most 10,000 jobs per category. Deduplication is an optimization: the worker must still claim database authority.

Maintenance reoffers published queued intents older than 10 seconds. An existing queue ID deduplicates the offer; after queue data loss, the offer recreates it. Expired worker leases get one recovery intent per attempt, also reoffered if necessary. Recovery uses a new queue generation so an old BullMQ lock cannot block the new database attempt. Reconciliation examines bounded batches; large backlogs need multiple ticks.

## Worker integration boundary

`startExecutionWorker(jobStore, redisUrl, queueName, backend)` creates a BullMQ worker with concurrency two. The backend is an explicit trusted adapter; there is no default adapter that executes source on the API host. Stage 6 must supply the isolated runner and separate runtime credentials/host.

The backend receives an immutable execution, an `AbortSignal`, `markRunning()`, and a console writer. **Normal promise settlement requires every process belonging to that attempt to have stopped.** Stage 6 introduces `SandboxCleanupError` for unconfirmed cleanup; the wrapper treats it as infrastructure failure, never successful cancellation. This is a contract for the future supervisor, not proof that a sandbox exists today. Integration tests supply a fixture adapter which returns static results and never executes submitted code.

Claims use a 30-second PostgreSQL lease, UUID token, and increasing attempt. Heartbeats run every second. Every worker mutation checks the attempt, token, active state, database-clock lease expiry, and overall deadline under the same row lock as its update. Three abandoned attempts become `INTERNAL_ERROR/LEASE_EXPIRED`. The overall deadline is the immutable queued deadline plus ten minutes; renewals cannot extend it.

A cancellation of queued work is immediately terminal. A cancellation of active work is a durable request when the pipeline is enabled. The worker observes it on heartbeat and aborts its backend. The API still reports the active state with `cancellationRequested:true` until the adapter confirms cleanup. Expired authority or an unacknowledged request becomes an infrastructure failure, including `CANCELLATION_TIMEOUT`; it does not claim that the sandbox safely stopped. Stage 6 needs an external supervisor/cleanup mechanism for hung or crashed adapters.

## Browser protocol

Connect with the normal session cookie from the exact `PUBLIC_ORIGIN`. Missing/foreign Origins and invalid sessions are rejected. Browser session cookies can use a same-origin reverse proxy or an HTTPS `API_ORIGIN` subdomain under the frontend's registrable domain. Handshake authentication does not grant lasting access: subscriptions and background delivery recheck the database session, including expiry/revocation.

```ts
const socket = io('/executions', {transports: ['websocket']});
const ack = await socket.emitWithAck('subscribe_execution', {
  executionId, attempt: knownAttempt, afterSequence: knownSequence,
});
```

Acknowledgements are `{ok:true,snapshot,replayAvailable,events}` or `{ok:false,error:{code}}`. Subscription ownership is checked on the server. Unknown fields are rejected; supplied user IDs never authorize access. Apply replay in sequence order, then listen for `execution_status`, `console_output`, and `final_verdict`. Each event carries `executionId`, `attempt`, and `sequence`. Discard duplicates; never apply a previous attempt to the current one.

If the replay cursor is missing, expired, from a different attempt, or ahead of the server, `replayAvailable` is false. Restore the snapshot, indicate unavailable historical console output, and resume from its attempt/sequence. Live delivery sends `execution_sync` with `{snapshot,replayAvailable:false}` when it encounters this condition. The existing owner-authorized REST snapshot remains the recovery path if WebSockets are unavailable. `unsubscribe_execution` takes the execution UUID.

Each process allows at most 500 authenticated sockets, 20 concurrent authentication queries, five sockets per user, 20 per peer IP, five subscriptions per socket, 60 subscription commands per minute, and one in-flight command/poll per socket. Peer IP is the socket peer, not a trusted client-provided forwarded header; a reverse proxy may share that budget. Slow transports are disconnected instead of retaining an unlimited output stream. Payloads are capped at 16 KiB; compression is disabled.

Each gateway polls its local owned subscriptions every 500 ms, so multiple instances can deliver independently from PostgreSQL without a Socket.IO Redis adapter or long-poll sticky sessions. Polls do not overlap. Revocation is checked on the next available delivery pass; database latency and batch load affect this delay. Stage 9 must load-test and tune this strategy before production traffic.

## Public output boundaries

Only RUN output for public cases belonging to the pinned version is accepted. Submit output and hidden-case results are rejected at the writer, not merely hidden in the UI. Terminal events contain aggregate state/verdict only. Source code, expected answers, inputs, lease tokens and internal exceptions never enter the public event payloads.

Console chunks are limited to 4 KiB and terminal/ANSI/bidirectional controls are stripped. Result JSON is capped at 256 KiB. Per-execution replay keeps at most 256 rows and 256 KiB of serialized payloads, expires after ten minutes, and is cleared on a new attempt. Bounded maintenance deletes expired rows. The browser must still render output as text, never HTML.

## Verification and remaining stage

Run checks with both disposable services configured:

```sh
DATABASE_URL=postgresql://... TEST_DATABASE_URL=postgresql://... \
TEST_REDIS_URL=redis://127.0.0.1:6379/0 npm run check
```

Local verification passed schema validation, build, full typecheck and all 99 tests (27 new pipeline checks plus the existing 72), using PostgreSQL 17 and Redis 8.6.6. The existing five-migration database upgraded successfully; all six migrations also applied to a fresh database and seeding ran twice; the dependency audit reported zero known vulnerabilities.

The pipeline tests cover real BullMQ delivery, duplicate claims, stale writes, expired leases, cancellation acknowledgement, queue endpoint failure, Redis queue-data loss, private output rejection, replay caps/gaps/expiry, two gateways, cookie/Origin/owner checks, session revocation/expiry, and command/subscription limits. Tests use no execution sandbox. Hosted CI, deployment proxies and production performance require their own checks.

Next: stage 6 isolated execution. Implement the backend contract using a separate supervisor, fail-closed isolation checks, process-tree cleanup, image provenance, resource/network/filesystem restrictions and cleanup tests before enabling code execution.
