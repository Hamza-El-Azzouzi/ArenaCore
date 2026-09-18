# Backend foundation implementation notes

The README is the progress tracker. This release implements the foundation, persistence/problem baseline, OIDC login/session authorization, and the durable-job API/database milestone. Queue dispatch, realtime delivery, code execution and complete judging remain pending.

## Dependency choices

Prisma/client are pinned together to 6.19.0; the migrations and CLI have been tested with that pair. Do not upgrade one without the other. Prisma 7+ changes datasource/configuration and adapter APIs, so migration to it is separate work.

Dependency overrides select patched `multer` 2.3.0, `deepmerge-ts` 8.0.0 and `effect` >=3.20.0. Explicit multer dependencies keep workspace/hoisted resolution consistent with the override. The lockfile records the exact resolved versions. The Prisma CLI, migrations and seed were checked with the overridden dependencies; revisit compatibility and advisories on future updates. No multipart upload endpoint is implemented.

Local development and CI PostgreSQL images select 17.11, following the [PostgreSQL release notes](https://www.postgresql.org/docs/17/release.html). Actual local integration checks used the installed PostgreSQL 17 binaries, not Compose. Production image digest selection and scanning belong to the operations stage.

The shared tsconfig uses paired NodeNext module/resolution options and explicit Node ambient types. This fixes TypeScript 6 editor deprecation diagnostics while retaining CommonJS output for the current backend packages. The workspace remains on TypeScript 5.9.3; the repair was also checked with the installed VS Code TypeScript compiler. See [compiler/editor compatibility](learning/64-typescript-module-resolution-and-editor-versions.md).

## Persistence guarantees

PostgreSQL triggers prevent edits/deletes to published problem versions and their tests. A current version must be published and belong to its problem. Source size and private Submit results are also constrained in SQL. These custom constraints/triggers are managed by migrations, not fully represented by Prisma models; do not use `prisma db push` as a replacement for migrations.

Job creation locks the user row in a transaction, checks idempotency before concurrency limits, snapshots the current problem version, reserves shared successful-creation quotas/global capacity, and inserts execution plus outbox atomically. A transaction advisory lock serializes global admission across owners and API replicas. Lifecycle triggers freeze request/version and terminal facts, enforce the state graph, and require consistent terminal verdict/timestamps. Outbox intents are unique per execution/kind and reference executions. The outbox is durable but has no dispatcher yet. Cancellation changes only QUEUED jobs and emits one outbox record; running sandbox cancellation is pending. Startup/periodic maintenance expires bounded batches of overdue queued jobs with SKIP LOCKED and durable expiry intents. Maintenance stops before the database disconnects. See [durable jobs](DURABLE_JOBS.md) for settings, quota accounting, and error behavior.

Public problem reads project PUBLIC tests only. Submit snapshots never serialize result blobs. Private history omits source and test diagnostics. Dedicated API/runner database roles and further infrastructure privilege separation still require implementation before production launch.

## Sessions

Opaque random session tokens are stored as SHA-256 hashes, and expiry/revocation is checked on each request. CSRF tokens are derived using a domain-separated HMAC of the session token and stored as hashes; repeated `/me` calls do not invalidate other tabs. Mutating protected requests require both the exact allowed Origin and CSRF token. Session issuance and secure cookie creation are implemented through OIDC login. See [provider setup and protocol details](OIDC_SETUP.md). Provider role claims do not change database roles; the reusable RolesGuard enforces declared role requirements on future admin routes.

## Verification

The current local full check passed 72 tests, including 54 real PostgreSQL/API/OIDC protocol checks. The identity milestone previously passed 48 tests. Stage 4 added cross-instance quotas/global-capacity races, rollback after outbox failure, version pinning, queued cancellation/expiry races, automatic scheduling, SQL state-graph agreement/terminal consistency, outbox integrity, and timestamp-tied history pagination. All five migrations and repeatable seed were verified on a fresh disposable PostgreSQL database; the new migration was also verified as an upgrade. The initial foundation run passed 22 tests. Covered boundaries include immutable published data, public test filtering, stable CSRF, anonymous/expired/revoked session denial, cross-origin/CSRF denial, UTF-8 source caps, rejected owner overrides, concurrent idempotency, active-job limits, owner isolation, idempotent queued cancellation, malformed/oversized bodies, execution disablement and logout revocation.

OIDC checks additionally cover signed-token/claim rejection, encrypted proof integrity, browser binding, concurrent callback replay, session rotation, production cookie attributes, provider outage recovery and shared rate limits. The provider transport is a controlled fixture; a live provider is still to be configured.

Passing these tests does not verify a sandbox or establish public-launch readiness. Those stages remain pending in the README.
