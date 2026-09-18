# Backend foundation implementation notes

The README is the progress tracker. This release implements the foundation, persistence/problem baseline, and portions of protected job APIs. It does not implement OIDC login, queue dispatch, realtime delivery, code execution or complete judging.

## Dependency choices

Prisma/client are pinned together to 6.19.0; the migrations and CLI have been tested with that pair. Do not upgrade one without the other. Prisma 7+ changes datasource/configuration and adapter APIs, so migration to it is separate work.

Dependency overrides select patched `multer` 2.3.0, `deepmerge-ts` 8.0.0 and `effect` >=3.20.0. Explicit multer dependencies keep workspace/hoisted resolution consistent with the override. The lockfile records the exact resolved versions. The Prisma CLI, migrations and seed were checked with the overridden dependencies; revisit compatibility and advisories on future updates. No multipart upload endpoint is implemented.

Local development and CI PostgreSQL images select 17.11, following the [PostgreSQL release notes](https://www.postgresql.org/docs/17/release.html). Actual local integration checks used the installed PostgreSQL 17 binaries, not Compose. Production image digest selection and scanning belong to the operations stage.

## Persistence guarantees

PostgreSQL triggers prevent edits/deletes to published problem versions and their tests. A current version must be published and belong to its problem. Source size and private Submit results are also constrained in SQL. These custom constraints/triggers are managed by migrations, not fully represented by Prisma models; do not use `prisma db push` as a replacement for migrations.

Job creation locks the user row in a transaction, checks idempotency before concurrency limits, snapshots the current problem version and inserts an outbox record atomically. The outbox is durable but has no dispatcher yet. Cancellation changes only QUEUED jobs and emits one outbox record; running sandbox cancellation is pending.

Public problem reads project PUBLIC tests only. Submit snapshots never serialize result blobs. Private history omits source and test diagnostics. Dedicated API/runner database roles and further infrastructure privilege separation still require implementation before production launch.

## Sessions

Opaque random session tokens are stored as SHA-256 hashes, and expiry/revocation is checked on each request. CSRF tokens are derived using a domain-separated HMAC of the session token and stored as hashes; repeated `/me` calls do not invalidate other tabs. Mutating protected requests require both the exact allowed Origin and CSRF token. Session issuance and secure cookie creation will be implemented with OIDC; only integration tests currently provision sessions directly.

## Verification

The local full check passed 22 tests, including 12 real PostgreSQL/API checks. Covered boundaries include immutable published data, public test filtering, stable CSRF, anonymous/expired/revoked session denial, cross-origin/CSRF denial, UTF-8 source caps, rejected owner overrides, concurrent idempotency, active-job limits, owner isolation, idempotent queued cancellation, malformed/oversized bodies, execution disablement and logout revocation.

Passing these tests does not verify a sandbox or establish public-launch readiness. Those stages remain pending in the README.
