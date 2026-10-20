# Live canonical consumers — local engineering evidence

Scope: artifact list/download, parent material copies, from-run material import, planning execution context and accepted work records. Task profile remains closed. Recovery/restored source certification and null-merge initial heads remain explicitly unsupported.

- RED command: `node scripts/test-integration.mjs tests/task-canonical-readers.test.ts`. `live-readers-red.log`: 7 tests, 0 passed, 7 failed by intended assertions before production edits (partial cache returned wrong/partial list; imports/planning blocked on cache; missing/bad objects and profile mismatch incorrectly returned cache).
- GREEN same command: `live-readers-green.log`: 9 tests, 9 passed, 0 failed. Two supplementary negative cases cover finished JSONL + human acknowledgment + SQL unknown, and mismatched/damaged original SQL merge evidence/null-merge unsupported head.
- Fixture uses real `LocalRunExecutor`, queued operations, HTTP device poll/start/result and canonical CAS. Each case obtains two committed operations via this path; it never inserts successful local operation/merge rows. The device itself is an engineering transport fixture, not OpenShell or model acceptance.
- Office binary is a real generated DOCX retained by canonical merge and verified by artifact download and parent copying. From-run test uses a sealed text output. Existing task importedFiles origin requires UTF-8 content, so this suite does not claim an Office generation task or binary from-run acceptance fixture.
- Reads call `readLiveCanonical` once per logical action from the actual SQL run row. It uses `readCommittedCanonical`, validates the exact original SQL committed operation, then carries one `{ref,files}` selection. Download bytes are the verified object bytes already read by that primitive.
- Unknown profiles, SQL/archive profile mismatch, missing/corrupt object, unverified recovery ancestry, missing original live operation or unsettled SQL operations fail closed. Legacy/no-profile reads preserve their artifacts branch.
- `parent_run_id` occurs only in existing retry/resume creation. Full retry starts from approved imports and skips parent copies. `resumedFrom` is present on full retry too, so helper only refuses it when approval kind is not `retry`, while any recovery context remains blocked.

Legacy regression command: `node scripts/test-integration.mjs tests/work-files.test.ts tests/work-files-from-run.test.ts tests/planning-execution-context.test.ts tests/work-records.test.ts`. `live-readers-legacy-regressions.log`: work-files 14/14, from-run 1/1, planning context 11/11 passed; work-records initially failed 4/4 with HTTP 503 before reaching readers because its fixture called full app shutdown before HTTP requests, closing the new identity service.

The work-records fixture now closes only background workers before requests and closes the real identity service during cleanup. Auth source/config were not changed. Rerun `node scripts/test-integration.mjs tests/work-records.test.ts`: `live-readers-work-records-green.log`, 4/4 passed. Combined relevant legacy result is 30 passed/0 failed after the fixture repair.

`npx tsc --noEmit` initially found the narrow work-files snapshot typing issue, fixed locally. The subsequent run reported only concurrently edited `task-checkpoint-state.ts:71` (archived possibly null); handed to its owner/root. `git diff --check` exited 0. Root owns final integrated build verification.

Limits: isolated PGlite/loopback HTTP only; no native PostgreSQL, JJ/OpenShell, production, paid model, dependency installation or Git operation. Root owns whole-repository/full-suite verification and remaining Task 5 cohorts. These tests do not open any profile gate or close Task 5.
