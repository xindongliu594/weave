# D2 Task 2 DB foundation independent review

Verdict: **PASS for the reviewed DB foundation source and native-runner safety guards; native PostgreSQL execution remains root-owned.** No unresolved actionable defect was found in this slice after the timestamp correction described below. This is not acceptance of all Task 2, HTTP audit boundaries, Task 6 retention, Task 8 restore, JJ deployment, current authorization, or the D2 module.

## Scope and evidence

Read `AGENTS.md`; Task 2 and the linked Task 6/8 constraints in `docs/superpowers/plans/2026-10-20-enterprise-observability.md`; the Task 1 writer/schema and `task1-independent-review.md`; and these files:

- `apps/api/src/audit-outbox.ts`
- `apps/api/src/audit-events.ts` (only product change is exporting the existing strict normalizer)
- `scripts/test-observability-postgres.mjs` and its declaration
- `tests/observability-test-runner.test.mjs`
- `tests/audit-outbox.test.ts`
- `tests/fixtures/observability/project-once.ts`

The reviewer ran **only** `node --test tests/observability-test-runner.test.mjs`: exit 0, **4 passed, 0 failed, 0 skipped**. Its loopback TCP sentinel saw zero connections for rejected URLs and rejected test arguments. No PostgreSQL, PGlite, JJ service, model, dependency installation, product-source edit, or commit was performed by this reviewer. Only this review artifact was written.

## Native runner safety gate: PASS

The runner validates an explicitly supplied `OBSERVABILITY_TEST_DATABASE_URL` before loading `pg` or opening a connection. It accepts only PostgreSQL URLs with `127.0.0.1`, `localhost`, or `[::1]` and the literal `weiwu_observation_test_` database prefix, rejects URL queries/fragments and percent-encoded database names, and does not fall back to ambient `DATABASE_URL`. Test arguments are an exact, duplicate-free allowlist containing only the audited native fixture. Errors print fixed codes rather than URLs, credentials, or raw database exceptions.

Each allowed suite receives a newly generated `weiwu_observation_<32 hex>` schema. Cleanup occurs only after this invocation successfully creates that schema, validates its generated name, and verifies PostgreSQL ownership by the current user. The native fixture repeats explicit URL, schema shape, current search path, and ownership checks before resetting only that schema. The restart worker independently rejects absent explicit test configuration, requires the native-runner marker and generated schema shape, and checks ownership before projecting. Native worker configuration is built from the explicit guarded URL rather than the inherited application database URL.

The guard tests passed before root was advised that this scoped runner could be used. Actual disposable database selection and native execution are separate root responsibilities.

## Projector contract review: PASS

- Options reject invalid limits and invalid time before checkout. Due-row selection is bounded to 1..100 and uses `FOR UPDATE OF o SKIP LOCKED`. Advisory lock `918278` is acquired before outbox locks and count inspection; the current repository search found no conflicting use outside this projector. This serializes competing publishers and the 100,000-row cap.
- Canonical source schema, complete normalized payload, source ID, actor, action, resource/departments, all stored correlation links, outcome, reason, changes, employee attribution and authority metadata are checked against the source columns. Outbox ID/source ID/run/action/payload and absence of a conflicting projection are checked before publication. Schema 2 reuses the strict writer normalizer and rejects noncanonical normalized content. The schema 1 decoder permits only the existing legacy identity adapter surface, preserves historical actor range, and supplies no invented current authority.
- The summary uses only validated structured fields and a deterministic hash of the complete canonical payload. Arbitrary raw properties or legacy free-text reasons do not pass into it. The module imports no filesystem/network writer, and the active-JSONL fixture verifies the separate archive appender remains the only file writer.
- Projection insertion and outbox publication marking occur in the same database transaction; return IDs are produced only after acknowledged COMMIT. Per-row savepoints keep invalid/conflicting rows pending and allow the batch to continue. Only fixed error codes are persisted. Retry delays are computed from the current persisted attempt count at 1/2/4/8/16/30 seconds, capped at 30 seconds; attempts saturate at PostgreSQL integer maximum.
- Outer transaction/COMMIT failures roll back and attempt bounded retry metadata updates only for still-pending rows. A durable COMMIT whose acknowledgement was lost cannot be changed back to pending or republished by this recovery path. The function returns a fixed storage error for unknown acknowledgement/storage failure and does not rerun business effects.
- The cap rejects further projections without removing evidence. No current code prunes canonical audit, pending outbox, or projections that the Task 1 duplicate contract still needs.

## Timestamp issue resolved during review

Root independently identified a real precision defect in the first source version: `summaryFor()` converts a PostgreSQL timestamp through JavaScript `Date`, truncating microseconds; inserting that display string into `audit_run_projection.occurred_at` makes Task 1's exact `p.occurred_at=a.occurred_at` duplicate check fail after successful publication. The reviewer confirmed that code path and communicated the same finding.

The final reviewed source now inserts the projection with `INSERT ... SELECT ... occurred_at ... FROM human_audit_events`, keeping PostgreSQL's exact source timestamp inside SQL, and checks that exactly one projection was inserted. A deterministic regression fixes the source default to `2026-10-20T00:00:00.123456Z`, compares the two SQL timestamps, and retries the identical published event. The reviewer inspected that correction and regression; its execution is part of root's DB gate, not independently claimed here. The summary's millisecond display timestamp does not participate in the SQL duplicate relation check.

## Test coverage inspected and remaining gates

The test source contains independent native publishers, a separately locked outbox row proving SKIP LOCKED selection, two publishers competing for the last cap slot, and guarded worker process restarts. It also covers batch bounds, full linkage mismatch, strict source validation, canonical hash/legacy attribution, scheduled retries, failures before and after COMMIT, current persisted attempts during commit-recovery races, cap preservation, and zero JSONL writes. These are inspected test assertions, not claims of native test execution by this reviewer.

Root must still run and retain the actual guarded native PostgreSQL results; PGlite cannot substitute for independent backend lock/race evidence. Typecheck/build and broader identity/audit regression execution are likewise root-owned.

The previously documented Task 6 pruning integration gate remains: Task 1 rejects published outbox rows whose projection is absent. An explicit verifiable pruned/publication rule and duplicate-after-prune acceptance test are needed before lawful 30-day/100,000-row pruning can delete projections. Task 8 destination-preserving restore and its published-marker/rebuild rule also remain separate gates. This foundation slice implements neither retention nor restore, so its current preservation behavior does not conceal those dependencies.
