# Independent API checkpoint refs review — CHANGES REQUIRED

Reviewed 2026-10-20. Scope: pending `apps/api/src/local-execution.ts`, `apps/api/src/task-checkpoint-state.ts`, the shared-type export adjustment in `apps/api/src/task-canonical.ts`, `tests/task-checkpoint-state.test.ts`, and relevant current contracts/runtime seams. Read AGENTS.md, the continuation plan and `docs/validation/evidence/task-checkpoint-v2-plan-2026-10-20/independent-plan-review.md`. No source/test edits, database/model/JJ operations, or new test runs. This report is the only write.

## Finding

**[P2] Final archive authority check precedes the transaction's final await.** `apps/api/src/local-execution.ts:219–220` returns the result of `taskTransaction`, whose line 211 awaits `db.query('COMMIT')` after the helper returns. The helper's final semantic assignment and object checks occur at `apps/api/src/task-checkpoint-state.ts:78–81`. If a trusted `team/checkpoint` revokes the session or changes the task assignment while COMMIT is awaiting its response, preparation still resolves with refs authenticated against the previous assignment. Archive appends do not acquire the SQL project/run locks. This is the same real async archive-change condition the new semantic check intends to reject, occurring at the remaining outer await. The runtime's `task-tool-context.mjs:38–41` checks current in-memory work identity, and `handoff.mjs:91–99` validates refs/object metadata; neither rechecks that archived authority. Thus the private API can return stale authorized refs even though its internal last check passed. Object changes at this boundary are caught by the later Handoff object validation, but that does not repair the missing archive-authority check.

Place a synchronous semantic archive/assignment, signal and referenced-object fence after the outer transaction resolves and immediately before the private API returns; retain the current SQL authority checks under its locks. Add a narrow regression that appends an assignment withdrawal after the real COMMIT completes but before the mocked query promise resolves, and require `prepareCheckpoint` to reject. A harmless progress-only append at that same boundary should remain accepted. This does not require restoring whole-event-array equality, new dispatch, or changing recovery gates.

Current race tests at `tests/task-checkpoint-state.test.ts:178–188` inject during scope UPDATE or the third lease SELECT. They meaningfully cover internal awaits, but none intercepts COMMIT, so the reported 16/16 does not establish this remaining boundary.

## Checks without additional findings

- Exact task/attempt/generation and after-tool operation are enforced; stale or foreign successful operations cannot substitute for the last committed task operation. SQL unresolved operations block independently of archive completion/acknowledgment.
- Task partial work revision is independently derived from bytes. Current full canonical B and A's original merge are authenticated separately; A's old afterRevision is not confused with B's current head.
- Existing resolver validates binding, contract, permission/capability hashes, pinned import/accepted ancestry and rolling own outputs. The semantic re-resolve correctly tolerates unrelated checkpoint progress; the final projection still detects member removal, assignee/attempt/activity, mapping and effective-contract changes present before its check.
- Refs remain private, cloned and recursively frozen. This path uses committed objects, no compatibility-cache fallback, no command dispatch and no model/HTTP registration.
- Shared types are exported through contracts and imported/re-exported with type-only syntax. The new API helper imports runtime utilities; runtime checkpoint modules do not import the API helper, so no new API/runtime dependency cycle was found.
- Recovery/handoff-source rejection and the launch profile gate remain closed. Recovery, accepted-stop, backup and physical deployment are outside this cohort's completion claim.

## Evidence assessed

Read implementation tests and existing `refs-green.txt` (16/16), `refs-product-green.txt` (one actual-product fixture pass) and `refs-regression.txt` (25 passes in the inspected log). These fixtures exercise real API queue/claim/start/result/CAS merge with simulated physical device output rather than prefilled merge receipts. Tests are meaningful for the supported non-recovery scope. No new execution evidence is claimed by this static review; PGlite/product logs do not prove native PostgreSQL, physical OpenShell/JJ or paid-model behavior.
