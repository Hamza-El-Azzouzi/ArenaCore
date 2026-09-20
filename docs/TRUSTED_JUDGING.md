# Stage 7: trusted judging and the worker adapter

Judging is implemented in `packages/judge`; the separate runner adapter is `apps/runner/src/judging-backend.ts`. A prepared queue-worker entrypoint is `apps/api/src/executions/worker-main.ts`. It runs as a separate process on the dedicated runner host, never from HTTP bootstrap. Sharing the built API artifact reuses its tested job store/lease protocol without giving the HTTP process a Docker socket.

The worker accepts only an explicit production configuration with `RUNNER_WORKER_ENABLED=true`. Its systemd unit remains disabled until the remaining gates pass. The dedicated gVisor suite, idle supervisor/janitor lifecycle drill, restricted dependency check and controlled seven-job live judging gate pass; abrupt-death recovery and trusted metric collection are still pending. This milestone does not clear public launch gates.

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

The dedicated runner produced that success code with the separate `arenacore_worker` database login and private application address. This proves installation-time reachability and configured grants. It does not replace the next controlled end-to-end judging test.

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

## Controlled live-judging gate

This gate exercises the deployed PostgreSQL, Redis, restricted worker, private Unix RPC, supervisor, Docker, gVisor and all three pinned runtime images. It bypasses browser authentication and the transactional dispatcher, which already have separate integration coverage. The operator command refuses to run unless `NODE_ENV=production`, `EXECUTIONS_ENABLED=false`, `PIPELINE_ENABLED=false`, Redis is configured, the database has no unfinished execution, and the queue has no waiting, active, delayed or prioritized job.

After deploying the commit, first confirm on the runner that the worker is disabled and no sandbox exists:

```sh
sudo systemctl is-enabled arenacore-worker.service || true
sudo systemctl is-active arenacore-worker.service || true
sudo docker ps --all --quiet --filter label=arenacore.managed=true
```

The expected service results are `disabled` and `inactive`, and the Docker command prints nothing. Start the worker without enabling it:

```sh
sudo systemctl start arenacore-worker.service
sudo journalctl -u arenacore-worker.service --since '-1 minute' --no-pager \
  | grep JUDGING_WORKER_STARTED
```

In a second terminal on the application VM, run the acceptance command inside the deployed API container:

```sh
sudo docker exec \
  -e LIVE_JUDGING_ACCEPTANCE=true \
  arenacore-api npm run acceptance:live-judging
```

It creates seven controlled executions: correct Run and Submit jobs for Python, JavaScript and Java, plus a wrong Submit that generates hidden output internally. It requires every correct job to finish `ACCEPTED`, the wrong job to finish `WRONG_ANSWER`, every attempt to be fenced and terminal, Run results to contain only public case IDs, and Submit events/results to contain no console output or hidden input/answer sentinel. It waits for BullMQ jobs to leave the active state, removes only its own queue jobs and database fixtures, and prints `LIVE_JUDGING_ACCEPTANCE_PASSED`.

The production gate produced `LIVE_JUDGING_ACCEPTANCE_PASSED`. Its idle counts were zero before fixture creation. Cleanup returned the worker to `inactive` and `disabled`, and Docker reported no ArenaCore-managed container. This is the recorded live judging/privacy acceptance evidence for the current pinned images and release.

Immediately stop the worker on the runner whether the application command passes or fails:

```sh
sudo systemctl stop arenacore-worker.service
sudo systemctl is-active arenacore-worker.service || true
sudo systemctl is-enabled arenacore-worker.service || true
sudo docker ps --all --quiet --filter label=arenacore.managed=true
```

The final expected state is `inactive`, `disabled`, and no managed container. A failure prints only its safe stage. The idle preflight also prints aggregate database and queue counts, never job contents. `FIXTURE_VALIDATION` means the published `sum-two-numbers` fixture is absent or no longer has exactly two public and one hidden case. Application deployment runs the compiled production seed after migrations and before switching the active release; it creates an absent fixture and rejects a conflicting existing one. Keep execution disabled, preserve the database rows after a result-verification failure for investigation, and inspect the worker/supervisor journals without printing credentials or source.

## Verification

Unit tests exercise comparison/classification, all language observation shapes, private projections, protocol rejection, cancellation, missing metrics, output limits, pinned plan loading and worker activation gates. Real PostgreSQL/Redis/BullMQ integration tests run the actual judging backend with controlled observation fixtures: a hidden Submit prints sentinel diagnostics but publishes only WRONG_ANSWER; a correct public Run stores only public case results.

The standard suite additionally checks Unix RPC and fencing/privacy from previous stages. Real language execution and resource/cleanup behavior require the separate opt-in dedicated-host suite. Hosted CI and a production runtime remain unverified.

Local verification: schema validation, workspace build, full typecheck and 146 tests passed; 14 live-host tests remain unrun. Dependency audit reported zero known vulnerabilities. No database migration was needed for this stage.
