# D2 Task 1 independent review

Verdict: **CHANGES REQUIRED — one P2 contract defect.** This is not acceptance of D2, current resource authorization, native PostgreSQL concurrency, deployment, or real business behavior.

Reviewed against HEAD `a581e7a07a67161efc8f4e992663c8c2cd19d40d`, AGENTS.md, the strict shared contract and Task 1 in `docs/superpowers/plans/2026-10-20-enterprise-observability.md`, and `task1-report.md` / `task1-brief.md`. Scope was limited to `apps/api/src/audit-events.ts`, `audit-schema.ts`, `identity-schema.ts`, `identity-store.ts`, `tests/audit-events.test.ts`, and `tests/identity-store.test.ts`. At root's explicit follow-up, the established canonical merge receipt/planner contracts were also read to verify the audit schema's compatibility; concurrent API/runtime implementations were otherwise not reviewed.

## Actionable finding

**[P2] Preserve canonical SHA-256 revisions in task.merge changes — `apps/api/src/audit-events.ts:39`.** Both `beforeRevision` and `afterRevision` use the integer `count` schema, but the existing `TaskMergeReceipt` in `apps/api/src/task-canonical.ts:22` and `TaskWorkspaceMergePlan` in `packages/contracts/task-workspace.ts:22` define them as strings. Their actual producer uses `revision()` (`apps/desktop/local-executor.cjs:53`), a SHA-256 of the canonical manifest; `apps/desktop/task-workspace.cjs:132` returns those hashes. Consequently every real canonical merge revision pair is rejected by the new audit writer (and its exported TypeScript type), preventing Task 3 from recording the real merge evidence in the business transaction without inventing replacement revision values. Use the existing strict hash schema for both fields, and add a regression that passes the actual canonical hash revisions and rejects numbers/malformed hashes. Do not convert the hash to a synthetic counter.

Independent reproduction imported only `appendAudit` and the pure established `revision` function. For `one.txt` with base64-encoded `before` and `after`, the real revisions were `2e9706005ccd2bba14921d1b405c2eef6f0cb58c1049f84fcc71c89ae17682dd` and `fd302a374fd539e28733cb365d4c10e13f042763a1e0f89b8cb51fcd2bf7204a`. A valid `task.merge` success envelope with authority and those revisions threw `ZodError` for each field: `expected number, received string`. An asserting fake executor verified **zero SQL queries**. The reproduction command (`node --import tsx --input-type=module`, inline script) exited 0 after asserting that failure. No merge, model, or DB operation ran.

## Checks and findings

- `audit-events.ts:103-124`: apart from the incorrect merge revision field types above, the new writer validates bounded structured input, per-action resource/change schemas, unknown fields, finite numbers, custom getters/prototypes/cycles, identity-only authority scope, and required authority for new successful actions. It builds fresh normalized objects. Actual current authorization remains the trusted A2/C1 caller's responsibility, as specified; this parser is not an authorization gate.
- `audit-events.ts:131-134`: principal conversion validates the full existing Principal and retains only the allowed actor snapshot. Employee/session execution attribution is separate; human browser session, issuer and subject are omitted.
- `audit-events.ts:138-165`: one parameterized CTE inserts canonical audit and outbox without managing the caller's transaction. Duplicate source IDs compare the complete normalized payload and validate the outbox/projection linkage; changed payloads and missing/corrupt relation metadata fail closed.
- `audit-schema.ts:6-36` and `identity-schema.ts:78`: migration remains additive for historical rows, preserves human-user attribution constraints and the existing UPDATE/DELETE append-only trigger, and installs fixed error codes and projection/index structure. Repeated migration and old schema-1 history are covered.
- `audit-events.ts:167-190` and the identity-store re-export: legacy identity calls share the private writer, preserve the old identifier range only in schema 1, map arbitrary legacy reasons to a fixed code, and grant the narrowly scoped identity policy only to the specified bootstrap/OIDC shapes. The documented legacy compatibility surface is not mistaken for new business authority.

## Independent execution evidence

Commands used workspace-owned `TEMP` and `TMP` under `.superpowers/sdd/2026-10-20-enterprise-observability/review-task1-tmp` and set `IDENTITY_TEST_DIRECT_PGLITE=1`.

1. `node scripts/test-integration.mjs tests/audit-events.test.ts tests/identity-store.test.ts`: audit suite **13/13 passed**, zero skipped. The identity child then failed before individual tests with Node native `Fatal process out of memory: Zone`; overall exit 1. This run is not reported as green.
2. `node scripts/test-integration.mjs '--test-name-pattern=legacy audit compatibility' tests/identity-store.test.ts`: the new legacy regression **1/1 passed**, exit 0.
3. `node scripts/test-integration.mjs tests/identity-store.test.ts`: full identity retry **12/12 passed**, zero skipped/failures, exit 0.
4. `git diff --check -- apps/api/src/identity-schema.ts apps/api/src/identity-store.ts tests/identity-store.test.ts`: exit 0; only CRLF notices.

The passing tests exercise business/audit/outbox rollback, standalone outbox failure atomicity, append-only UPDATE/DELETE refusal, source collision changes, projection linkage, invalid untrusted input, employee attribution, preservation of pre-extension history, repeated migrations, and legacy caller compatibility. These are isolated PGlite checks and do not establish independent PostgreSQL backend locks or races. TypeScript/build and native PostgreSQL gates remain root-owned and were not independently rerun here.

## Later integration gates

- **Blocking integration gate before Task 6 retention can be accepted:** its planned 30-day/100,000-row projection pruning must coordinate with `audit-events.ts:158-159`. The present Task 1 contract deliberately rejects a published outbox row whose projection is missing. Retention needs an explicit, verifiable pruned-state/publication rule, plus an identical-source retry test after legitimate pruning, before it deletes projections. Otherwise normal pruning makes valid duplicate appends fail with `AUDIT_RELATION_CONFLICT`. This is a concrete contract dependency; no current retention implementation is claimed or reviewed here.
- The known pre-existing TRUNCATE/restore hazard, native concurrency, actual A2/C1 current-authority checks, and downstream projector/exporter/query work remain their explicit later gates.

No product source files, dependencies, databases outside fresh test fixtures, JJ services, models, or commits were changed by this review. Only this review artifact and workspace test scratch were written.

## Resolved rereview after root fix

**Final Task 1 review verdict: PASS.** The initial CHANGES REQUIRED verdict and reproduced P2 above are preserved as review history; that finding is now resolved.

Root changed only the two `task.merge` revision fields from `count` to the existing strict `hash` schema in `audit-events.ts:39`. The current writer now accepts and persists the established canonical SHA-256 revision values. The new regression in `tests/audit-events.test.ts:28` imports the actual `local-executor.cjs` `revision()` producer, writes its empty/built-file revision hashes through the real isolated SQL fixture, verifies the stored strings unchanged, and rejects numeric versions. The shared hash schema already requires exactly 64 hexadecimal characters and normalizes case.

Independent rereview ran this single filtered command with the same workspace TEMP/TMP, without the integration runner's extra socket/WASM database:

`node --import tsx --test '--test-name-pattern=task_merge_accepts_actual_canonical_sha_revisions_and_rejects_numeric_versions' tests/audit-events.test.ts`

Result: **1/1 passed, zero failures/skips, exit 0**. The fixture itself owns fresh PGlite; it does not use an ambient database. Root's reported RED/GREEN history was not substituted for this independent execution. No broader DB suite was launched during this rereview because the API worker was sharing WASM memory; root owns the final serial prescribed-runner regression gate. The Task 6 projection-pruning gate and other later integration limits above remain open.
