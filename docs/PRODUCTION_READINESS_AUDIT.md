# ArenaCore production readiness audit

This file tracks the end-to-end completion audit. A feature is complete only when its database model, backend rules, authorization, frontend workflow, failure states, and relevant automated tests are all present.

## Verified foundations

- Durable PostgreSQL execution records, idempotent admission, transactional outbox, leases, fencing, cancellation, recovery, and safe public projections.
- Dedicated gVisor runner with pinned runtime images, filesystem/network/process/resource isolation, cleanup verification, and host acceptance scripts.
- Native password, Auth0/OIDC, Google OIDC, and GitHub OAuth sign-in with server sessions, CSRF protection, exact-origin CORS, database-owned roles, and bounded login attempts.
- Published immutable problem versions, public/hidden test cases, STDIN and file input modes, language templates, judging, submissions, and realtime replay.
- Public profiles, derived statistics, leaderboard, discussions, competitions, organizer controls, and administrator problem/competition lifecycle actions.
- Application/runner deployment automation, encrypted off-host backups, restore drill, and separate network boundaries.
- Account self-service: avatar URL, profile privacy, persisted theme and notification preferences, native email/password changes, active-session revocation, and anonymizing deactivation.
- Moderation foundation: distinct moderator authorization, user discussion reports, ownership-safe report history, required review notes, resolution audit records, timed suspensions, bans, session revocation, and centralized restriction enforcement.
- Production frontend paths: mock sessions/data/executions are removed; admin analytics use bounded database aggregates with CSV export; unsupported decorative admin settings/invitation forms redirect to working account and user management screens.

## Remaining production work

### P0 — authorization and moderation

- Add frontend pagination controls for the already bounded administrator user search/filter API and expose resolution history to staff.
- Add bulk moderation only after individual state transitions and audit invariants are tested.

### P0 — remove prototype paths

- Audit every visible button and navigation target using browser end-to-end tests.

### P1 — user engagement

- Add a persisted notification model, unread counts, notification center, read state, and competition/execution event producers. Respect the stored notification preferences.
- Add bookmarks for problems and a personal dashboard with recent activity, registered events, upcoming rounds, and saved problems.
- Add bounded global search across published problems, public users, and published competitions.
- Add report/block controls to the profile and discussion UI after moderation APIs exist.

### P1 — UX and accessibility

- Add route-level loading/error boundaries and consistent toast/confirmation components in place of browser `alert` and `confirm` calls.
- Verify keyboard navigation, focus restoration, labels, contrast, reduced motion, mobile navigation, and responsive tables.
- Add session-expiration handling that returns users to sign-in while preserving safe local drafts.
- Add empty-state actions and pagination to every administrator list.

### P1 — operations and performance

- Complete backup-failure and backup-staleness alerts and retain a timed recovery record.
- Run production rollback, capacity, queue saturation, reconnect, and abuse-rate load drills.
- Add production telemetry for API latency/error rate, queue depth/age, worker availability, judging duration, backup age, and database capacity.
- Review query plans and add indexes for the final moderation, notification, bookmark, and search queries.

### Final release gate

- Run all PostgreSQL and Redis suites together, the dedicated-host gVisor suite, live judging acceptance, frontend tests/build, and browser end-to-end role workflows.
- Verify every environment variable, migration order, deployment rollback, backup restore, and secret boundary from clean infrastructure.
- Confirm no production bundle or reachable route contains mock data, placeholder behavior, debug output, or an unfinished action.
