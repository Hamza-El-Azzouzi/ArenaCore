# ArenaCore

A browser coding IDE with a secure, separately hosted execution backend. Frontend generation is handled through v0 or Bolt; backend implementation is tracked here.

## Backend roadmap

This checklist is the shared progress tracker. A stage is complete only when its acceptance checks pass. Partial work stays unchecked.

| Stage | Work | Acceptance check | Status |
| --- | --- | --- | --- |
| 1. Foundation | TypeScript workspaces, shared contracts, NestJS bootstrap, validated configuration, structured errors, health endpoints | Build, typecheck and automated API/domain checks pass | Complete |
| 2. Persistence and problems | PostgreSQL schema/migrations, immutable problem versions, public-only problem reads, idempotent sample seed | Migrations and seed run on a real database; private tests excluded from DTOs | Complete |
| 3. Identity and authorization | OIDC + PKCE login, server sessions, logout, CSRF, expiry and owner/RBAC checks | Login/logout and cross-user/cross-origin denial tests pass | Complete (automated) |
| 4. Durable jobs | Validated Run/Submit creation, user-scoped idempotency, shared creation quotas/global caps, atomic outbox, immutable version snapshots, queued expiry/cancellation, private history | Concurrent/retried requests, quota/capacity races, expiry and cancellation preserve state and ownership | Complete (API/database) |
| 5. Queue and realtime | BullMQ dispatch, worker leases/fencing, Socket.IO auth, bounded safe replay and reconnection | Queue failure, duplicate delivery and reconnect tests pass | Complete (protocol; static test backend) |
| 6. Isolated execution | Dedicated runner, gVisor supervisor, pinned Java/Python/Node images, isolated compilation, resource/output/network limits | All languages run correctly; adversarial isolation tests and cleanup pass | Pending |
| 7. Trusted judging | Public Run / private Submit suites, external comparator, verdicts, sanitized diagnostics, aggregate metrics | Correct/incorrect solutions judged accurately; hidden output never leaks | Pending |
| 8. Frontend integration | Replace generated UI mocks with typed REST/Socket.IO adapter | End-to-end login, Run, Submit, cancel, reconnect and history pass | Pending |
| 9. Production operations | IaC, CI/CD, staging, secrets, telemetry, backups, restore, rollback, capacity and abuse limits | Security review, load test, restore and rollout drills pass | Pending |

Implementation order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Foundational pieces of later stages can be introduced earlier, but their stages remain pending until verified end to end. Each implementation update will record completed work, checks and the next milestone here.

## Security boundaries

User code runs only on dedicated runner hosts. Web/API processes never receive a Docker socket. Run uses public cases; Submit keeps hidden input, answers, stdout/stderr and runtime diagnostics private. Jobs and authoritative verdicts are durable and survive browser disconnects. Nothing executes untrusted code until the isolated runner is implemented and verified. This foundation release also refuses to enable execution in production configuration.

The supplied PDF references an earlier sandbox security specification that is absent. We can implement the proposed baseline, but cannot claim compliance with that missing specification before reviewing it.

## Design and frontend handoff

- [Architecture, security baseline and deployment plan](docs/ARCHITECTURE_AND_DEPLOYMENT.md)
- [Durable-job behavior, configuration and acceptance checks](docs/DURABLE_JOBS.md)
- [Queue, worker protocol and Socket.IO setup](docs/STAGE_5_PIPELINE.md)
- [Copy-ready v0 frontend prompt](docs/prompts/V0_PROMPT.md)
- [Copy-ready Bolt frontend prompt](docs/prompts/BOLT_PROMPT.md)

Use either prompt for the initial UI, export it into `apps/web`, and retain one frontend codebase. Demo results are simulated; actual judging belongs to the isolated backend.

## Learn the backend and NestJS

Start with the [backend learning course](docs/learning/README.md): 67 separate chapters explaining NestJS, architecture, PostgreSQL, authentication, cryptography, testing, and deployment through this project's code. Each topic includes mechanisms, concrete examples, failure cases, and exercises with worked reasoning. Follow the reading paths and finish with the NestJS practice labs. Implemented queue/realtime protocols and planned sandbox/judging work are labeled separately.

## Local backend setup

Use Node.js 24 LTS and npm. The code has also been checked locally on Node.js 20.20.2, but use the LTS version for new deployments.

```sh
cp .env.example .env
npm ci
npm run db:generate
docker compose -f infra/compose.dev.yml up -d
npm run db:migrate
npm run db:seed
npm run dev:api
```

The local API binds to `127.0.0.1:3001`. `npm run dev:api` and `npm run start:api` load the root `.env`; production services should inject environment variables and run `node apps/api/dist/main.js` after building. The Compose password is local development data only; use managed secrets in deployment. Do not expose this local database to the internet.

Available routes under `/api/v1`:

- `GET /health/live`, `GET /health/ready`
- `GET /problems`, `GET /problems/:slug`
- `GET /auth/login`, `GET /auth/callback`
- `GET /me` (anonymous returns `{user: null}`)
- `POST /auth/logout` (session + Origin + CSRF required)
- `POST /executions`, `GET /executions/:id`, `POST /executions/:id/cancel`
- `GET /submissions`

