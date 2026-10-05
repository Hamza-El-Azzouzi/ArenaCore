# ArenaCore runner troubleshooting

Use this guide when an execution stays queued, returns **Internal Error**, reports unavailable metrics, or the dedicated runner VM is unhealthy. Run runner commands on the runner VM. Run PostgreSQL, Redis, API-container, and Caddy commands on the application VM.

## What “Internal Error · Metrics unavailable” means

The API stored `INTERNAL_ERROR` because trusted judging infrastructure failed before it returned a valid result. CPU and memory measurements only exist after the gVisor sandbox returns a valid measured observation, so an infrastructure failure has no metrics.

ArenaCore never sends Docker errors, host paths, credentials, source code, or hidden-test details to learners. Correlate the execution UUID with these safe journal markers:

- `JUDGING_JOB_FAILED execution=<uuid> attempt=<n> code=<code>` from the worker.
- `RUNNER_EXECUTION_FAILED execution=<uuid> attempt=<n> code=<code>` from the supervisor.
- `RUNNER_METRICS_FAILED <code>` for cgroup-v2 failures.

Confirmed-clean transient supervisor failures retry up to the bounded attempt limit. Loss of supervisor contact or unconfirmed sandbox cleanup fails closed.

## Fast runner-host check

```bash
readlink -f /opt/arenacore/current
sudo systemctl is-active arenacore-supervisor.service arenacore-worker.service arenacore-janitor.timer
sudo systemctl is-enabled arenacore-worker.service
sudo systemctl status arenacore-supervisor.service arenacore-worker.service --no-pager
sudo docker info --format 'cgroup={{.CgroupVersion}} driver={{.CgroupDriver}} runtimes={{json .Runtimes}}'
sudo docker ps --all --filter label=arenacore.managed=true
sudo stat -c '%U:%G:%a %n' /run/arenacore /run/arenacore/supervisor.sock /etc/arenacore/runtime-images.json /etc/arenacore/worker.env
```

Expected:

- Supervisor, worker, and janitor timer are active; worker is enabled.
- Docker uses cgroup v2 and lists `runsc`.
- No managed sandbox remains while execution is idle.
- The socket is `arenacore-supervisor:arenacore-runner` mode `660`.
- `worker.env` is `root:root:600`. Never print it because it contains credentials.

Check that both processes use the active release:

```bash
active="$(readlink -f /opt/arenacore/current)"
for unit in arenacore-supervisor.service arenacore-worker.service; do
  pid="$(sudo systemctl show "$unit" --property=MainPID --value)"
  printf '%s pid=%s cwd=%s\n' "$unit" "$pid" "$(sudo readlink -f "/proc/$pid/cwd")"
done
printf 'active release=%s\n' "$active"
```

Each `cwd` must equal the active release. A mismatch means the symlink changed without restarting the services.

## Diagnose one execution

Copy the execution UUID from the browser response or submission history:

```bash
execution_id=00000000-0000-4000-8000-000000000000
sudo journalctl -u arenacore-worker.service --since '-30 minutes' --no-pager | grep -F "$execution_id"
sudo journalctl -u arenacore-supervisor.service --since '-30 minutes' --no-pager | grep -F "$execution_id"
sudo journalctl -u arenacore-worker.service -u arenacore-supervisor.service --since '-30 minutes' --no-pager \
  | grep -E 'JUDGING_JOB_FAILED|RUNNER_EXECUTION_FAILED|RUNNER_METRICS_FAILED|STARTUP_FAILED|SHUTDOWN_FAILED'
```

Do not paste source, database or Redis URLs, environment files, or hidden test data into tickets.

| Code | Meaning and action |
|---|---|
| `RUNNER_CAPACITY` | Both sandbox slots were busy. The job retries. Check long-running or orphaned managed containers. |
| `EXECUTION_UNAVAILABLE` | Supervisor rejected the attempt after confirmed cleanup. It retries; inspect the paired supervisor marker. |
| `SANDBOX_CLEANUP_UNCONFIRMED` | Worker lost proof that the guest stopped. Keep fail-closed behavior and verify the janitor. |
| `INVALID_CGROUP_*` / `CGROUP_*` | Host metrics failed. Run the idle metrics acceptance gate. |
| `COMMAND_TIMEOUT` | A bounded Docker operation timed out. Check Docker, runsc, and host pressure. |
| `ISOLATION_UNAVAILABLE` | runsc, seccomp, limits, or cgroup v2 failed preflight. Repair before enabling work. |
| `WORKER_BACKEND_FAILURE` | The worker failed before or after supervisor RPC. If the supervisor has no matching execution marker, verify judge-plan database grants, especially `SELECT` on `TestCaseFile`. |
| `JOB_FAILURE` | All safe attempts failed, or the backend failed non-recoverably. Correlate both journals. |
| `QUEUE_TIMEOUT` | No worker claimed work. Check worker, Redis, queue name, and the application dispatcher. |

