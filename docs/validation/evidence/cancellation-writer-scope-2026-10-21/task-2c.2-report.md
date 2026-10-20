# Task 2c.2 implementer report

Baseline supplied by controller: `fb183ea`. Source changes are limited to `apps/api/src/run-coordinator.ts` cancellation methods and two test files. No Git writes, public documentation, dependencies, scope-manager/native primitive, runtime producer, SQL fee/state, authorization, recovery, approval, usage, JJ or production changes. No subagents or real model/device calls.

## Behavior and scope

`cancelRequest` returns a private `{denied: AppError}` only at its three original pre-mutation denial branches: missing initial identity, missing locked run reread, or terminal status. The local helper awaits the original transaction's ROLLBACK before returning. `cancel` awaits the unchanged `withWriter` lifecycle and throws that exact AppError after the scope has fulfilled and drained. SQL and transaction errors still reject inside `withWriter`; original `runtime.cancel` errors still reject within both the retained runtime producer and independent HTTP writer. No general AppError/4xx classifier or unlock/reset was introduced. Existing queued/running SQL and `cancelOwned` are unchanged.

Controller authorized one additional narrow fixture correction after final bounded regression exposed an existing failure: Task 2c.1 moved the maintenance UPDATE from pool.query to its original transaction client. The `own-active run survives expiry...` fixture in `tests/run-live-lease.test.ts` now injects expiry through that same client, preserving max1 connection safety, callback/Promise connect overloads and all original receipt/status/owner/model-call assertions. No lease/cost production changes.

## Commands, evidence and actual exits

Every log below preserves output and final `EXIT=N`; no failed run is counted as passing.

| Log | Command / result | Actual exit |
| --- | --- | --- |
| task-2c.2-red-sandbox-setup.log | `node scripts/test-integration.mjs '--test-name-pattern=known cancellation denial' tests/run-terminal-maintenance.test.ts`; sandbox localhost EACCES before migration, plus failed after-hook because worker was never initialized. Environment failure, not product RED. | 1 |
| task-2c.2-red.log | Same command with localhost permission: all six exact known-denial tests fail at actual second-process native source acquisition (`E_ARCHIVE_FENCE_TIMEOUT`, source child exit1). Correct outward AppError and acknowledged original rollback were checked before this failure. Valid RED, production not yet edited. | 1 |
| task-2c.2-denial-green.log | Same command after fix: missing identity passed; test-only pool.connect wrapper omitted callback forwarding and subsequent stored-row query hung. Missing locked reread timed out. Interrupted via original shell session Ctrl+C; actual shell session exit1 is **not** recorded as a proven original test-child exit. No fixture cleanup marker. | 1 |
| task-2c.2-cancel-green.log | `node scripts/test-integration.mjs '--test-name-pattern=known cancellation denial\|uncertain cancellation\|queued cancellation commits\|running cancellation preserves' tests/run-terminal-maintenance.test.ts`; 14/14 after restoring wrapper before pool queries. | 0 |
| task-2c.2-regression-green.log | `node scripts/test-integration.mjs '--test-name-pattern=cancellation\|cancel racing\|heartbeat\|lease' tests/run-terminal-maintenance.test.ts tests/run-live-lease.test.ts`; terminal selected22/22; selected lease6/7. Existing own-active fixture failed injected===true because its pool interception no longer saw the Task2c.1 transaction-client UPDATE. Failure preserved, root authorized narrow test fix. | 1 |
| task-2c.2-build.log | `npm run build`; test typing errors: ForkOptions omitted windowsHide and pg query.call overload expected callback. Corrected test source probe to explicit node spawn with IPC/windowsHide, same existing native source helper, and narrow query cast. | 2 |
| task-2c.2-lease-fixture-green.log | `node scripts/test-integration.mjs '--test-name-pattern=own-active run survives' tests/run-live-lease.test.ts`; corrected fixture1/1. | 0 |
| task-2c.2-cancel-final-green.log | Same14-case cancellation command, after explicit callback forwarding and fork-to-spawn test correction;14/14. No unrelated green22 controls replayed. | 0 |
| task-2c.2-build-final.log | `npm run build` after all edits: TypeScript and Vite pass. Vite warns about a650.57kB chunk; no new application bundle change is claimed. | 0 |
| task-2c.2-interrupted-process-check.log | Escalated read-only Win32_Process inventory: zero node.exe command lines matching test-integration.mjs, run-terminal-maintenance.test.ts or archive-writer-source-child.mjs. Sandbox CIM attempt had access failure and was not treated as termination evidence. | 0 |

The cancellation14 cover both404 branches, completed/failed/cancelled/interrupted409, arbitrary SQL AppError409, rollback failure before and after actual rollback, COMMIT failure before and after actual commit, queued successful cancellation, and running successful/failed original runtime cancellation. Source success is reported by the existing independent native child, then child exit0 is checked. Negative paths see a real independent source attempt blocked; SQL final rows and original errors are asserted. Running tests keep the original retained producer alive after owner.finish and verify no repeated runtime.cancel.

## Fixture ownership and cleanup

Failed guards remain retained in the original test process until it actually exits. No test unlock, force-release, directory deletion or failure reset was added. Source probes are joined through their real exit events; killing a source-only blocked probe does not release the original failed writer.

Completed native fixture markers (Windows native Temp, not age/prefix enumeration): RED `run-terminal-maintenance-MJz8My`; first14 GREEN `run-terminal-maintenance-Y9xWvV`; bounded regression `run-terminal-maintenance-MhK39d`; final14 GREEN `run-terminal-maintenance-ZjnBGF`. All are exact children of `C:\Users\JJ\AppData\Local\Temp`. Root owns deletion through `cleanup-2c.2-fixtures.ps1` only after completed-run evidence, checking resolved absolute owned identity plus ancestors/descendants for reparse points. Root reported all four marked fixtures cleaned with actual EXIT0 in `task-2c.2-red-cleanup.log`, `task-2c.2-green-cleanup.log` and `task-2c.2-final-cleanup.log`. Initial sandbox cleanup refused before deletion due redirected Temp, followed by successful escalated native-Temp cleanup. `task-2c.2-parent-cleanup-note.md` records the parent evidence and retained unidentified remnants; no claim that all Temp files were removed is made.

Interrupted GREEN and initial sandbox setup did not print an exact fixture marker; their directories are unidentified and cleanup remains unverified. Read-only absence of matching processes does not establish directory identity. No guessed or age-based deletion was attempted.

## Limits and handoff

Actual coordinator/state/SQL and native OS locks are exercised with PGlite's isolated single backend and explicit runtime doubles. This is consumer cancellation/native lock evidence; it does not establish real Host/model/device behavior, PostgreSQL independent-backend concurrency, or comprehensive archive writer coverage. No prior native PostgreSQL cluster was reused. Source recovery and enterprise profile remain outside scope. Unchanged primitive/adapter/runtime/capability/full suites were not rerun. Root owns candidate commit and independent review; implementation is uncommitted.

Exact three-file SHA256 allowlist is in `task-2c.2-sourceSHA.json`. Heavy-test slot was released after final tests/build exited; no more tests are running for this task.
