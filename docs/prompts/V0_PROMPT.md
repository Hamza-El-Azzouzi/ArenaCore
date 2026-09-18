# ArenaCore prompt for v0

Copy everything below this line into v0. Each prompt is standalone; use one tool to generate the initial frontend, then keep one exported codebase as the source of truth.

---

Generate the following application as an exportable Next.js frontend. Prioritize the coding workspace and consistent reusable components.

Build ArenaCore, a polished browser coding practice IDE. Deliver a working FRONTEND with deterministic mock adapters. Backend implementation belongs to a separate engineering workflow. Do not implement an execution server, database, authentication server, Docker integration, hidden tests, or Next.js API routes. Never execute submitted source in the browser with eval, Function, workers, or a third-party execution API.

TECHNOLOGY
Use Next.js App Router with TypeScript, Tailwind CSS, shadcn/ui, lucide-react, @monaco-editor/react and socket.io-client. Use a compatible maintained React resizable panel library with keyboard-accessible handles. Pin compatible dependencies and include a lockfile. Monaco must load in a client component without SSR; use real Monaco with syntax highlighting, line numbers, basic language completion and editor themes. Do not replace it with a textarea. Java completion need not emulate a full language server. Configure Monaco workers and test the production build. Use a system font stack; avoid external font downloads as a build requirement.

PRODUCT AND VISUAL DESIGN
Create a professional coding workspace inspired by the usability of HackerRank/LeetCode, with original ArenaCore branding. Calm dark charcoal/slate background, subtle borders, restrained emerald primary actions, readable contrast, small radius, and a compact developer-tool layout. Add a fully working light theme. No marketing hero, oversized cards, decorative charts, stock photos, AI assistant, pricing or invented product features.

ROUTES
1. / redirects to /problems.
2. /problems: searchable catalog with difficulty filter, title, tags, difficulty and link to each workspace. Show success rate only when data provides it. Search/filter must work with fixtures; include loading, empty and error states.
3. /problems/[slug]: main IDE workspace.
4. /submissions: private history with problem title, language, verdict, timestamp and optional metrics; paginated and filterable by problem. Show sign-in required when unauthenticated.
5. /sign-in: concise sign-in screen. In real mode navigate to /api/v1/auth/login; mock mode may explicitly offer "Enter demo". Do not collect passwords or claim real authentication in demo mode.

DESKTOP WORKSPACE
Compact top navigation: ArenaCore wordmark, Problems, Submissions, theme control, demo/account menu and connection indicator. Left pane roughly 42% width; right pane roughly 58%; independent scrolling and draggable accessible divider. Fill available viewport height without accidental document overflow.

Left pane: title, Easy/Medium/Hard badge, optional success rate, Description and My Submissions tabs. Safely render Markdown description with constraints, time/memory limits and visible Input/Expected Output examples. Disable arbitrary HTML. My Submissions uses this problem's history and can open safe detail views.

Right pane: Java/Python/JavaScript selector, readable runtime label when provided, light/dark theme control, and Reset template action. Editor occupies available height. Footer action bar includes Run Code, Submit and Cancel when a job is active, plus a concise status. Bottom-right resizable/collapsible console drawer includes Test Results and Console tabs, clear/copy output controls, timestamped status if useful, exit codes and execution metrics when supplied. Console is a text output viewer, not an interactive shell. Keep unread output indication when auto-scroll is paused.

Run evaluates visible cases and can show stdout/stderr, expected vs actual output and individual public case results. Submit evaluates private tests on the backend: show queued/compiling/running progress and an aggregate verdict; never display hidden input, expected output, actual output, hidden diagnostics or hidden case rows. Do not simulate hidden-test data in fixtures. Display compiler diagnostics only when explicitly provided by the adapter as safe diagnostics.

