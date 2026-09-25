# Moderated discussions and idempotent reactions

A discussion feature accepts persistent content from untrusted users and publishes it to other users. ArenaCore separates public reads, authenticated writes, moderation state, rate limiting, audit evidence, and reaction semantics so each boundary can be reasoned about independently.

## Model conversations without recursive chaos

`DiscussionPost` represents both a root thread and a reply. A root has a bounded title and a null `parentId`; a reply has a parent and no title. The database check constraint enforces that shape even if data is written outside NestJS. The service only accepts replies to root posts, producing one level of nesting. This keeps queries, rendering, moderation and pagination predictable while still supporting conversation.

Posts reference the stable `Problem` row instead of one published version. A discussion survives a statement revision and remains attached to the same conceptual exercise. Authors are joined by immutable user UUID, while the public projection exposes only username and display name.

The self-relation uses `ON DELETE CASCADE`, so removing a root removes its replies. Ordinary moderation should change `status` rather than delete rows. `VISIBLE`, `HIDDEN`, and `DELETED` let public queries exclude content while preserving records for a future reviewed moderation workflow.

## Public reads are explicit projections

List queries filter on a published current problem, a null parent for roots, and `VISIBLE` status. Reply queries require a visible root and return only visible direct children. They select author display fields and aggregate counts, then construct a `DiscussionPost` DTO. Provider subjects, roles, sessions, audit records, and moderation details never cross the public boundary.

The frontend repeats structural validation because TypeScript cannot verify network data at runtime. UUIDs, normalized usernames, timestamp syntax, maximum content lengths, and nonnegative counts must all be valid before React stores or renders a response. React text nodes escape the body; no raw HTML rendering path exists.

## Authenticated mutations and CSRF

Public reading does not require a session. Creating a thread, replying, liking, and unliking use `SessionGuard`. For unsafe HTTP methods the guard also requires the configured exact `Origin` and the session-derived CSRF token. Request schemas are strict, so unknown properties cannot smuggle author, status, count, or problem identifiers into service writes.

Creation and its audit event share one database transaction. Either both commit or both roll back. This is stronger than logging after the response: a process crash cannot leave published content without its creation evidence.

## Why reactions use PUT and DELETE

A toggle endpoint means “invert whatever state exists now.” If its response is lost, retrying inverts a second time and produces the opposite result. ArenaCore expresses the desired final state instead:

- `PUT /discussions/:id/like` means the like must exist.
- `DELETE /discussions/:id/like` means the like must not exist.

The composite primary key `(postId, userId)` makes duplicate likes impossible. `PUT` uses an upsert and `DELETE` uses `deleteMany`, so both operations are safe to repeat. The service counts likes inside the same transaction and returns the authoritative result.

## A rate limit shared by every API replica

An in-memory counter protects only one process. Requests can alternate between replicas or reset when a process restarts. `DiscussionRateLimit` stores one counter and expiry per user in PostgreSQL. An atomic `INSERT ... ON CONFLICT DO UPDATE` either starts a new minute window or increments the current count.

The check runs inside the post-creation transaction. When the count exceeds ten, the service throws `429 DISCUSSION_RATE_LIMITED`; the transaction rolls back, including the counter increment and attempted post. The stored row remains at the limit until expiry. `Retry-After: 60` gives clients a bounded recovery hint without exposing database details.

This quota bounds creation pressure. Idempotent likes cannot create more than one row per user/post. A larger community would add global/IP abuse controls, automated signals, moderator queues, appeals, and retention policy, but those should extend the same durable state model rather than bypass it.

## Pagination needs a total order

Roots sort by creation time descending and UUID descending; replies sort ascending by the same pair. The unique UUID tie breaker makes each order total when timestamps match. Cursors are UUIDs for existing visible rows and are validated in the scope being paginated. A cursor from another problem or thread is rejected instead of silently shifting the result set.

The API reads one extra row. It emits at most twenty and returns the last emitted ID only when the extra row proves another page exists. The browser treats that value as opaque and deduplicates appended IDs as a rendering safeguard.

## NestJS structure

`DiscussionsModule` imports the database and authentication modules, registers the controller, and provides the service. The controller owns HTTP paths, validation, guards and cache headers. The service owns publication rules, transactions, quota consumption, projection and pagination. Dependency injection supplies the shared Prisma-backed `Database` rather than constructing clients in request handlers.

Public GET responses have short cache lifetimes. Mutation responses use session authorization and are never treated as cached public state. This controller-level distinction keeps transport policy visible beside each route.

## Failure cases and exercises

1. A POST response is lost. Retrying thread creation can duplicate content because creation lacks an idempotency key; the UI currently does not retry it automatically. Adding client-generated creation keys would be the next durability improvement.
2. A like response is lost. Repeating PUT converges on one like because the composite key and upsert are idempotent.
3. A client sends `status: "VISIBLE"`. Strict schema validation rejects the body; clients cannot self-moderate.
4. Eleven writes hit two API replicas in one minute. The PostgreSQL row serializes the shared counter and the eleventh returns 429.
5. A root becomes hidden. Public root queries exclude it, and the reply endpoint first requires a visible root, so its replies cannot be fetched through that route.
6. Why retain a `DELETED` state? It supports a distinguishable tombstone/audit policy later without treating deletion and moderation as the same event.
