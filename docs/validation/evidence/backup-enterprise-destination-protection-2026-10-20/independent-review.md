# Independent review: live canonical readers and legacy restore destination guard

Date: 2026-10-20. Verdict: **PASS for these two narrow cohorts, with the limits below.** No new actionable severity P0–P3 finding was identified. This is not Task 5 completion or permission to open the task profile.

## Scope and method

Read AGENTS.md and `docs/superpowers/plans/2026-10-20-task-checkpoint-v2-integration.md`, then independently traced the current source, narrow tests and saved logs. Reviewed `live-canonical-reader.ts`; artifact list/download routes in `run-management.ts`; `work-files.ts`; `planning-execution-context.ts`; `work-records.ts`; the recovery-hint SQL/reader wiring in `app.ts`; the parent-canonical sixth argument in `run-coordinator.ts`; `backup-destination.ts`; its `backup.ts` import/call; and `backup-enterprise-protection.test.ts`.

No source/test edits, DB access, services, JJ/OpenShell/model calls, installation, Git commands or test suites were run. The only write is this report. Existing runtime evidence is inspected evidence, not independently re-executed evidence.

## Live canonical readers

- `live-canonical-reader.ts:14–32` selects the supplied actual SQL row's head once through `readCommittedCanonical`, keeps `{ref,files}` together, rejects SQL/archive profile mismatch and unknown profiles, and refuses recovery/resume ancestry without its frozen contract. An initial `mergeId:null` head remains explicitly unsupported. There is no task-profile cache fallback or repair.
- `live-canonical-reader.ts:28–31` checks unsettled live SQL operations and fetches exactly `(run_id, selected.ref.mergeId)`. It requires completed/started/committed/ok status, validates the stored record digest, operation/result/scope identity digests, the SQL head receipt and complete `after` ref, and revalidates the original operation result. Finished JSONL and human acknowledgment do not substitute for that SQL proof. Missing live-operation rows from a restored archive therefore fail closed.
- `run-management.ts:30–34` returns the complete selected manifest and selected verified object bytes. It does not reopen the compatibility cache after selecting a task head. The byte download keeps attachment/CSP/nosniff headers and does not expose the private SQL receipt/ref wrapper.
- `work-files.ts:91–135,151–169`, `planning-execution-context.ts:118–150`, and `work-records.ts:13–24` carry the selected complete canonical manifest into their existing handoff checks; from-run copies selected object bytes. Parent copying requires a supplied trusted selection for the task profile and copies the full selected files. Full retry retains its existing approved-import branch. `run-coordinator.ts:145–147` obtains the parent SQL row and passes that canonical selection as argument six; a task parent without a selection cannot fall back to its cache.
- `app.ts:537–550` includes `project_id` and `canonical_workspace` in the actual SQL run query, then uses the selected complete manifest for the failed/interrupted/cancelled recovery hint. The canonical SQL wrapper is not added to the public run response.
- The reviewed consumers use complete canonical manifests without replacing an accepted task's partial work revision with the complete canonical revision. Root's separately identified `resumeHandoff`/real accepted-work-evidence correction is outside this verdict; it must have its own current evidence before any broader completion claim. This review does not refile that already assigned issue.
- Public authorization is intact: `app.ts:151–166` mounts `apiAccess` before these routers; `api-route-policies.ts:29–30,108–110,135–140` classify the relevant routes as admin; `api-access.ts:7–10,14–39` requires local-owner or authenticated human admin (and human OIDC CSRF for mutations). The narrow router fixtures intentionally omit that outer middleware, so their successful requests alone are not an auth test.

The reader tests are useful behavioral tests rather than copies of the reader implementation: they create two committed operations through the real executor plus HTTP device poll/start/result and canonical CAS, then corrupt/partially replace the cache or object/evidence state and assert externally observed results and nonmutation. They do not preinsert successful merge rows. `report.docx` is actual generated Office bytes used in download and parent-copy assertions; from-run asserts text only. No binary from-run or Office task-generation acceptance is claimed.

