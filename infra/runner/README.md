# Dedicated runner host setup and isolation acceptance

Stage 6 code is implemented as a supervisor library and preflight CLI. The dedicated ARM64 host passed all 14 live gVisor isolation tests with the pinned three-language manifest. The idle supervisor/janitor lifecycle drill, restricted worker dependency check and controlled seven-job live judging gate also passed. The abrupt-death verifier is ready for its host run; measured metrics and independent review remain launch gates. Do not enable public execution from this guide alone.

## Host boundary

Provision a dedicated Linux VM with sufficient memory, cgroup v2, Docker resource enforcement and gVisor. Keep API/web/PostgreSQL/Redis off the runner host. The trusted worker may reach the private database/queue; guest containers may not. Restrict inbound traffic to administration and the future internal supervisor channel. Apply host egress/firewall policy separately from the guest's `--network=none` setting.

Docker socket access gives substantial host control. Only the narrow supervisor process should have it; API/web and guest processes must not. Use separate operating-system service users and a private local Unix socket for future worker/supervisor RPC. The current library is not a public runner endpoint. The bounded Unix HTTP protocol and systemd service templates are implemented; install and verify them on the dedicated host before considering that deployment gate complete.

Install an explicitly selected gVisor release using its [official installation instructions](https://gvisor.dev/docs/user_guide/install/). Verify its published checksum, retain the version/checksum in provisioning records, and keep required sidecar binaries next to `runsc`. Do not use an unverified `latest` binary. Register `runsc` using the [Docker setup instructions](https://gvisor.dev/docs/user_guide/quick_start/docker/) and restart Docker during an approved maintenance window. Provisioning changes are performed by the host operator; this repository has not executed them.

Preflight checks Docker's Linux/cgroup-v2/resource/seccomp support and registered runtime. Those reported capabilities do not prove kernel limits work. The live suite and additional host acceptance checks below must confirm their effects. Validate that the registered `runsc` actually points to the approved gVisor binary, not an alias for `runc`.

## Build and lock runtime images

The three Dockerfiles in `runtime-images` require `BASE_IMAGE` explicitly. Select current security-patched Python 3.14 Alpine 3.24, Node 24 Alpine 3.24, and Temurin 21 JDK bases. The Alpine Node build for ARM64 uses musl and must pass the full host acceptance suite; do not infer compatibility from a successful image build. Resolve every base to a verified immutable digest, scan it and record provenance. The Python and JavaScript Dockerfiles remove package installers because submissions only invoke the language interpreter. The final custom image must have user `10001:10001` and only approved, nonsecret environment variables. No packages are installed during submissions.

A representative operator build command is:

```sh
docker build --build-arg BASE_IMAGE='python@sha256:<verified-base-digest>' \
  -f runtime-images/python.Dockerfile -t '<private-registry>/arenacore/python:<release>' .
```

Repeat with Java/JavaScript Dockerfiles and their own base digests. Publish approved images to your private registry through your release process, inspect their resulting repository digests, and pre-pull them on the runner. The first Java candidate passed the vulnerability gate. The first Debian-based Python and JavaScript candidates failed it and are not approved manifest entries. Their hardened Alpine `arm64-3` replacements passed with zero HIGH/CRITICAL findings; publish and record their immutable repository digests before acceptance testing.

Scan the final local image, not only its base, and reject any HIGH or CRITICAL finding before publishing or adding its digest to the manifest:

```sh
trivy image --image-src docker --scanners vuln \
  --severity HIGH,CRITICAL --exit-code 1 --no-progress \
  '<private-registry>/arenacore/python:<release>'
```

Do not use `--ignore-unfixed` to force a pass. A suppression needs a repository-owned ignore entry with the exact advisory, affected component, expiry date and written reachability analysis. Trivy can discover SBOM files embedded in an image; its third-party-SBOM warning means package attribution needs verification, not that the finding should be silently ignored.

Copy `runtime-images/images.example.json` to a protected operator-owned manifest outside submission scratch storage. Replace all placeholders with final custom-image references such as `registry.example/arenacore/python@sha256:<64 lowercase hex characters>`. Tags/placeholders fail validation. The implementation has no invented default image digests. Do not create the production manifest until all three final images pass their vulnerability and runtime acceptance gates.

```sh
RUNNER_IMAGE_MANIFEST=/etc/arenacore/runtime-images.json \
node apps/runner/dist/preflight.js
```

The command prints only a stable pass/fail code. A pass confirms configuration checks and a bounded orphan sweep, not the isolation acceptance suite. It does not start a queue worker or enable API execution.

## Run the real host suite

On the dedicated VM after building the repository:

Run:

```sh
TEST_RUNNER_ISOLATION=true \
RUNNER_IMAGE_MANIFEST=/etc/arenacore/runtime-images.json \
node_modules/.bin/vitest run tests/runner-isolation.integration.test.ts
```

Opting in makes missing images/runtime fail the suite; it never falls back to ordinary Docker. Standard CI skips these tests because its PostgreSQL/Redis services do not provide a dedicated gVisor runner.

The current live suite covers all three languages, infinite loops, output flooding, internet/metadata blocking, root filesystem/socket access, fresh scratch between cases, memory/PID/scratch caps, credential absence, cancellation with children, and malformed compilation. All 14 tests passed on the dedicated ARM64 gVisor host using the approved digest-only manifest.

Complete the remaining acceptance drills before stage 6 is marked complete: measured memory/PID/CPU/file/scratch enforcement; fork bombs and child-process escape attempts; compiler abuse; cross-job/process visibility; no host/API/DB/Redis credentials; cancellation during creation/compile/run; worker/supervisor death; bounded external orphan cleanup; restart and drain behavior; verified runtime/image provenance; and independent security review. Add real tests for these properties, rather than checking command flags alone.

## Cleanup and process ownership

Each container has a random name and labels for execution UUID, attempt and absolute deadline. Success/failure/cancellation/timeout paths force-remove the container and verify absence before acknowledging cleanup. A failed verification disables new intake in that supervisor and raises `SandboxCleanupError`. The worker records infrastructure failure rather than claiming successful cancellation.

`reapExpired()` scans only managed containers, at most 100 per pass, and removes expired or malformed-deadline resources. An external service must call this periodically, with no overlapping passes, independent of the queue worker's survival. The preflight performs one sweep. The included `arenacore-janitor.service` and `.timer` run the standalone `--janitor` mode independently; templates are not installed or started by this repository. Repeated Docker unavailability requires host-level escalation, not invented cleanup success.

The execution library's `stopAccepting()` aborts active signals and rejects new work. Callers must await their execution promises before exiting. The Unix supervisor server implements bounded admission, body limits, disconnect cancellation and drain. Graceful restart and independent cleanup passed on the host. The abrupt supervisor-death verifier below must also pass on the deployed runner.

## Launch state

API production execution remains rejected and default creation remains disabled. Stage 7 will wire trusted judging/aggregate metrics and the real worker adapter after stage 6 isolation is demonstrated. Hidden expected answers must remain in the trusted judge; the supervisor request carries source and current-case input only, never expected output. Reconcile the missing earlier sandbox specification before claiming compliance with it.

## Private supervisor service and worker client

The server listens only on `RUNNER_SOCKET_PATH`, chmods the socket to 0660, and accepts bounded `POST /execute` and `POST /cancel` JSON. It has no TCP listener. Filesystem ownership restricts access to the trusted runner group; it is not an end-user authorization API. Request-controlled images, paths, commands, expected answers and limit overrides outside server caps are rejected. Only the trusted worker should construct requests after loading an owner-authorized pinned job and its selected case inputs.

`SupervisorClient` uses the private socket and validates bounded responses. Cancellation uses a separate strict request while retaining the execution channel for cleanup acknowledgement. Unexpected execution-channel disconnection also triggers server cleanup. If the client loses contact or receives an error, it raises cleanup uncertainty; it cannot assume a process stopped. The independent janitor remains necessary after supervisor death. Raw observations, including hidden stdout/stderr, stay on this private channel and must be consumed by the trusted judge, never forwarded wholesale through REST or Socket.IO.

Service templates assume `/opt/arenacore`, `/usr/bin/node`, `/usr/bin/docker`, `/usr/bin/runsc`, `/var/run/docker.sock`, and the `arenacore-supervisor`/`arenacore-runner` identities. API services must never join the Docker group. Protect the manifest as operator-owned read-only configuration. A stale Unix socket after an unclean supervisor exit intentionally causes startup failure; the operator must verify no owner is alive before removing it. Docker access itself bypasses many OS restrictions, so these unit settings supplement dedicated-host isolation.

After the manifest and binaries are present, install the identities and systemd units from a reviewed checkout:

```sh
sudo bash infra/runner/bootstrap-host.sh
```

The bootstrap is idempotent and ends with `RUNNER_BOOTSTRAP_INSTALLED_NOT_STARTED`. It grants Docker-group access only to `arenacore-supervisor`; `arenacore-worker` shares the private-socket group but is actively removed from the Docker group. It installs the disabled worker and non-consuming dependency-check units as well as the supervisor/janitor units. The bootstrap deliberately does not start or enable the worker. Inspect the installed units and run deployment activation separately.

After activating a release while execution is still disabled, run the idle-only lifecycle verifier:

```sh
sudo bash infra/runner/verify-services.sh
```

It refuses to continue if any ArenaCore-managed sandbox exists. It verifies the systemd hardening properties, gracefully restarts the supervisor, checks the private socket through the supervisor identity, creates a stopped expired gVisor sandbox, and requires the independent janitor to remove it. Success prints `RUNNER_SERVICE_LIFECYCLE_PASSED`.

That lifecycle verifier passed on the dedicated host. Continue with the worker setup in [the trusted judging guide](../../docs/TRUSTED_JUDGING.md). Do not enable the worker or API execution yet.

The restricted dependency verifier also passed. Follow the guide's controlled live-judging gate next: start the worker without enabling it, run the operator-only acceptance command on the application host, then stop the worker and prove no managed sandbox remains.

## Abrupt supervisor-death gate

Run this only while public execution is disabled and the worker is both inactive and disabled:

```sh
sudo bash /opt/arenacore/current/infra/runner/verify-crash-recovery.sh
```

The verifier refuses a busy host. It starts a real Python sandbox through the private Unix socket, proves Docker selected `runsc`, and sends `SIGKILL` to the supervisor's main process. Because the service deliberately uses `Restart=no`, systemd must leave it dead. The managed container must remain observable with its original bounded deadline; this is the orphan whose cleanup cannot depend on the dead supervisor.

The script validates that deadline against the request start and the deployed runtime policy. It waits when time remains, or continues immediately if a slow service transition has already crossed the valid deadline. It then invokes the independent janitor service, requires the orphan to disappear while the supervisor is still inactive, and explicitly starts the supervisor. It verifies the recovered private socket and an empty managed-container set. A trap makes a best-effort supervisor restart and sandbox removal if an assertion fails. The drill normally takes roughly 30 seconds and succeeds only with:

```text
RUNNER_CRASH_RECOVERY_PASSED
```

Do not enable the worker as part of this drill. A pass proves bounded cleanup after abrupt supervisor death for an idle controlled host; it does not yet prove worker crash recovery, queue redelivery, or resource metric accuracy.
