# Task 2b fix round 1

Status: DONE for the scoped implementation; awaiting root's independent rereview. Base candidate `d9bb4a4`. No Git writes, public-document changes, native primitive edits, new 2c.1 work, business/fee gate changes, model API calls, production/JJ access or deployment occurred. $3.41 cap and all historical unknowns are unchanged.

## Review findings fixed

The review reproductions matched the actual implementation. Nested `withWriter` had directly called its callback in the parent's ALS invocation, allowing stale nested callbacks and caught callback failures to escape the lifetime contract. Its borrowed retain view checked the current valid manager/run but retained a captured owner's lifetime, so another independently acquired owner for the same run could use it.

`archive-writer-scope.mjs` now has one private `invoke(record, fn)` path used by owner/producer `run` and nested `withWriter`. Every nested callback gets its own live ALS context, original returned Promise tracking, parent producer in-flight count and failure latch. Its context expires when its own callback settles, even if the outer callback remains live. Nested failures latch before the outer caller can catch them; catching cannot resolve writerDrained or release the original native guard. The nested path takes no new native guard and does not finish its parent or close parent admission.

Each frozen borrowed view now captures that exact nested invocation. Its retain first requires the current ALS identity to equal the captured identity, then validates the live manager/root/run guard. A different live owner for the same UUID and an already-expired nested view both reject. Explicitly retained producer handles remain transferable and keep their original owner/guard.

The injected heartbeat failure test captures all console.error arguments, asserts exactly `['Run lease cancellation:', 'Error']`, and restores the logger after original work settles. Production coordinator behavior is unchanged. Passing test output no longer contains unexplained expected stderr.

## New regression coverage and RED

The five new focused regressions were written and run before the production fix:

1. A bound callback captured inside a completed nested helper cannot re-enter `withWriter` while its parent remains live; a producer explicitly retained by that nested helper still runs and prevents source acquisition until its original Promise ends.
2. Owner B independently acquires the same run while owner A's borrowed invocation remains live. B cannot retain through A's unretained view, while an explicitly retained producer from A can be transferred into B's calling context and restores A's context correctly.
3. A completed nested view cannot retain even inside its original still-live parent.
4. A synchronous nested callback failure caught by its parent still rejects outer drain and keeps the actual original OS guard.
5. An asynchronous nested callback rejection has the same caught-failure retention behavior.

`task-2b-fix1-red.txt` preserves the exact command output and EXIT=1: 0 pass, 5 fail. The first three returned no expected scope error; both caught-failure cases incorrectly returned `outerError: null`.

Exact RED command:

```text
node --test --test-name-pattern="nested invocation|borrowed view|caught nested" services/agent-runtime/archive-writer-scope.test.mjs
```

The caught-failure probes run in actual dedicated child processes. The child reports whether the outer drain rejected, then remains alive without manually releasing its failed native guard. Parent verifies source timeout while that process lives, requests its exit, awaits and asserts actual exit code 0, then acquires/releases source successfully. Fixture cleanup now also joins/kills any remaining probe child before deleting the parent's exclusive synthetic directory, including on a failing RED assertion. No test-only guard release or failure-reset API was added.

## Final bounded verification

| Evidence | Exact command | Actual result |
| --- | --- | --- |
| `task-2b-fix1-scope-green.txt` | `node --test services/agent-runtime/archive-writer-scope.test.mjs` | EXIT=0; 12 pass, 0 fail/skip, including all 7 existing scope cases and 5 new cases. Real child source/producer retention remains covered. |
| `task-2b-fix1-heartbeat-green.txt` | `node scripts/test-integration.mjs tests/run-terminal-maintenance.test.ts --test-name-pattern="a rejected heartbeat waits"` | EXIT=0; exactly 1 pass, 0 fail/skip; expected diagnostic captured/asserted, no unexplained stderr. Private PGlite loopback fixture only. |
| `task-2b-fix1-build-green.txt` | `npm run build` | EXIT=0; TypeScript consumers and Vite build pass. Existing >500kB chunk advisory remains. |
| `task-2b-fix1-diffcheck.txt` | `git diff --check -- services/agent-runtime/archive-writer-scope.mjs services/agent-runtime/archive-writer-scope.test.mjs services/agent-runtime/test-helpers/archive-writer-source-child.mjs tests/run-terminal-maintenance.test.ts` | EXIT=0; no whitespace errors. Ordinary CRLF notices only. |

Declarations and public API signatures did not change. The project build includes TypeScript validation of the affected fixture/consumers; no separate unchanged-declaration rerun was needed. No unchanged 20-case native primitive suite, capabilities/product tests, other caller batches or full repository suite was rerun in this fix round.

The heartbeat failure retains its original native guard by design. Its after hook therefore left the exclusive synthetic directory intact. Only after the original runner actually returned EXIT=0 did the parent cleanup command verify the one logged absolute target `C:\Users\JJ\AppData\Local\Temp\run-terminal-maintenance-kNF28T`, exact Temp parent, exclusive leaf prefix, plain non-reparse directory and resolved identity, then remove it with PowerShell LiteralPath. Actual cleanup command exit was 0. Exact command/stdout/exit are copied as an explicitly labeled transcript in `task-2b-fix1-cleanup-transcript.txt`.

## Changed source allowlist and hashes

`task-2b-fix1-sourceSHA.json` records current byte-SHA256 for exactly these 4 changed source files:

- `services/agent-runtime/archive-writer-scope.mjs`: shared invocation expiry, tracking and failure latch; exact borrowed-view identity.
- `services/agent-runtime/archive-writer-scope.test.mjs`: five regressions and a bounded child-probe helper; child-before-directory cleanup ordering.
- `services/agent-runtime/test-helpers/archive-writer-source-child.mjs`: sync/async caught-nested-failure probes, with OS guard retained until actual process exit.
- `tests/run-terminal-maintenance.test.ts`: expected diagnostic capture/assert/restore only.

`git diff --name-only -- apps services tests` showed only these four paths. The original committed candidate snapshot, initial hashes and recorded evidence remain unchanged; this report and the concise appended private report outcome supplement them.

## Self-review and boundary

Self-review checked that nested calls reuse the original producer/native guard while getting distinct invocation expiry, both synchronous and asynchronous failure latch before parent catch, stale/foreign views reject without lending another owner's guard, explicitly retained work survives nested return and parent closure, and all probe children actually exit before fixture removal. No additional source change or unresolved blocker was identified. Root owns scoped rereview and all Git/public evidence actions.

Native PostgreSQL multi-backend lock order remains unverified. This round's PGlite result is only the affected isolated SQL/heartbeat fixture, not independent backend lock evidence. Low-level trace registration and remaining HTTP/device/cost/canonical/accepted-stop/maintenance/backup/offline writer coverage still belong to 2c/3/4. Enterprise/source approval, source signing and recovery child initialization remain closed.