Inspected evidence:

- `live-readers-red.log`: 7 intended failures before implementation.
- `live-readers-green.log`: 9/9 passed, including bad/missing objects, SQL unknown despite finished archive/acknowledgment, damaged original SQL proof and unsupported null merge.
- `live-readers-legacy-regressions.log`: work-files 14/14, from-run 1/1, planning 11/11; original work-records 0/4 failed at HTTP 503 before reader execution.
- `live-readers-work-records-green.log`: 4/4 after background-only fixture shutdown repair. Combined relevant legacy result is 30/30, not a claim that the first log itself passed all 30.

Limits: the current 9-test fixture directly appends a minimal accepted event and does not by itself certify the complete real product accepted-work-evidence/full-versus-partial-revision contract. Root's follow-up product test and any handoff correction remain separate. `app.ts` recovery-hint and coordinator parent wiring were statically traced here; those exact product caller paths were not re-executed by this review. PGlite/fixture device evidence is not native PostgreSQL consumer concurrency, JJ, OpenShell or paid-model acceptance.

## Legacy restore destination protection

- `backup-destination.ts:4,10–18` takes NOWAIT SHARE ROW EXCLUSIVE locks over users, memberships, sessions, session lifecycles, OIDC transactions, bootstrap, audit events, outbox and projection. It checks every nonbootstrap table for any row; the default untouched bootstrap singleton is allowed, while activation/consumption/closure/version change is protected. Absent/indeterminate result does not pass. PostgreSQL lock contention maps to the explicit busy rejection.
- `backup.ts:60–73` calls the guard on the original restore transaction/client after the existing run/advisory gates and before TRUNCATE, credential/device deletion, row import, native bundle restore, vault changes, trace-root swap and key replacement. Locks last to transaction completion. A rejected stage is removed through the existing cleanup. Staging into a new directory before this guard does not replace the target.
- This is refusal of unsupported enterprise restore, not preserving import. It neither serializes enterprise history into an import carrier nor introduces a task backup format, task restored-source admission, historical operation activation, or projection reconstruction.

`backup-enterprise-protection.test.ts` uses actual encrypted export/restore HTTP requests, then compares retained SQL records, target artifact bytes, credential key and directory inventory. Its activated-bootstrap-only case exercises protection without depending on users/audits. The user/membership/audit/outbox/projection case proves rejection before clear/swap. It is behavior-level evidence, not a mock assertion of SQL strings.

Inspected evidence:

- `restore-protection-green.txt`: new actual HTTP 3/3 and existing extension-backup 6/6 passed.
- `restore-protection-native-postgres.txt` and `../2026-10-20-real-postgres-validation/cluster-d417e47e-4efb-4fcc-a2b7-271a285ecfae/result.json`: PostgreSQL 17.10, independent backend PIDs 16280/14820, recorded blocking relation, protected-after-commit rejection and immediate busy rejection for in-flight identity mutation. The report records stopped server and removed test data.
- Read `../2026-10-20-real-postgres-validation/native-restore-protection-probe.mjs`: the probe imports the production guard, uses distinct checked-out clients and `pg_blocking_pids`, and asserts both ordering directions. This corroborates the helper's lock claim beyond single-connection PGlite.

Limits: the native probe covers the guard and identity mutation concurrency, not the whole encrypted HTTP restore on native PostgreSQL or every protected table independently under contention. Session/OIDC/audit table coverage was checked in source and schema; the HTTP fixture does not independently seed each transient session table. No preserving import, task backup validation or full disaster-recovery acceptance is implied.

## Gate

These two cohorts can remain accepted within their stated closed-profile boundary. Task 5 remains incomplete: recovery provenance/initialization, full accepted product evidence, maintenance/capacity, task backup evidence carrier and broader/native/physical acceptance are not certified by this report.
