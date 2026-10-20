# Terminal task-stop projection — narrow independent rereview

Result: **PASS for both previous P2 corrections and their direct projection surfaces. No remaining required change was found within this rereview.**

Date: 2026-10-20. Reviewer: the same independent reviewer that wrote `terminal-projection-independent-review.md`. This report supersedes its CHANGES REQUIRED conclusion for those two findings. The earlier report's wider limitations remain.

## P2 corrections verified

1. `apps/api/src/task-stop-maintenance.ts:35-55,114-115` validates native locators before selecting any accepted/current slot. Each team checkpoint requires unique valid task ids and member/session ids; each mapping event requires unique valid native ids; a native id cannot change its approved target across history. Conflicts return the bounded identity-free `TASK_STOP_AMBIGUOUS` aggregate. Distinct native ids may still map to the same approved task for rework, and unchanged mappings repeated across separate events remain readable. The historical and current selectors share `mappedNative`, preserving selection semantics after the ambiguity gate.

2. `apps/api/src/task-stop-maintenance.ts:134-143` retains the missing accepted locator's original native mapping at the acceptance cursor plus its attempt. It suppresses a redundant latest missing entry only when approved task, native id and current attempt all match. A missing historical accepted row no longer hides the separate missing latest repair slot. A single missing latest accepted scope remains represented once.

The correction adds no route, effect authority, provider call, persistent state, logger mechanism or alternate registry. It remains a display/observation projection.

## Evidence verified

The updated tests cover conflicting and identical duplicate task ids, conflicting and identical duplicate session ids, duplicate native bindings within one event, native target changes across events, repeated unchanged mappings, legitimate new repair mappings, both historical/current rows missing, and no duplicate output for a single missing latest accepted scope.

`task-stop-projection-review-red.txt` records **15 tests: 13 passed and the two intended behavior failures**: false all-stopped output for ambiguous native locators, and one missing scope instead of two for missing historical plus repair rows. `task-stop-projection-review-green.txt` records the related projection/handoff/task-contract regression after the correction: **28 passed, 0 failed/cancelled/skipped**. This reviewer read the evidence without rerunning tests.

All four current file hashes match the refreshed `task-stop-projection-source-sha.json`. The contract and narrow index export hashes are unchanged from the initial review; the implementation correction is confined to the API projection and its test.

This PASS is limited to the two reviewed display findings. Actual PostgreSQL execution, immutable archive-object verification, route/auth/CSRF/idempotency behavior, rendered integration, device effects, Product finalization and the broader terminal/Task 5 acceptance remain unverified by this review. A displayed projection never substitutes for independent effect authorization.

No source file was edited. No test/PG/PGlite/Product process, network, paid model, JJ, Git, installation or device action was run. Only this final independent report was written.
