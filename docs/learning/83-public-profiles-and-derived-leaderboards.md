# Public profiles and deterministic leaderboards

Profiles look simple because the screen contains familiar fields: a name, biography, website, statistics, and recent activity. The difficult part is deciding which facts may cross the public boundary, how editable identity differs from authentication identity, and how aggregate queries remain correct as data grows. ArenaCore treats the profile as a deliberately constructed public projection rather than returning a database user row.

## Three identities that must not be confused

The database user has an immutable UUID. This is the primary key used by sessions, executions, audit events, and foreign keys. It is stable even when every human-facing field changes.

The OIDC identity is the pair of provider issuer and subject. It proves which external account signed in. Those values are authentication internals. A public profile never needs them, so exposing them would add correlation and privacy risk without helping the product.

The username is an editable public locator. It is unique, normalized to lowercase, and limited to a conservative alphabet. It may change, so internal relations must never use it as a foreign key. Routes can resolve `/profiles/:username` to the immutable UUID and then perform all joins with that UUID.

This separation gives each identifier one job:

- UUID: durable internal identity and relational integrity.
- issuer plus subject: authentication and account reconciliation.
- username: public discovery and presentation.

The migration backfills existing users with a collision-resistant value derived from their UUID and gives new rows a database-generated default. The unique index is the final concurrency authority. Two requests may both observe that a name appears free, but only one transaction can commit it. The service maps Prisma's unique-constraint error to a stable `409 USERNAME_TAKEN` response.

## Validation belongs at several boundaries

`updateProfileSchema` rejects unknown properties and bounds every editable value. A strict object prevents a browser from smuggling fields such as `role`, `issuer`, or `subject` into the update. The service then builds a new `data` object containing only the permitted fields; it never spreads the request body into Prisma.

The database repeats the durable length and username-format constraints. Application validation produces helpful errors, while database constraints protect data written by every future process, maintenance script, or application version.

Website values accept only `http:` and `https:` URLs. A syntactically valid URL can still have a dangerous scheme such as `javascript:`. The API rejects those schemes before storage, and the frontend runtime validator rejects them again before rendering an anchor. The browser check is valuable defense in depth, but it does not replace server validation.

`SessionGuard` performs more than authentication for `PATCH /profiles/me`. For a non-safe HTTP method it also compares the exact `Origin` and validates the session-derived CSRF token. The update and its `PROFILE_UPDATE` audit event commit in one transaction, so an accepted change cannot exist without its audit record.

## A public projection is an allowlist

The profile service selects only public user columns and constructs a `PublicProfile`. It does not serialize the Prisma user object. That distinction matters as the user table grows: adding an email, moderation flag, provider claim, or recovery field cannot accidentally make it public.

Recent submissions reuse the safe `SubmissionSummary` shape. They contain the problem identity/title, language, state, aggregate verdict, timestamps, and bounded aggregate metrics. They exclude source code, hidden inputs, expected answers, actual hidden output, worker observations, and private diagnostics.

The public response therefore follows an allowlist rule:

```text
database rows + execution facts
        │
        ├─ explicit aggregate queries
        ├─ explicit selected columns
        └─ explicit DTO construction
                    │
                    ▼
             PublicProfile
```

This is safer than starting with a full object and deleting known secrets. A denylist eventually misses a new sensitive field.

## Deriving statistics from authoritative events

Only executions with `mode = 'SUBMIT'` contribute to profile and leaderboard totals. A Run is an interactive check against public cases; counting it would let practice clicks distort competitive statistics. A solved problem is a distinct problem with at least one accepted Submit, even if the learner accepted several versions or resubmitted many times.

The service computes language totals and accepted totals separately, then joins those small result sets in memory. Difficulty statistics distinguish the currently published catalog from historical attempts: the denominator is the current published set, while a solved problem is credited through its stable problem identity.

Daily contributions use UTC day boundaries. A distributed backend must pick one canonical boundary; otherwise the same timestamp moves between dates depending on server or viewer timezone. The contribution query returns only active days. The frontend expands that sparse series into a 365-cell grid, which keeps the API payload proportional to activity instead of always returning 365 objects.

The streak algorithm sorts unique active UTC dates. Consecutive dates differ by exactly one UTC day. A current streak remains active when the last submission occurred today or yesterday, allowing a learner to continue it during the current day. Older runs still contribute to the longest streak but yield a current streak of zero.

## Stable ranking and cursor pagination

The leaderboard first aggregates each participating user, then applies this total order:

1. distinct solved problems descending;
2. accepted submissions descending;
3. username ascending;
4. immutable user UUID ascending.

The last two keys are essential. Without a total order, equal scores could exchange positions between requests, producing duplicate or missing rows across pages. `row_number()` assigns the visible rank from that order. The API fetches one row beyond the page size to decide whether another page exists and returns the last emitted user ID as an opaque cursor.

The client does not decode or invent cursors. It returns the value to the API and deduplicates appended rows by username as a defensive rendering measure. The database remains responsible for ordering and page boundaries.

This initial leaderboard is recalculated from authoritative rows on each request and uses a short public cache lifetime. That is a clear, correct starting point. At larger scale, a materialized aggregate or ranking table may be needed, but it must be updated from durable execution outcomes and preserve the same deterministic order.

## NestJS responsibilities in this feature

`ProfilesModule` groups the controller and service and imports the database and authentication modules. NestJS dependency injection supplies a single configured `Database` provider and the `SessionGuard`; constructors declare dependencies instead of creating global clients themselves.

`ProfilesController` owns HTTP concerns: route shapes, parameter/query/body validation, guards, and cache headers. `Profiles` owns application and query logic: public projection, aggregation, update transaction, conflict mapping, and pagination. Keeping controllers thin makes the service testable and prevents transport details from spreading into data logic.

The public GET routes intentionally have short cache headers. `GET /profiles/me` and `PATCH /profiles/me` use `no-store` because they are session-bound. This distinction is expressed at the controller boundary where HTTP caching semantics belong.

## Failure cases to reason about

- Two users request the same username simultaneously. The unique index selects one winner; the loser receives `409`.
- A malicious client includes `role: "ADMIN"`. Strict schema validation rejects the whole body.
- A stored website uses `javascript:`. Server validation rejects writes, and frontend validation refuses a compromised response.
- A learner submits the same accepted solution repeatedly. Accepted-submission count rises, but distinct solved-problem count does not.
- Two learners have identical scores and names. Immutable UUID ordering still produces one stable order.
- A username changes between leaderboard pages. Recalculated public rankings can shift; the opaque UUID cursor still identifies the boundary user. At high write volume, snapshot pagination or precomputed ranking would be the next consistency improvement.
- The identity provider changes the display name. ArenaCore's local editable profile remains a product-level identity; authentication linkage continues through issuer and subject.

## Exercises

1. Why should the public route resolve a username and then join executions by UUID? Because username is mutable presentation data, while the UUID preserves relational identity.
2. Why is a unique preflight query insufficient? Two transactions can pass it before either commits; only the database unique constraint serializes the conflict.
3. Why count distinct problem IDs instead of accepted executions? The product question is how many problems were solved, not how many accepted attempts were made.
4. Why validate successful API responses in the frontend? TypeScript types vanish at runtime, and a broken or compromised server response still crosses an untrusted network boundary.
5. What must happen before adding email to a profile? Define an explicit privacy/product requirement and deliberately add it to the public DTO; a schema migration alone must never expose it.
