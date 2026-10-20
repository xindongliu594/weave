# Task 1 implementer report

Baseline supplied by controller: `3eaac81`. Scope is the private archive writer fence primitive only. No production entry imports it; no writer lifecycle, restore authorization, source completeness or deployment claim is made. Package manifests/lock files belong to the controller and were not edited by this implementer. No Git, network, JJ, model, credentials, SQL or production commands were run.

## Files and API

- `services/agent-runtime/archive-write-fence.mjs`
- `services/agent-runtime/archive-write-fence.d.mts`
- `services/agent-runtime/archive-write-fence.test.mjs`
- `services/agent-runtime/test-helpers/archive-write-fence-child.mjs`

`createArchiveWriteFence({ traceRoot, lockRoot })` returns a frozen factory with:

```text
acquireWriter(runIds, { signal?, timeoutMs? }?) -> Promise<Guard>
acquireSource(runId, { signal?, timeoutMs? }?) -> Promise<Guard>
acquireMaintenance(runIds, { signal?, timeoutMs? }?) -> Promise<Guard>
acquireRootExclusive({ signal?, timeoutMs? }?) -> Promise<Guard>
assertGuard(guard, { mode, runId? }) -> void
withJournalAppendSync(guard, runId, syncFn, { timeoutMs? }?) -> actual callback result
Guard.release() -> void (idempotent)
```

Modes are `writer`, `source`, `maintenance`, `root-exclusive`. Guards are frozen and WeakMap branded, scoped to the exact factory and owned original FDs; no FD/verified flag is exposed. Module errors use fixed `E_ARCHIVE_FENCE_` codes: `PATH`, `IDENTITY`, `RUNS`, `OPTIONS`, `GUARD`, `MODE`, `TIMEOUT`, `ABORTED`, `UNAVAILABLE`, `NATIVE`, `IO`, `CALLBACK`, `REENTRANT`, `BUSY`. Trusted callback exceptions propagate unchanged.

Native locking uses ordinary installed `fs-native-extensions@1.5.1`, not an injected backend. Namespace is SHA256(canonical logical trace path), case folded on Windows, under the explicit independent lockRoot. Roots/ancestors/namespace and path-to-FD dev/ino identities are checked; links, nonregular native files and nlink != 1 fail closed. Existing native files are opened without truncation. Root shared/exclusive precedes byte-sorted lifetime locks. Every acquisition shares one monotonic deadline across root/all runs. Timeout and abort roll back partial FDs in reverse order; neither expires a completed guard. Root-exclusive permits trace leaf replacement while retaining the parent/lock directory identity. Journals acquire a short exclusive native lock with monotonic retry; same journal reentry, async callbacks, thenables, uncovered/source guards and early outer guard release are rejected. Journal depth prevents nested different-run critical sections from permitting outer release.

## Verification commands and evidence

All commands ran sequentially in the root worktree. Tests use independently generated temporary directories and real child processes. Recursive cleanup verifies the exact generated directory is a single child of the real temporary root, is not a link and resolves to the captured path; fixture moves verify both endpoints remain inside it. Command output was saved with PowerShell `Tee-Object`, then `$LASTEXITCODE` and stopwatch milliseconds appended. The initial RED used buffered captured output; subsequent commands stream output.

