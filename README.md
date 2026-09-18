# ArenaCore

A browser coding IDE with a secure, separately hosted execution backend. Frontend generation is handled through v0 or Bolt; backend implementation is tracked here.

## Backend roadmap

This checklist is the shared progress tracker. A stage is complete only when its acceptance checks pass. Partial work stays unchecked.

| Stage | Work | Acceptance check | Status |
| --- | --- | --- | --- |
| 1. Foundation | TypeScript workspaces, shared contracts, NestJS bootstrap, validated configuration, structured errors, health endpoints | Build, typecheck and automated API/domain checks pass | Complete |
| 2. Persistence and problems | PostgreSQL schema/migrations, immutable problem versions, public-only problem reads, idempotent sample seed | Migrations and seed run on a real database; private tests excluded from DTOs | Complete |
| 3. Identity and authorization | OIDC + PKCE login, server sessions, logout, CSRF, expiry and owner/RBAC checks | Login/logout and cross-user/cross-origin denial tests pass | Pending |
| 4. Durable jobs | Validated Run/Submit creation, user-scoped idempotency, concurrency caps, transactional outbox, version snapshots, private history | Concurrent/retried requests and cancellation preserve state and ownership | Pending |
| 5. Queue and realtime | BullMQ dispatch, worker leases/fencing, Socket.IO auth, bounded safe replay and reconnection | Queue failure, duplicate delivery and reconnect tests pass | Pending |
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
- [Copy-ready v0 frontend prompt](docs/prompts/V0_PROMPT.md)
- [Copy-ready Bolt frontend prompt](docs/prompts/BOLT_PROMPT.md)

Use either prompt for the initial UI, export it into `apps/web`, and retain one frontend codebase. Demo results are simulated; actual judging belongs to the isolated backend.

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
- `GET /me` (anonymous returns `{user: null}`)
- `POST /auth/logout` (session + Origin + CSRF required)
- `POST /executions`, `GET /executions/:id`, `POST /executions/:id/cancel`
- `GET /submissions`

The last four routes require an unexpired server-side session. `GET /auth/login` reports that identity is not yet configured; there is no demo authentication bypass. Execution creation is disabled by default. The job/outbox baseline can be exercised by integration tests, but no queue consumer or runner exists yet. Cancellation currently handles queued jobs only; active sandbox cancellation belongs to stage 5/6. Socket.IO delivery is not implemented yet.

For the frontend, proxy `/api/v1` to the API under the same browser origin. Cross-origin API access is intentionally not enabled. Production also requires TLS termination at a reverse proxy and a valid HTTPS `PUBLIC_ORIGIN`.

## Verification

```sh
npm run check
```

This validates the schema, compiles the workspaces, typechecks tests/seed/config, and runs tests. Database integration tests are skipped unless `TEST_DATABASE_URL` is explicitly set; an ordinary unit-only run does not verify the database.

For integration checks, provision a **disposable** PostgreSQL database, migrate it using `DATABASE_URL`, then run:

```sh
TEST_DATABASE_URL=postgresql://user:password@localhost:5432/arenacore_test npm run check
```

Integration tests create temporary users/sessions/executions and seed the sample problem. They never reset an existing database; still use a dedicated test database. `.github/workflows/backend.yml` provisions PostgreSQL and runs these checks plus the dependency audit in CI. The workflow has been added but its hosted execution has not been observed yet.

## Current milestone and next work

Foundation and the persistence/problem baseline are implemented. Session validation and the durable job API baseline are present, while their complete roadmap stages remain pending. The sample includes public and hidden test data for judging development; the public problem API queries public examples only.

Next: implement managed OIDC login with state/nonce/PKCE and session issuance, test the complete login/logout flow, then add outbox dispatch, queue leases and authenticated realtime updates. Execution stays off until runner isolation and judging pass their launch checks.

## Implementation log

- Backend start: roadmap recorded before implementation. Added workspaces, shared schemas, NestJS API, validated configuration, structured safe errors, PostgreSQL models/migrations, immutable published versions/test suites, repeatable seed, session/CSRF validation, owner-filtered jobs/history, concurrency-safe idempotency and atomic outbox creation. Added local PostgreSQL Compose and CI checks. Verified: both migrations applied to temporary PostgreSQL; seed ran twice; schema validation, build and full typecheck passed; all 22 tests passed, including 12 real database/API integration checks. Dependency audit reported zero known vulnerabilities. Compose and the hosted CI workflow have not been run.