Logout, executions and submissions routes require an unexpired server-side session. OIDC login is implemented and remains disabled until a real client registration is configured; there is no demo authentication bypass. See [OIDC setup and provider registration](docs/OIDC_SETUP.md). Execution creation is disabled by default. Durable admission, BullMQ outbox dispatch, fenced worker claims, bounded recovery and authenticated Socket.IO replay are implemented. There is no isolated execution backend yet. Queued cancellation is immediate; active cancellation is a request until the trusted backend confirms cleanup. See [stage 4 admission](docs/DURABLE_JOBS.md) and [stage 5 setup/protocol](docs/STAGE_5_PIPELINE.md). Each API instance performs bounded maintenance; dispatch and realtime are independently disabled by default.

For the frontend, proxy `/api/v1` and `/socket.io` (WebSocket upgrade) to the API under the same browser origin. Cross-origin API access is intentionally not enabled. Production also requires TLS termination at a reverse proxy and a valid HTTPS `PUBLIC_ORIGIN`.

## Verification

```sh
npm run check
```

This validates the schema, compiles the workspaces, typechecks tests/seed/config, and runs tests. Database integration tests are skipped unless `TEST_DATABASE_URL` is explicitly set; an ordinary unit-only run does not verify the database. Queue/realtime integration tests additionally require `TEST_REDIS_URL`.

For integration checks, provision a **disposable** PostgreSQL database, migrate it using `DATABASE_URL`, then run:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/arenacore_test \
TEST_REDIS_URL=redis://localhost:6379/0 npm run check
```

Integration tests create temporary users/sessions/executions and seed the sample problem. They never reset an existing database; still use a dedicated test database. `.github/workflows/backend.yml` provisions PostgreSQL and Redis and runs these checks plus the dependency audit in CI. The workflow has been added but its hosted execution has not been observed yet.

## Current milestone and next work

Stages 1–5 are implemented and verified with automated checks: foundation, persistence/problems, identity/authorization, durable admission, and queue/realtime protocol. Stage 5 tests use a static trusted backend which never executes submitted code. OIDC login issues browser-bound sessions after signed-token validation. Durable admission enforces owner/global active caps and shared new-job quotas; database lifecycle protection and bounded queued expiry preserve terminal outcomes. A live identity provider has not been connected yet; follow the setup guide and smoke-test it before deployment. The sample includes public and hidden test data for judging development; the public problem API queries public examples only.

Next: stage 6—dedicated isolated runner, supervisor cleanup, pinned language runtimes and adversarial isolation checks. Execution stays off until runner isolation and judging pass their launch checks.

## Implementation log

- Backend start: roadmap recorded before implementation. Added workspaces, shared schemas, NestJS API, validated configuration, structured safe errors, PostgreSQL models/migrations, immutable published versions/test suites, repeatable seed, session/CSRF validation, owner-filtered jobs/history, concurrency-safe idempotency and atomic outbox creation. Added local PostgreSQL Compose and CI checks. Verified: both migrations applied to temporary PostgreSQL; seed ran twice; schema validation, build and full typecheck passed; all 22 tests passed, including 12 real database/API integration checks. Dependency audit reported zero known vulnerabilities. Compose and the hosted CI workflow have not been run.

- Identity milestone: added OIDC Authorization Code + PKCE, issuer/audience/nonce/expiry and explicit JWS signature validation, encrypted single-use browser-bound login attempts, hashed session issuance/rotation, secure cookies, database-owned RBAC, shared login rate limits, exact proxy trust configuration, audit events and provider setup documentation. Applied the two new auth migrations; schema, build and full typecheck passed; all 48 tests passed (32 real PostgreSQL/API/protocol checks). Dependency audit reported zero known vulnerabilities. OIDC transport uses a controlled signed-token fixture; a third-party provider and hosted CI have not been exercised.

- Durable jobs milestone: extracted ExecutionsModule; added shared successful-creation quotas, atomic global active admission, persisted queue deadlines, bounded multi-instance expiry maintenance, safe failure codes, immutable request/version and terminal facts, SQL state-graph/terminal consistency checks, outbox uniqueness/references, and matching history/expiry indexes. Verified the new migration on the existing test database and all five migrations plus repeatable seed on a fresh disposable database. Schema validation, build, full typecheck and all 72 tests passed (54 PostgreSQL/API/protocol checks), including cross-instance admission races, outbox-failure rollback, cancellation/expiry races, all distinct state transitions, scheduled expiry and timestamp-tied history pagination. Dependency audit reported zero known vulnerabilities. Queue dispatch, active runner cancellation and execution remain pending.

- Queue/realtime milestone: added ID-only BullMQ outbox dispatch with expiring dispatch claims, conditional token acquisition/acknowledgements, bounded backoff and durable Redis-loss reconciliation; PostgreSQL worker leases, attempt fencing, heartbeats, cancellation requests/cleanup acknowledgement and bounded abandoned-job recovery; authenticated owner-authorized Socket.IO subscriptions, two-gateway delivery, session revocation/expiry checks, strict public events, pinned-public-case validation and bounded replay with snapshot fallback. Added Redis to local Compose and CI, stage 5 setup/protocol documentation, updated queue/realtime learning chapters and three new detailed concept chapters (67 total). Verified the upgrade from five migrations on the existing test database, all six migrations on a fresh disposable database, and repeatable seeding; schema, build, full typecheck and all 99 tests passed (81 real service/API/protocol checks, 18 unit checks). Dependency audit reported zero known vulnerabilities. Workers use an explicit static test backend, not an isolated runner. Compose, hosted CI, real provider integration and production load tests remain unverified. Next: stage 6 isolated execution.