MOBILE AND ACCESSIBILITY
At narrow widths switch to Problem/Code/Results tabs; editor remains usable, actions remain reachable and there is no horizontal page overflow. Use appropriate minimum pane sizes on desktop. All icons have accessible names; controls support keyboard focus; resizers support keyboard operation; dialog focus is managed. Verdicts use text/icons as well as color. Use polite live announcements for status changes, not every output chunk. Respect reduced motion.

EDITOR BEHAVIOR
Use valid starter templates for Java Solution.main, Python stdin/stdout and Node stdin/stdout. Problem convention is standalone stdin/stdout programs with no external libraries. Primary fixture: "Sum Two Numbers", input "2 3", expected output "5", a precise matching statement and constraints. Include at least two other public catalog fixtures. All templates should teach input/output shape without supplying the entire solution.

Maintain drafts per problem and language; debounce local draft persistence and show "Saved on this device", never "Saved to cloud". Draft storage may contain code only, never credentials. Warn before reset or replacing a modified draft on problem navigation; language switching preserves each language's draft. Reset uses a confirmation dialog. Theme preference persists. Run shortcut Ctrl/Cmd+Enter and Submit Ctrl/Cmd+Shift+Enter must work without silently executing code locally.

During an active job disable duplicate Run/Submit and changing the job language; retain the submitted code snapshot even if editing continues. Each output stream belongs to its execution ID. Clear previous display deliberately when starting a new job, and ignore late events from old jobs. Cancellation is idempotent. A disconnect shows "Reconnecting" and preserves the editor/results; it never invents a verdict or starts another job.

COMPONENTS AND SEPARATION
Use components such as ProblemCatalog, ProblemHeader, ProblemStatement, WorkspaceLayout, EditorToolbar, CodeEditor, ExecutionActions, ConsoleDrawer, PublicTestResults, VerdictBanner, SubmissionHistory and ConnectionStatus. Keep reusable tokens and components so later UI edits do not require rewriting transport code.

Create typed frontend contracts, an ArenaCoreClient interface, a mock implementation and a real REST/Socket.IO implementation. Components consume the interface through a provider/hook; no fetch/socket calls scattered through components. NEXT_PUBLIC_USE_MOCK_API=true selects mocks; false selects real endpoints. NEXT_PUBLIC_API_BASE_URL defaults to /api/v1; NEXT_PUBLIC_SOCKET_ORIGIN may be omitted for same-origin. Only public config goes in NEXT_PUBLIC variables. Include .env.example without secrets.

CONTRACT TO IMPLEMENT
Language = 'java' | 'python' | 'javascript'. Mode = 'RUN' | 'SUBMIT'.
ExecutionState = 'QUEUED' | 'COMPILING' | 'RUNNING' | 'FINISHED' | 'CANCELLED' | 'INTERNAL_ERROR'.
Verdict = 'ACCEPTED' | 'WRONG_ANSWER' | 'COMPILATION_ERROR' | 'RUNTIME_ERROR' | 'TIME_LIMIT_EXCEEDED' | 'MEMORY_LIMIT_EXCEEDED' | 'OUTPUT_LIMIT_EXCEEDED' | 'CANCELLED' | 'INTERNAL_ERROR'.
ProblemSummary = {id, slug, title, difficulty: 'EASY'|'MEDIUM'|'HARD', tags: string[], successRate?: number}.
ProblemDetail extends ProblemSummary with {statementMarkdown, constraints: string[], limits: {timeMs, memoryKiB}, examples: {id, input, expectedOutput}[], templates: Record<Language,string>, runtimeLabels?: Partial<Record<Language,string>>}.
PublicCaseResult = {caseId, verdict, stdout?, stderr?, exitCode?, runtimeMs?, memoryKiB?}.
ExecutionSnapshot = {executionId, problemId, language, mode, state, attempt: number, lastSequence: number, verdict?, runtimeMs?, memoryKiB?, publicCaseResults?: PublicCaseResult[], compilerDiagnostics?: string}.
SubmissionSummary = {executionId, problemId, problemTitle, language, state, verdict?, createdAt, runtimeMs?, memoryKiB?}.
Use IDs and timestamps as strings; sequence/attempt/metrics are numbers; optional metrics are omitted, not synthesized as zero. SuccessRate is a percentage from 0 to 100.

