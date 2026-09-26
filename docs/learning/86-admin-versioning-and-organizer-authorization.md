# Problem versioning and competition organizer authorization

ArenaCore separates platform administration from event ownership. An administrator controls global publication and deletion. A competition owner receives authority only over the event they created. Both checks happen in the API from the authenticated session; the browser never grants a role to itself.

## Editing a problem creates a version

A published problem version may already be referenced by executions. Updating that row would change the meaning of historical submissions and could make a previously correct verdict impossible to reproduce. The edit endpoint therefore creates a new `ProblemVersion` and a new test suite.

Saving an edit as a draft leaves `Problem.currentVersionId` pointing at the old published version. Learners keep seeing the stable version while the administrator reviews the draft. Publishing moves `currentVersionId` to the new immutable version. Unpublishing clears the pointer; it does not mutate or destroy historical versions.

The administration list intentionally shows the newest version. Its published status is true only when that exact version is the current public version. This distinction prevents an old public version from hiding a newer draft in the console.

Deletion is narrower than unpublication. A problem can be physically deleted only when it has never been published and no competition or execution references it. Otherwise the API returns a conflict and the administrator must unpublish it. This retains the records required to explain historical results.

## Competition ownership

`Competition.ownerId` records the user who created a community event. Organizer endpoints load the competition and then require one of these conditions:

- the session user matches `ownerId`; or
- the session role is `ADMIN`.

The organizer can view registrations, competition submissions, and the event leaderboard. Submission projections omit source code and private judge diagnostics. An unrelated signed-in user receives a forbidden response even if they know the competition slug.

## Why structural editing closes at start time

Changing rounds, problems, or the schedule during an active event would change scoring after competitors have started. The API accepts structural updates only while the existing event and its replacement schedule are still in the future. The owner can continue reading registrations, submissions, and rankings after the start.

Administrators can publish or unpublish any competition. Physical deletion succeeds only when no competition execution references its rounds. Once submission history exists, unpublication is the safe removal mechanism.

## Step-based authoring

Problem creation and editing share one five-step component: basics, statement, starter templates, judge tests, and review. Administrator and community competition creation use details, schedule, searchable problem selection, and review steps. A step validates its own inputs before advancing, while the API and database remain the authoritative validation boundaries.

The searchable picker reads only published problems from the public problem catalog. Selection uses stable problem IDs in the browser and sends slugs that the server resolves again inside its own trusted database query.

## Security evidence

Integration tests prove that another user cannot open an organizer workspace, the owner can inspect safe registration and submission projections, the owner can edit before start, and managed leaderboards remain available through an authenticated route. Admin tests cover immutable version creation, publication pointers, unpublication, and deletion conflicts for historical content.