## Dependencies

On the runner VM:

```bash
nc -vz -w 3 10.0.0.51 5432
nc -vz -w 3 10.0.0.51 6379
sudo systemctl start arenacore-worker-check.service
sudo systemctl status arenacore-worker-check.service --no-pager
sudo journalctl -u arenacore-worker-check.service -n 40 --no-pager
```

`WORKER_DEPENDENCY_CHECK_PASSED` verifies configuration, PostgreSQL login and least-privilege grants, Redis, and the private supervisor socket. A TCP probe alone does not verify credentials.

After adding file-input support, the restricted database role must include:

```sql
GRANT SELECT ON TABLE "TestCaseFile" TO arenacore_worker;
```

The worker queries the file relation while loading every judge plan, including
STDIN plans with no file rows. If this grant is absent, executions fail before
the supervisor receives a request.

Submit settlement also requires execution on the fenced notification function,
without granting the runner direct access to user or notification tables:

```sql
GRANT EXECUTE ON FUNCTION create_execution_result_notification(UUID, INTEGER, UUID, TEXT)
TO arenacore_worker;
```

If Run succeeds while Submit repeatedly reaches `RUNNING` and then loses its
lease, verify this function privilege. That pattern means judging completed but
the atomic Submit settlement could not create its safe notification projection.

On the application VM, inspect queue counts without reading payloads:

```bash
sudo docker exec -i arenacore-api node <<'NODE'
const {Queue}=require('bullmq');
const {redisOptions}=require('./apps/api/dist/executions/queue.js');
(async()=>{const queue=new Queue(process.env.QUEUE_NAME||'arenacore-executions',{connection:redisOptions(process.env.REDIS_URL)});await queue.waitUntilReady();console.log({waiting:await queue.getWaitingCount(),active:await queue.getActiveCount(),delayed:await queue.getDelayedCount(),failed:await queue.getFailedCount()});await queue.close()})().catch(()=>{console.error('QUEUE_INSPECTION_FAILED');process.exitCode=1});
NODE
```

## gVisor and metric gates

These require an idle runner and intentionally stop the worker:

```bash
sudo systemctl disable --now arenacore-worker.service
sudo bash /opt/arenacore/current/infra/runner/verify-services.sh
sudo bash /opt/arenacore/current/infra/runner/verify-metrics.sh
sudo env TEST_RUNNER_ISOLATION=true RUNNER_IMAGE_MANIFEST=/etc/arenacore/runtime-images.json \
  /usr/bin/node /opt/arenacore/current/node_modules/vitest/vitest.mjs run \
  /opt/arenacore/current/tests/runner-isolation.integration.test.ts --reporter=verbose
sudo systemctl start arenacore-worker-check.service
sudo systemctl enable --now arenacore-worker.service
```

Expected markers are `RUNNER_SERVICE_LIFECYCLE_PASSED`, `RUNNER_METRICS_HOST_PASSED`, a passing isolation suite, and `WORKER_DEPENDENCY_CHECK_PASSED`.

## Safe service recovery

```bash
sudo systemctl stop arenacore-worker.service
sudo systemctl restart arenacore-supervisor.service
sudo systemctl start arenacore-worker-check.service
sudo systemctl enable --now arenacore-janitor.timer
sudo systemctl enable --now arenacore-worker.service
sudo systemctl is-active arenacore-supervisor.service arenacore-worker.service arenacore-janitor.timer
```

For an expired managed container, run the janitor and check again:

```bash
sudo systemctl start arenacore-janitor.service
sudo docker ps --all --filter label=arenacore.managed=true
```

Never use blanket Docker prune or removal commands on the shared application host.

## Release and image verification

The `Deploy isolated runner` GitHub Actions job must succeed for every runner change.

```bash
readlink -f /opt/arenacore/current
sudo cat /etc/arenacore/runtime-images.json
sudo env RUNNER_IMAGE_MANIFEST=/etc/arenacore/runtime-images.json \
  /usr/bin/node /opt/arenacore/current/apps/runner/dist/preflight.js
```

All manifest references must be digest-pinned. Expected output is `RUNNER_PREFLIGHT_PASSED_CONFIGURATION_ONLY`.

For the final live check, submit a minimal Python solution, record its UUID, and watch:

```bash
sudo journalctl -f -u arenacore-worker.service -u arenacore-supervisor.service
```

A healthy execution reaches `FINISHED` with measured CPU and memory. Afterwards, the managed-container list must be empty.
