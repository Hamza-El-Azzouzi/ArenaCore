# Stage 7: trusted judging and the worker adapter

Judging is implemented in `packages/judge`; the separate runner adapter is `apps/runner/src/judging-backend.ts`. A prepared queue-worker entrypoint is `apps/api/src/executions/worker-main.ts`. It runs as a separate process on the dedicated runner host, never from HTTP bootstrap. Sharing the built API artifact reuses its tested job store/lease protocol without giving the HTTP process a Docker socket.

The worker accepts only an explicit production configuration with `RUNNER_WORKER_ENABLED=true`. Its systemd unit remains disabled until the remaining gates pass. The dedicated gVisor suite and idle supervisor/janitor lifecycle drill pass; abrupt-death recovery, live judging and trusted metric collection are still pending. No source is executed by judging fixtures, and this milestone does not clear public launch gates.

## Exact data flow

1. BullMQ supplies an execution UUID; the worker acquires PostgreSQL attempt/token authority.
2. The backend loads the immutable, published `problemVersionId` from that claimed execution. It never follows a problem's later current version.
3. RUN queries public cases only. SUBMIT queries the complete pinned suite. Cases have stable IDs and ascending ordinals.
4. The supervisor receives source, case IDs/current inputs, language and capped limits. Expected outputs never enter that request or guest filesystem/environment.
5. After supervisor cleanup, the judge validates observations and compares raw stdout to trusted answers. Case IDs/order/completeness must match the selected suite.
6. A normal result is committed through `JobStore.finish()` with the worker's current lease. A compilation failure can finish from COMPILING. Other results pass through RUNNING before finish. Current RPC status is coarse: RUNNING is recorded after observations return; it is not a live compilation-to-run timing signal.
7. Public RUN case results are sanitized/capped and published as bounded console events after the batch observation returns. SUBMIT persists aggregate verdict only. Public events carry lifecycle/final verdict, not hidden output. Infrastructure exceptions use existing safe failure codes.

## Verdict policy

The comparator is `EXACT_NEWLINE`: normalize CRLF to LF and accept at most one additional final LF on either side. Other whitespace, extra blank lines, Unicode normalization and numeric representation remain significant. Unsupported comparators fail closed.

A failed Java compilation returns COMPILATION_ERROR with no compiler text. Python/JavaScript are interpreted; syntax failures currently classify as runtime errors. Within the selected suite, the first non-accepted case by ordinal supplies the aggregate learner verdict. Trusted supervisor timeout/output/memory evidence takes precedence over that case's exit/output. Otherwise a nonzero exit is RUNTIME_ERROR; successful exit with mismatched output is WRONG_ANSWER.

Acceptance requires a complete, correctly ordered observation for every selected case. A contiguous partial prefix is allowed only when its final observation records a resource stop. Duplicated/foreign/reordered/missing IDs, missing exit information and unknown metadata cause infrastructure failure, never accepted truth. Cancelled observations do not create fake accepted results; the worker's cancellation/lease protocol decides the terminal state after cleanup.

An exit code of 137 does not independently prove OOM. MEMORY_LIMIT_EXCEEDED is supported when the trusted observer explicitly reports it; the current Docker-CLI observer has not implemented measured OOM evidence. Existing nonzero exits therefore remain runtime errors. CPU time and peak memory are omitted until measured reliably, rather than copied from CLI wall time or problem limits.

## Public/private projection

The judge compares unsanitized full captured stdout first. Sanitization must not turn incorrect output into accepted output. Public RUN stdout/stderr strips terminal/control/bidirectional sequences, limits each stream to four KiB and shares a 24 KiB text budget across cases. `outputTruncated:true` marks partial displayed text. This budget leaves room for JSON escaping/metadata inside the existing 256 KiB result cap.

Submit returns `{verdict}` only: no case IDs, case counts, stdout, stderr, inputs, expected answers or compiler/source diagnostics. Raw observations are consumed in worker memory; they are not persisted into public columns, queue payloads or logs. The existing public writer additionally verifies pinned case visibility and prevents Submit results from entering the public result field.

## Prepared worker entrypoint

