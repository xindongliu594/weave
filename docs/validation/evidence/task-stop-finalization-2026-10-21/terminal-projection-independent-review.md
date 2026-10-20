# Terminal task-stop read projection — independent review

Result: **CHANGES REQUIRED — two P2 findings**, reported together after reviewing the complete supplied slice.

Date: 2026-10-20. Scope: `packages/contracts/task-stop-maintenance.ts`, the narrow export in `packages/contracts/index.ts`, `apps/api/src/task-stop-maintenance.ts`, and `tests/task-stop-maintenance.test.ts`, against the frozen projection and latest-approved-slot requirements in `docs/superpowers/plans/2026-10-20-task-stop-finalization.md`.

This is a read-only display/observation review. Neither finding grants, replays or authorizes a device effect; the later reconciliation path must independently prove its own authority. No route, lifecycle, full runtime teardown or Task 5 release review is implied.

## P2 — ambiguous native locators are selected instead of failing closed

Locations: `apps/api/src/task-stop-maintenance.ts:29-32`, `:61-64`, `:108-110`, and `:116-120`.

The projection detects duplicate SQL keys and duplicate accepted keys, but the checkpoint/mapping metadata that establishes the latest approved slot has no equivalent locator validation. `boundedEvent` only bounds the arrays. Historical proof uses `tasks.some(...)` and `members.some(...)`; latest-slot selection uses `tasks.find(...)`; native-to-approved bindings are silently accumulated in a Map. A conflicting duplicate native task id in a team checkpoint is therefore accepted by choosing the first matching entry, rather than projected as ambiguous. A matching member entry can likewise conceal a conflicting duplicate session locator. A conflicting repeated native mapping is also silently overwritten.

Concrete smallest RED: start from `fixture('stopped')`; append to its last `team/checkpoint.data.tasks` a second entry with the same `id: 'native-a'` but `attemptId: 'attempt-repair'` and `status: 'in_progress'`. The historical `.some` succeeds on the original completed entry, the latest `.find` picks that same original entry, the SQL row passes the latest-presence check, and the current implementation returns aggregate `state: 'stopped'`. The latest task locator is ambiguous, so the frozen contract requires a pending identity-free aggregate (or another explicitly non-effectful ambiguity representation consistent with that contract), never all-stopped output.

Smallest repair: validate relevant native mapping/checkpoint locators before selecting them and return the bounded `TASK_STOP_AMBIGUOUS` aggregate on conflicting/duplicate locators. Preserve legitimate rework history in which different native ids map to the same approved task; do not solve this by rejecting every historical rework mapping. Cover the conflicting duplicate task locator above and the corresponding session/native-mapping ambiguity surfaces in the same correction.

## P2 — a missing historical accepted row suppresses a separate missing latest repair slot

Locations: `apps/api/src/task-stop-maintenance.ts:114-120`.

`missingAccepted` records only `taskId`. The latest approved-slot check then skips that entire task whenever any accepted SQL scope for that task is missing. It cannot distinguish the missing historical accepted key from the latest repair's different attempt/native identity. Thus the new protection added for a retained historical stopped row works only while that historical SQL row is present; losing that row causes the latest missing repair slot to disappear from the projection again.

Concrete smallest RED: extend the existing historical-repair fixture from test lines 184-187 with `f.rows = []`. Keep the historical accepted/checkpoint evidence and the newer mapping/team checkpoint for `repair-a` / `attempt-repair`. The current result contains only the historical `attempt-a` unverified key: line 115 adds approved task `a` to `missingAccepted`, so line 120 omits the separate latest missing slot. The frozen actual-source ruling requires the latest approved slot to be proved separately from every retained historical scope.

Smallest repair: suppress a redundant latest missing entry only when the already-represented missing accepted locator is demonstrably that same latest native/attempt slot. A taskId-only match is insufficient. Keep both distinct unresolved locators visible, or explicitly aggregate them with a bounded unresolved count when their identities cannot be distinguished. Add the missing-historical-row variant to the existing repair test; retain the current no-duplicate behavior for a single missing latest accepted scope.

The minimal REDs above are source-derived expected failures, not newly executed test evidence. Per dispatch instruction, this reviewer did not launch PG or test processes.

## Reviewed behavior without another required change

- DTO variants use strict objects; aggregates carry no effect identity; unverified entries cannot enable reconciliation; scope arrays and unresolved counts are bounded; duplicate output keys are rejected. The public reconcile-input schema conveys identity only, never proof or permission.
- The projection decodes the original strict marker and privately checks its original proof against accepted/checkpoint and SQL operation metadata. NULL remains no-intent; only an original matching stopped marker can project stopped. Marker proof, lastError, workspace paths, operation payload/body and raw claim token are not emitted.
- Partial task revision is checked independently from full canonical revision. Historical NULL scopes keep their original identity and do not borrow repair acceptance or fabricate a stop id. Missing archive/identity/evidence and explicit truncation degrade to pending/unverified.
- The reader performs only parameterized SELECTs, with explicit JSON metadata paths and bounded row/operation/receipt lists. It rereads each invocation and calls no provider, stop, prepare, exec or delete method. The selected table/column names and text id/claim-token types match the current schema. No obvious SQL syntax/type mismatch was found statically; actual PostgreSQL execution remains unverified here.
- The slim snapshot retains the complete inputs used by the existing `checkpointContract`: original row contract, the assignee's id/tools, whole knowledge value and whole execution target. The omitted snapshot fields and other agent fields are not hashed by that function. This is a static input-equivalence check, not actual PostgreSQL acceptance evidence.

## Evidence and limits

All four current file hashes exactly match `task-stop-projection-source-sha.json`. The supplied six RED/GREEN groups were inspected, including the intended historical-repair and complete-file-metadata failures. The final supplied focused regression records **26 passed, 0 failed/skipped** for the projection, handoff-checkpoint and task-contract test files. These are synthetic metadata/injected-reader tests, not actual PostgreSQL execution or immutable archive-object verification.

No source file was edited. No PG/PGlite, Product/full suite, network, paid model, JJ, Git, installation or device action was run. Only this independent report was written. HTTP/auth/CSRF/idempotency routing, rendered integration, physical device facts, three consecutive Product projects, and the broader terminal contract remain outside this slice.
