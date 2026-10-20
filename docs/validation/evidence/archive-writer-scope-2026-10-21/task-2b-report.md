# Task 2b implementation report

Status: DONE for the approved bounded 2b production slice. Root owns commits and independent review. No Git writes were made by this implementer.

Base supplied by root: `f15eab4`. No Task 1 primitive, dependency, Task 2a runtime implementation, low-level trace-store registration, model API, deployment, credentials or production/JJ access was changed. Cap $3.41 and historical unknown fees are unchanged.

## Implementation and ownership proof

- `services/agent-runtime/archive-writer-scope.mjs` reuses Node AsyncLocalStorage and the existing native fence. Module-private identities bind manager, sorted UUID set, original native guard, owner, producers and individual active invocation. No lookup by run ID lends a live guard to an unrelated chain.
- Startup mapping defaults to `dirname(traceRoot)/.archive-write-locks`. Startup prepares directories, validates them through the unchanged native factory, rejects nested trace/lock roots and supplied tool workspace overlaps, caches the identical mapping, and refuses a conflicting same-process mapping. Explicit override is library configuration; no new environment switch or unlocked fallback was added. Another process using a different mapping cannot be detected here and remains a deployment limitation.
- `app.ts` owns creation at its composition root and injects that manager into `RunCoordinator`. The local-workspace root supplied by application options is checked for lock directory overlap. Coordinator construction now requires an explicit manager with the same traceRoot. LocalOperationService does not create its own fence/manager.
- `withWriter` borrows only a live originating ALS subset. A borrower receives a frozen retain-only view and cannot finish/close its parent. Expansion, another manager and stale invocation contexts reject. Independent top-level chains acquire independent native guards.
- Owner and producer handles are frozen closures. Retain must precede detached registration. `run()` restores the originating context and tracks the actual returned Promise; even premature `finish()` cannot release an in-flight operation. Closing admission prevents new retains, while already retained work may finish. Failed work latches in a private retained set and rejects writerDrained without releasing its original OS guard. Stale bound callbacks cannot reacquire through withWriter/acquireOwner.
- Tick reads candidate identity with no SQL transaction, acquires the native writer, then enters the existing advisory/project/run SQL order in that owner's context. It rechecks current active limit, stopped state, queued/noncancelled state, project identity/version and department conflicts before claim. Unclaimed owners finish normally.
- Claim handoff passes the same still-open owner synchronously to launch before tick clears its own reference. Tick never waits for the long business run. It does not finish a parent then try to resurrect it with heartbeat retention. Launch creates the active entry and observes its returned rejection immediately.
- Launch's original owner covers preparation, runtime start, callbacks, usage, terminal bookkeeping, and Task 2a's actual runtime writerDrained. Admission closes at entry to draining. Only after the original launch invocation settles does the owner finish; then launch waits for retained producers as well before deleting active. Failed/unproven drains preserve active drain-failed and native ownership.
- Heartbeat first retains every original executing owner. Each SQL UPDATE runs in its own original producer context, retaining original owner/status predicates. Public heartbeatWork aggregates every original UPDATE with allSettled and propagates error only after all update Promises settle. Cancellation tails remain outside heartbeatWork to avoid a beforeRequest/heartbeat cycle, but remain in their retained producers and therefore in launch/close drain.
- Heartbeat SQL cost changes from one UPDATE per round to N UPDATEs for N executing entries (production maxActiveRuns is bounded by settings, maximum 8). Public ids/held and shared heartbeatWork semantics remain. Draining entries do not join new rounds.
- Tick cancellation, shutdown cancellation and an external cancel request's runtime closure execute in a retained producer of the original active owner. External cancellation SQL has its own top-level/borrowed writer scope before SQL. ProductDshRuntime.cancel's original closeHost Promise therefore inherits the original running producer, not an already-ended HTTP request scope.

## TDD and verification evidence

All files below are in this private plan workspace. Each archived command output ends in its actual EXIT value. Synthetic OS probes are distinct from PGlite SQL logic.

