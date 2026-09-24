# Runner security review record

Review date: 2026-09-20  
Scope: dedicated runner, trusted worker, private supervisor protocol, gVisor policy, runtime images, cleanup, judging privacy, and resource evidence  
Status: internal pre-review and runtime provenance complete; independent reviewer sign-off pending

Deployed posture evidence: `RUNNER_SECURITY_POSTURE_PASSED` on release `65f3688` (2026-09-20).

## Decision

The design is ready to enter independent review. The production host passed the functional, adversarial, runtime-provenance, host-network, and Oracle network-segmentation gates, and this review found no known critical or high-severity code defect in the reviewed scope. Public execution must remain disabled because the original sandbox requirement document has not been reconciled, production operations remain incomplete, and an independent reviewer has not signed off.

This is an internal engineering review of the repository and operator-supplied host evidence. It does not certify the Oracle network, account security, backup policy, or external identity provider.

## Trust boundaries

The API never receives the Docker socket and does not run learner code. A dedicated worker reads durable jobs and hidden judging data, then sends only source, one case input, language, and a server-selected profile to a local Unix socket. The supervisor is the only ArenaCore identity in the Docker group. It selects digest-pinned images and fixed commands, starts a fresh gVisor container per case, collects bounded observations, force-removes the container, and returns observations to the trusted judge. Guest containers have no network, secrets, Docker socket, writable root filesystem, or host path mount.

Docker-group membership gives the supervisor effective control of the runner host. Its systemd restrictions reduce accidental exposure but cannot make Docker access low privilege. The dedicated VM, narrow protocol, fixed policy, and absence of unrelated secrets and workloads are required security boundaries.

## Evidence accepted

The dedicated ARM64 production runner passed:

- Docker, gVisor, cgroup-v2, and effective-policy preflight.
- All 15 live isolation tests: three languages with metrics, timeout, output flooding, network and metadata denial, Docker-socket and read-only-root checks, fresh scratch, OOM evidence, CPU/memory measurement, PID and scratch limits, credential absence, cancellation/child cleanup, and malformed Java cleanup.
- Supervisor and independent janitor lifecycle with private-socket permission checks.
- Restricted worker dependency check with no worker Docker access.
- Seven-job live judging and hidden-data privacy acceptance.
- Abrupt supervisor-death recovery with deadline-bound orphan cleanup.
- Restricted-identity cgroup metrics acceptance.
- Repeatable security-posture verification for release `65f3688`.

The posture record is bound to these fingerprints:

- gVisor: `runsc version release-20260914.0`
- Installed `runsc` SHA-256: `2c5f967247954c80b5e5c8fac6d3f524947db397e4dd679de906acaf029f0b6b`
- Runtime image manifest SHA-256: `52eb2990ad6ea48e27740efc26e6e467d621c1a516ca53bae0e6d421d9aea79a`

Runtime provenance was independently reproduced from the [official gVisor release](https://github.com/google/gvisor/releases/tag/release-20260914.0). The official `SHA256SUMS` identifies `gvisor-aarch64.tar.bz2` as `218cef646c1c04a62d9acb988127e6da7c4f9e5aaefeef6929893df7a349ecb9`; the downloaded archive matched that hash. The `runsc` extracted from that verified archive produced `2c5f967247954c80b5e5c8fac6d3f524947db397e4dd679de906acaf029f0b6b`, exactly matching the installed host binary. The release tag points to gVisor commit `95eb5d5` and was published on 2026-09-16.

These results apply to the tested release, host configuration, gVisor binary, and image manifest. A changed kernel, Docker/gVisor version, systemd unit, runtime image digest, or sandbox policy requires the affected gates again.

## Findings

### Accepted design risks

**SR-01 — Supervisor Docker authority.** The supervisor must control Docker and therefore has host-equivalent authority on the dedicated runner. The worker and learner containers cannot access the socket. Keep API, database, Redis, cloud credentials, and unrelated workloads off this VM.

**SR-02 — Terminal cgroup evidence.** A memory-killed container can have PID zero before the final snapshot. The implementation accepts persisted `OOMKilled=true` only for a stopped container and omits unavailable metrics. It never infers OOM from an exit code or fabricates counters. Live OOM and PID-limit tests passed.

**SR-03 — Local group authorization.** A process in `arenacore-runner` can call the supervisor socket. Provisioning must restrict this group to the supervisor and trusted worker. The posture verifier checks identities, Docker separation, socket permissions, and effective unit properties.

### Finding disposition

**SR-04 — Independent review — open.** A reviewer who did not implement the runner must inspect the policy and protocol and repeat or observe the host gates. Record the reviewer, date, release commit, findings, and disposition here.

**SR-05 — Runtime provenance — closed 2026-09-20.** The installed ARM64 `runsc` SHA-256 exactly matches the binary extracted from the official `release-20260914.0` archive after that archive matched the official `SHA256SUMS`. The protected runtime-image manifest fingerprint is recorded above. Repeat this verification whenever gVisor or the manifest changes.

**SR-06 — Missing authoritative requirements — open.** The earlier product PDF did not contain the referenced detailed sandbox security specification. Reconcile the implementation with that specification when available. Do not claim specification compliance before comparison.

**SR-07 — Infrastructure network posture — closed 2026-09-24.** Guest `--network=none` passed internet and metadata tests, and Docker publishes no host port. Initial host evidence found unnecessary `rpcbind` listeners on TCP 111 and an unrestricted IPv6 INPUT chain. The operator disabled and masked both `rpcbind` units, removed TCP 111, and installed persistent default-deny IPv6 INPUT rules allowing only loopback, established/related traffic, ICMPv6, and SSH. The application and runner VNICs now use separate NSGs. The application NSG admits public SSH/HTTP/HTTPS and PostgreSQL/Redis only from runner private IP `10.0.0.164/32`; the runner NSG admits SSH and limits new egress to ICMP, HTTP/HTTPS, and PostgreSQL/Redis at `10.0.0.51/32`. Connectivity, both public APIs, and SSH passed after the shared default rules were removed.

## Repeatable posture check

Run while public execution is disabled, the worker is inactive/disabled, the supervisor and janitor timer are active, and no job is running:

```sh
cd /opt/arenacore/current
sudo bash infra/runner/verify-security-posture.sh
```

It fails closed on unexpected identities, permissions, service state, systemd properties, Docker access, runtime registration, image references, image users, or residual managed containers. It prints only nonsecret fingerprints and ends with:

```text
RUNNER_SECURITY_POSTURE_PASSED
```

Save the three evidence values with the release commit. The script does not print environment files, URLs, source, test data, expected output, or learner output.

## Independent reviewer checklist

1. Pin the reviewed commit and compare deployed units and executables with that release.
2. Verify the `runsc` checksum against the approved official release record.
3. Verify manifest digests against registry artifacts and retained scan/SBOM evidence.
4. Inspect users and groups: only the supervisor may have Docker access and only worker/supervisor may access the socket.
5. Repeat the preflight, lifecycle, dependency, crash, metrics, live judging/privacy, and 15-test isolation gates.
6. Review VCN rules, firewall/egress, SSH, patching, audit retention, alerting, capacity, backup/restore, and incident recovery evidence.
7. Confirm API execution remains disabled and activation has a tested rollback.
8. Record each finding with severity, owner, deadline, remediation evidence, and disposition.

## Launch rule

Enable the worker and public execution only after open findings SR-04 and SR-06 are closed and production operations gates pass. A posture-check pass is required evidence, but is not sufficient alone to authorize launch.