| Log | Exact substantive command | Execution/result | Wall ms |
| --- | --- | --- | --- |
| `task-1-red.log` | `node --test services/agent-runtime/archive-write-fence.test.mjs` | restricted; exit 1; 0 pass / 15 fail; missing factory observed before implementation | 553 |
| first GREEN attempt | same command | interrupted by implementer; process exit 1; test child teardown hung after signal-based exit; buffered output was not recoverable | not available |
| `task-1-green-2.log` | same command | interrupted by implementer; process exit 1; eight passes printed; count test awaited an exit event already delivered | not available |
| `task-1-green-3.log` | same command | restricted; exit 1; 10 pass / 2 fail / 3 skip; failures are directory rename EPERM, skips link fixture EPERM | 7008 |
| `task-1-edge-red.log` | `node --test --test-name-pattern 'UUID\|nested different\|invalid roots\|one acquisition' services/agent-runtime/archive-write-fence.test.mjs` | restricted; exit 1; 1 pass / 3 fail; sparse UUID, nested journal release and null roots reproduced | 2021 |
| `task-1-edge-green.log` | same filtered command | restricted; exit 0; 4 pass / 0 fail | 2110 |
| `task-1-ordinary-green.log` | `node --test services/agent-runtime/archive-write-fence.test.mjs` | ordinary Windows; exit 1; 15 pass / 1 fail / 1 skip; native-held namespace rename EPERM, file symlink fixture EPERM | 5719 |
| `task-1-regression-sandbox.log` | `node --test services/agent-runtime/trace-append-cursor.test.mjs services/agent-runtime/journal-archive.test.mjs` | restricted; exit 1; 16 pass / 1 fail; unchanged existing hardlink fixture EPERM | 5083 |
| `task-1-final-green.log` | `node --test services/agent-runtime/archive-write-fence.test.mjs` | ordinary Windows; exit 0; **17 pass / 0 fail / 3 explicit skips** | 5872 |
| `task-1-regression-green.log` | `node --test services/agent-runtime/trace-append-cursor.test.mjs services/agent-runtime/journal-archive.test.mjs` | ordinary Windows; exit 0; **17 pass / 0 fail / 0 skip** | 3163 |
| `task-1-build.log` | `npm run build` | restricted; exit 0; project `tsc --noEmit` and Vite build passed; Vite emitted existing-size warning for a >500 kB chunk | 50434 |
| `task-1-declaration.log` | `./node_modules/.bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node services/agent-runtime/archive-write-fence.d.mts` | restricted; exit 0; explicit declaration check (service directory is outside root tsconfig include list) | 3873 |

The two interrupted attempts exposed test helper lifecycle/listener errors; helpers now attach their completion promise immediately and recognize signal-based exits. No product lock backend was mocked or weakened. Original RED, failed and skipped logs are retained.

## Verified behavior and precise limits

Verified on Windows x64 with actual processes: writer/source exclusion; shared writers from separate lifetimes; root exclusive blocks writer; holder process exit frees locks; multi-run timeout and abort release previously acquired run/root locks; one root-plus-run deadline; branded/mode/run ownership; acquired signal cancellation does not revoke a guard; sync journal exact return/exception cleanup; same-journal reentry and nested different-run early release rejection; declared async rejected before invocation; unexpected thenable rejected; journal contention timeout never invokes callback; short contention succeeds; two processes produce exact contiguous 60-entry journal count. Existing native contents survive open, nonregular/hardlinked native files fail, and directory aliases/junction roots are refused.

TraceRoot physical replacement invalidates old guards; root-exclusive trace leaf swap allows a later new valid guard. Live lifetime-file replacement also invalidates its guard on Windows. The final three skips are **unverified fixtures, not product success**:

1. Windows refuses renaming a namespace directory containing native-locked files (`EPERM`). The same rename succeeds after release.
2. Windows refuses renaming its enclosing lockRoot while native-locked files remain (`EPERM`). The same rename succeeds after release.
3. Ordinary Windows execution still lacks file-symlink privilege (`EPERM`). Directory junction and hardlink fixtures do run and pass.

The controller ruled these must be explicit per-target skips and will independently verify Linux in the existing isolated pilot dependency folder. No Linux completion claim is made by this implementer. The adapter supports only win32/linux x64; deployment must independently enforce one traceRoot/lockRoot mapping. Same-user adversarial mutation, nonparticipants, mixed old/new deployments, network filesystems, producer drain, SQL ordering and full production coverage remain later gates. Unexpected callback thenable detection cannot undo already executed callback effects. No ALS borrowing or recovery engine was added. Only bounded specified regressions/build were run, not the entire unrelated test suite.

## Final SHA256 (before controller review)

```text
1F0E293FEB055D8BFC4DEF8C53359070EB0B57DF5B6D56D4E4F96CEDEAED83FD  services/agent-runtime/archive-write-fence.mjs
D67CF194B1A70590224FF15751B78758C79A71F57F694B60FAB05A1A6440A788  services/agent-runtime/archive-write-fence.d.mts
30CECD4F033ED061D56E2A6CF02D376A646640028F19D2F095FD696567B16613  services/agent-runtime/archive-write-fence.test.mjs
98F2DDA69B1DE8B00F9719A352F6D0349AB0E9582532BDA35173F2888FB07659  services/agent-runtime/test-helpers/archive-write-fence-child.mjs
```

Hashes were obtained with `Get-FileHash ... -Algorithm SHA256` and refreshed after all final source/test changes. Controller independent review remains required; controller will attach isolated JJ results separately.