| Evidence | Exact command | Result |
| --- | --- | --- |
| `task-2b-scope-red.txt` | `node --test services/agent-runtime/archive-writer-scope.test.mjs` | EXIT 1: manager factory absent; expected missing new scope implementation. |
| `task-2b-coordinator-red.txt` | `node scripts/test-integration.mjs tests/run-terminal-maintenance.test.ts --test-name-pattern="tick waits\|tick transfers"` | EXIT 1: no outside-SQL candidate read; source not blocked by transferred writer. |
| `task-2b-heartbeat-red.txt` | `node scripts/test-integration.mjs tests/run-terminal-maintenance.test.ts --test-name-pattern="detached heartbeat SQL"` | EXIT 1: original batch UPDATE lacked exact original ALS context. |
| `task-2b-borrow-red.txt` | `node --test --test-name-pattern="subset borrows" services/agent-runtime/archive-writer-scope.test.mjs` | EXIT 1: borrower exposed the parent owner rather than retain-only view. |
| `task-2b-scope-green.txt` | `node --test services/agent-runtime/archive-writer-scope.test.mjs services/agent-runtime/archive-write-fence.test.mjs` | EXIT 0: 24 pass, 3 explicit Windows fixture skips; all 7 new scope cases pass. |
| `task-2b-callers-green.txt` | `node scripts/test-integration.mjs tests/run-terminal-maintenance.test.ts tests/run-live-lease.test.ts tests/collaboration.test.ts tests/execution-policy.test.ts tests/work-file-project.test.ts` | EXIT 0: respectively 27/27, 9/9, 2/2, 7 pass/2 native-PG skips, 3/3. Total 48 pass/2 skip. |
| `task-2b-capabilities-final.txt` | `node scripts/test-integration.mjs tests/capabilities.test.ts` | EXIT 0: 4/4, including migrated direct constructor/launch. |
| Product section of `task-2b-fixture-fixes-first-attempt.txt` | `node scripts/test-integration.mjs tests/capabilities.test.ts tests/product.test.ts` | Product 7/7. The command's overall EXIT is 1 because capabilities then exposed an independent fixture prerequisite; do not label this whole output green. |
| `task-2b-declarations-green.txt` | `npx tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext --types node services/agent-runtime/archive-writer-scope.d.mts` | EXIT 0. |
| `task-2b-build-green.txt` | `npm run build` | EXIT 0: project TypeScript and Vite build; existing >500kB chunk advisory remains. |
| `task-2b-final-typecheck.txt` | `npx tsc --noEmit` | EXIT 0 after the final capability fixture archive correction. |
| `task-2b-diffcheck.txt` | `git diff --check` | EXIT 0, no whitespace errors; ordinary Git CRLF notices only. |
| `task-2b-primitive-unchanged.txt` | `git diff --exit-code -- services/agent-runtime/archive-write-fence.mjs services/agent-runtime/archive-write-fence.d.mts services/agent-runtime/archive-write-fence.test.mjs services/agent-runtime/test-helpers/archive-write-fence-child.mjs services/agent-runtime/package.json services/agent-runtime/package-lock.json` | EXIT 0, Task 1 primitive/dependencies unchanged. |

The new scope tests prove stable mapping/conflicts/workspace exclusion, same-chain subset borrowing, manager/expanded-set rejection, independent shared owners, parent admission closure, actual Promise retention after early producer.finish, stale bound callbacks, failed cleanup latching, and a real child process's source exclusion until a delayed producer settles. The failed-producer probe runs in a child: parent observes native source timeout while the child is alive, child exits 0, and parent can then acquire source. No test-only unlock was added.

The actual coordinator tests prove native acquire before SQL connection/transaction (the FIFO one-connection PGlite fixture can execute a cancellation/version/department mutation while acquisition waits), recheck refusing each changed candidate, nonblocking transfer, heartbeat after tick return, terminal-but-undrained native exclusion, original context for both heartbeat SQL and shutdown cancel, all original heartbeat SQL updates observed after one rejects, and failed owner still excluding source. Original Task 2a acceptance/bookkeeping/cost-history cases remain in the 27-case suite.

### Intermediate failures preserved, not counted as passes

- The first restricted sandbox integration attempts could not connect to their own loopback socket (`EACCES`); a fixture setup attempt also lacked the new lock directory. Those were setup failures, not the correctness RED. The meaningful RED was rerun with explicitly created synthetic root configuration and approved local loopback access, as recorded above.
- `task-2b-scope-sandbox-attempt.txt`: EXIT 1, 20 pass/4 fail/3 skip. Existing native rename/identity fixtures were blocked by Windows sandbox filesystem EPERM, including after release. Ordinary local synthetic-directory rerun was explicitly approved; final scope/native output is 24 pass/3 skip. Final skips are live namespace rename, live lockRoot rename and unavailable symlink-file fixture. They do not certify those platform behaviors.
- `task-2b-callers-first-attempt.txt`: EXIT 1. One lease expectation still assumed two batched UPDATEs; approved per-run updates correctly produce 3 for a first one-run round and second two-run round. Its assertion now measures that behavior, and the final lease suite is 9/9.
- The same first caller batch exposed old fixture setup failures before the new constructor call: capabilities approval used a default placeholder task (PLAN_NOT_READY 422); product's two later HTTP tests called full identity shutdown (503/project undefined). Root explicitly authorized narrow fixture corrections, retaining all production gates and existing model/fee assertions.
- `task-2b-fixture-fixes-first-attempt.txt`: overall EXIT 1. Product's use of existing shutdownBackground fixes both cases (7/7). Capabilities then reached GOAL_CONTRACT_CHANGED before its model assertion because an approved-but-never-launched fixture had no original archive. Root identified goal-recovery's existing prerequisite and authorized creating the exact approved original archive, with no goal re-signing. Its final file is 4/4. No baseline checkout was run; attribution of these fixture prerequisites is based on the static production paths and the bounded reproductions, not an asserted historical baseline test pass.