The worker uses its own small configuration schema rather than parsing the API's CORS, OIDC and browser settings. This prevents unrelated web configuration from becoming a hidden runner dependency. It requires production mode, an explicit enable flag, an absolute Unix socket, PostgreSQL/Redis URLs and a bounded queue name. Rejected values are never printed because they may contain credentials.

Create a separate PostgreSQL login for the worker. It needs to read immutable plans and claimed executions, update executions, and create/read/delete bounded public execution events. It does not need migration, user, session, authentication, audit or outbox privileges. Run equivalent reviewed SQL as the database owner, replacing the password before execution:

```sql
CREATE ROLE arenacore_worker LOGIN PASSWORD 'REPLACE_WITH_RANDOM_PASSWORD';
GRANT CONNECT ON DATABASE arenacore TO arenacore_worker;
GRANT USAGE ON SCHEMA public TO arenacore_worker;
GRANT USAGE ON ALL TYPES IN SCHEMA public TO arenacore_worker;
GRANT SELECT, UPDATE ON TABLE "Execution" TO arenacore_worker;
GRANT SELECT, INSERT, DELETE ON TABLE "ExecutionEvent" TO arenacore_worker;
GRANT SELECT ON TABLE "ProblemVersion", "TestCase" TO arenacore_worker;
```

On the runner, create `/etc/arenacore/worker.env` as `root:root` mode `0600`. Percent-encode URL-reserved characters in passwords. Use only the private application address:

```dotenv
DATABASE_URL=postgresql://arenacore_worker:REPLACE_URL_ENCODED_PASSWORD@10.0.0.51:5432/arenacore
REDIS_URL=redis://:REPLACE_URL_ENCODED_PASSWORD@10.0.0.51:6379/0
QUEUE_NAME=arenacore-executions
```

Rerun bootstrap from the deployed checkout, then perform the non-consuming dependency check:

```sh
sudo bash infra/runner/bootstrap-host.sh
sudo bash infra/runner/verify-worker.sh
```

The check unit runs with the same identity, filesystem restrictions and network allowlist as the real worker. It connects to PostgreSQL and Redis and reaches the Unix supervisor, but it never creates a BullMQ consumer and cannot claim an execution. Success prints `WORKER_INSTALLATION_CHECK_PASSED`; the real worker remains stopped and disabled.

Startup failures log only a safe stage code: `CONFIGURATION`, `DATABASE_CONNECTION`, `DATABASE_PRIVILEGES`, `REDIS_CONNECTION`, `SUPERVISOR_CONNECTION`, or `WORKER_INITIALIZATION`. They never include a URL, password, database error, submitted source or hidden test data.

For an approved live-judging gate later, systemd starts the worker with the equivalent configuration:

```sh
NODE_ENV=production RUNNER_WORKER_ENABLED=true \
RUNNER_SOCKET_PATH=/run/arenacore/supervisor.sock \
DATABASE_URL=postgresql://... REDIS_URL=redis://... \
QUEUE_NAME=arenacore-executions npm run runner:worker
```

Inject private credentials through systemd's root-only environment file. This entrypoint deliberately does not load the API's root `.env`. The trusted worker joins the supervisor socket's runner group, but has no Docker group/socket access. Supervisor/guest processes do not inherit its database/queue credentials. SIGTERM drains the worker before disconnecting its database; the independent supervisor janitor covers abrupt process death.

Do not enable API creation yet. The production worker entrypoint is available for the controlled live-judging gate, but the installed unit remains disabled until that gate, abrupt-death recovery and resource evidence pass.

## Verification

Unit tests exercise comparison/classification, all language observation shapes, private projections, protocol rejection, cancellation, missing metrics, output limits, pinned plan loading and worker activation gates. Real PostgreSQL/Redis/BullMQ integration tests run the actual judging backend with controlled observation fixtures: a hidden Submit prints sentinel diagnostics but publishes only WRONG_ANSWER; a correct public Run stores only public case results.

The standard suite additionally checks Unix RPC and fencing/privacy from previous stages. Real language execution and resource/cleanup behavior require the separate opt-in dedicated-host suite. Hosted CI and a production runtime remain unverified.

Local verification: schema validation, workspace build, full typecheck and 146 tests passed; 14 live-host tests remain unrun. Dependency audit reported zero known vulnerabilities. No database migration was needed for this stage.