REST, cookie credentials included:
- GET /me -> {user: {id, displayName, avatarUrl?} | null, csrfToken?}.
- GET /problems?difficulty=&search=&cursor= -> {items: ProblemSummary[], nextCursor: string | null}.
- GET /problems/:slug -> ProblemDetail.
- POST /executions with X-CSRF-Token and Idempotency-Key -> HTTP 202 {executionId, state: 'QUEUED'}; body {problemId, language, mode, sourceCode}.
- GET /executions/:id -> ExecutionSnapshot.
- POST /executions/:id/cancel with X-CSRF-Token -> {executionId, state}.
- GET /submissions?problemId=&cursor= -> {items: SubmissionSummary[], nextCursor: string | null}.
- POST /auth/logout with X-CSRF-Token; navigate to sign-in after success.
Errors: {error: {code, message, requestId, retryAfterSeconds?}}. Support 401 sign-in required, 403 permission denied, 404 unavailable, 413 source too large, 429 retry guidance and 503 temporarily unavailable. Source size limit is 64 KiB UTF-8; enforce via byte length, not JavaScript character count. Backend remains authoritative.

Socket.IO namespace /executions; transport path /socket.io; withCredentials enabled. Subscribe with execution:subscribe {executionId, afterSequence?, attempt?}; ack is {ok:true,replayAvailable:boolean} or {ok:false,error:{code,message}}.
Listen for:
- execution_status {executionId, attempt, sequence, state}.
- console_output {executionId, attempt, sequence, stream:'stdout'|'stderr', text}; RUN only.
- final_verdict {executionId, attempt, sequence, verdict, runtimeMs?, memoryKiB?, publicCaseResults?}.

Use REST to create jobs, sockets for updates, and REST snapshots on reconnect. Create one idempotency key per user action and reuse it for a retry of that same request. Never auto-create a new execution on reconnect. Check executionId, current attempt and sequence; deduplicate events and prevent stale events from changing terminal state. On replay expiration show an honest output-unavailable message while recovering final state. If disconnected, retrieve bounded REST snapshots with cleanup/backoff. Unsubscribe/remove listeners on component unmount; do not cancel a job automatically. Keep socket connection alive between runs. Never implement authorization decisions by trusting only the UI.

SAFETY AND MOCKS
Render terminal strings as text, never HTML; strip dangerous terminal control characters and cap retained output at 256 KiB. Display truncation notices and keep the UI responsive. Sanitize Markdown; no dangerouslySetInnerHTML for code/output. No hidden tests, cloud credentials, Docker socket, runtime commands or authentication tokens in frontend code.

Mock execution is a deterministic event simulator, not a code interpreter. Display a persistent subtle "Demo mode — simulated results" indicator. Simulate the chosen scenario independently of source and do not imply the submitted code was evaluated. Provide a development demo-scenario control covering accepted, wrong answer, compilation error, runtime error, time limit, memory limit, output limit, cancellation, queue delay, API failure and disconnect/reconnect. A mock Run streams public-only output chunks; mock Submit sends progress then aggregate verdict with no hidden output. Mock cancellation stops timers; reconnect does not duplicate jobs. History updates after mock Submit. Mock sign-in/out changes only demo identity and must be labeled as simulated.

DELIVERY AND VALIDATION
Provide complete source, working routes, reusable components, adapters, fixtures, .env.example, lockfile and a README describing setup, mock mode, real integration, Monaco worker configuration and known limitations. No placeholder buttons: every visible action works or is explicitly disabled with an explanation. Never claim the backend, security or deployment is complete. Run available TypeScript/lint/production-build checks and fix failures; report checks actually run and any environment limitations. Add a short manual verification checklist for keyboard/mobile layout, reset/drafts, Run, Submit privacy, cancellation and reconnect. Keep the solution straightforward and editable.