### Actual process exit and fixture cleanup

Failed native ownership was never force-released. Run-terminal tests leave their exclusive synthetic root intact and print `ARCHIVE_WRITER_EXIT_CLEANUP` because failure cases intentionally retain native guards. After each original runner had completed (archived EXIT evidence), parent-only `cleanup-2b-fixtures.ps1` verified each absolute target's exact Temp parent, exclusive leaf prefix, resolved identity and non-reparse directory before native PowerShell LiteralPath recursive removal. No deletion was composed across shells.

`task-2b-fixture-exit-cleanup.txt`: EXIT 0. The three targets were `run-terminal-maintenance-R0CqcF`, `run-terminal-maintenance-AdgN6o`, and `run-terminal-maintenance-nONCU7` under the user's Temp directory. They were removed only after the original test processes exited. The failed-producer/source child probe separately asserts real child exit 0 before its parent fixture is removed.

## Source allowlist and explicit constructor migrations

`task-2b-sourceSHA.json` is the final 16-file byte-SHA256 allowlist:

1. apps/api/src/app.ts
2. apps/api/src/run-coordinator.ts
3. services/agent-runtime/archive-writer-scope.mjs
4. services/agent-runtime/archive-writer-scope.d.mts
5. services/agent-runtime/archive-writer-scope.test.mjs
6. services/agent-runtime/test-helpers/archive-writer-source-child.mjs
7. tests/capabilities.test.ts
8. tests/collaboration.test.ts
9. tests/cost-carryover.test.ts
10. tests/execution-policy.test.ts
11. tests/local-device-admission.test.ts
12. tests/product.test.ts
13. tests/run-live-lease.test.ts
14. tests/run-state.test.ts
15. tests/run-terminal-maintenance.test.ts
16. tests/work-file-project.test.ts

All coordinator constructor call sites were searched. Production app has 1 construction. Direct fixture constructions: capabilities 1, collaboration 1, cost-carryover 1, execution-policy 2, local-device-admission 1, product 1, run-live-lease 2, run-state 1, run-terminal-maintenance 1, work-file-project 1. Each now supplies its explicit manager rooted under its exclusive fixture parent; none uses a shared global Temp sibling lock directory. App createExecutor parameter indexing was adjusted from constructor position 1 to 2.

Cost-carryover, local-device-admission and run-state constructor migrations were typechecked but their files were not runtime-executed in this bounded pass. In particular no run-state pg_stat_activity/independent-row-lock case was sent through PGlite. Root's bounded testing instruction was followed instead of running the entire repository suite.

## Self-review and remaining boundary

Self-review checked original owner handoff, failure retention, closed admission, absence of global run-ID borrowing, fresh external cancellation versus retained runtime closure, heartbeat aggregation of all original updates, the 16-file source allowlist and primitive non-modification. No unresolved implementation blocker was found. Independent review remains root's responsibility.

This is not complete archive source fencing. Low-level trace create/open/append is not strictly registered and does not yet require the live capability/journal lock. Existing recovery/expireReservations, cost-control/cost-router/provider reconciliation, approval/run creation/retry, independent LocalOperationService/device routes and executor publishers/canonical/accepted-stop multi-transaction tails still require Task 2c coverage. Object/checkpoint/workspace/session/plugin writers, maintenance, backup/root swaps, planning directories and offline scripts still require Tasks 3/4 audit and integration. The default sibling path avoids the currently audited online trace-only backup/swap inventories; arbitrary external/offline cleanup or another process's wrong root configuration is not certified.

No real native PostgreSQL multi-backend lock-order/row-lock test was available or run for this task. PGlite only proves isolated SQL logic and the explicit no-connection-held acquisition barrier; native OS source exclusion is proved by real local processes. No enterprise/source approval, recovery child initialization or source signing was enabled. Scope failures deliberately preserve OS resources until process exit/restart, including a structured callback rejection, rather than guessing that cleanup is safe.
