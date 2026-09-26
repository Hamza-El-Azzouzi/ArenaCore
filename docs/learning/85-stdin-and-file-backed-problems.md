# Standard input and file-backed problems

ArenaCore treats a problem's input source as part of its immutable judge contract. A published problem version declares `STDIN` or `FILES`; the choice is never inferred from learner source code and cannot be selected by an execution request.

## Why the input mode belongs to `ProblemVersion`

Changing from standard input to `input.txt` changes how every accepted solution must read data. That is a compatibility-breaking problem change, just like changing a constraint, time limit, or expected answer. `ProblemVersion.inputMode` therefore travels with the version snapshot used by an execution. Existing rows default to `STDIN`, so the migration preserves deployed exercises.

Difficulty is stored on the same version. The public catalog and profiles can safely expose it, while an administrator chooses it explicitly when authoring the problem.

## Why files belong to each test case

A file-based problem can supply different content for every public and hidden case, and some problems need more than one file. `TestCaseFile` uses `(testCaseId, name)` as its primary key. This prevents duplicate names in one case without preventing another case from using that name with different content.

The database relationship uses `ON DELETE CASCADE` from a test case to its files. Published test cases and files remain immutable through database triggers. A publish-time trigger rejects inconsistent contracts:

- a `STDIN` version cannot have test files;
- every case in a `FILES` version must have empty stdin and at least one file.

The API performs the same checks before starting the transaction. The database check is a second boundary for maintenance scripts or future code paths that bypass the HTTP validator.

## Filename policy

Archive extraction turns names into paths. ArenaCore accepts only a single relative filename containing letters, digits, `.`, `_`, or `-`. Absolute paths, directory separators, `..`, Java class files, and runtime source names are rejected. This prevents traversal and prevents a test file from replacing `solution.py`, `solution.js`, `Solution.java`, or `Solution.class`.

Individual contents and the combined request have byte limits. Limits use bytes because the sandbox receives UTF-8 bytes; character counts alone undercount multibyte text.

## Trusted data flow

1. The administrator creates a version with an input mode, language templates, and public/hidden cases.
2. `loadJudgePlan()` reads the pinned published version and only the cases selected for Run or Submit.
3. The worker constructs a strict `SandboxRequest`. The browser cannot add filenames, images, commands, or paths to it.
4. The supervisor validates the request again.
5. For each case, the supervisor creates a new gVisor container with a fresh `/work` tmpfs.
6. It extracts the trusted program archive, then a second bounded archive containing that case's validated files.
7. It executes the fixed language command. Stdin is a separate byte stream and is empty for `FILES` problems.
8. The container is force-removed and absence is verified before the next case.

No host directory is mounted. The root filesystem stays read-only, the guest has no network, and case files disappear with the per-case tmpfs. Java compilation happens before case files are introduced, so input files cannot influence compiler artifact collection.

## Public and hidden projections

The public problem endpoint selects only `PUBLIC` test cases. For those examples it returns the declared filenames and contents so learners understand the contract. Hidden filenames and contents are not selected by the public query and therefore cannot enter its DTO. Submit observations remain private under the existing judging projection rules.

## Language starters

The admin editor generates a starting point for every supported language:

- Python uses `sys.stdin.read()` or `Path("input.txt").read_text()`.
- JavaScript uses `readFileSync(0, "utf8")` or `readFileSync("input.txt", "utf8")`.
- Java uses `System.in` or `Files.readString(Path.of("input.txt"))`.

The administrator can edit each template. Regeneration is explicit because silently replacing an edited template would discard authored code.

## Evidence and remaining host gate

Unit tests reject traversal, reserved names, duplicates, oversized inputs, and command-line exposure. Database integration checks publish a real file problem, verify that its public file is returned, prove the hidden file is absent, and verify published file immutability. The dedicated-host suite contains real Python, JavaScript, and Java file-reading cases plus a cross-case cleanup check.

The dedicated gVisor tests must run on the runner after deploying this release. Ordinary CI cannot claim that host tmpfs and gVisor behavior passed because it lacks that runtime.
