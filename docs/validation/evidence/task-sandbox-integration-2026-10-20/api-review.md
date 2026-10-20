# Task 4 API/device bridge independent review

Verdict: **PASS for the reviewed API/device bridge scope.** No definite correctness, authorization, private-data projection, or replay finding remains. This is not approval to open the execution profile or to mark all of Task 4/B2 complete.

Base: `a581e7a07a67161efc8f4e992663c8c2cd19d40d`; reviewed the working-tree changes against HEAD on 2026-10-20. Read `AGENTS.md`, Task 4 of `docs/superpowers/plans/2026-10-20-task-sandbox-integration.md`, and `task-4-api-report.md`.

## Reviewed scope

- `apps/api/src/local-execution.ts`
- `apps/api/src/execution-backend.ts`
- New `apps/api/src/task-operation-admission.ts`
- `apps/api/src/task-execution.ts`
- `apps/api/src/task-canonical.ts`
- New `tests/task-operation-bridge.test.ts` and changed execution-backend, task-canonical, and task-execution-scope fixtures/assertions
- Narrow desktop follow-up: removal of the same-visible-revision/scopeHash restriction in `advanceTaskScope`

The surrounding canonical admission, permission implementation, native manifest/file-access binding, approval routes/schema, device journal/error mapping, and task workspace planner were read to evaluate the changes.

## Findings

None.

## Boundary checks

- Enqueue requires a registered active full task key and exact host public scope. The trusted resolver rechecks active archive assignment/session/attempt/contract, snapshot capability hashes, immutable input lineage, own committed outputs, current canonical baseline, and local OpenShell target.
- Poll, start, wait, and authenticated result admission repeat current permission/scope/lease checks. Exact SQL approval arguments remain original; device transport gets a separate derived partial-workspace revision. The existing unique `approval_id` prevents reuse for a second operation.
- The task device projection enumerates fields explicitly and omits the private task scope and full canonical manifest. Native transport paths and fixed plugin identity come from trusted scope/manifest data; the original queued arguments remain intact.
- Prepare is durable per complete task key. Reopening reuses that operation, checks the committed prepare identity and latest committed successful task result, and compares its visible revision to the renewed authorized imports. Enqueue also rejects duplicate prepare records.
- Queued/claimed/started work, unknown/pending merge, completed unmerged work, and failed/cancelled started unknown outcomes remain fenced. `LOCAL_OUTCOME_UNKNOWN` cannot escape the fence by asserting `notExecuted: true`. A new generation over existing task rows cannot bypass unresolved operations.
- Successful task receipts bind the exact operation/key/scope and visible before/after revisions. Subsequent task results must retain the saved sandbox ID and local workspace. Current-state withdrawal preserves authenticated late evidence without publishing it as canonical.
- Canonical merge reuses existing durable validation/CAS and complete manifests. The changed native validator uses the queued trusted transport binding, matching the new immutable-original-arguments behavior.
- Desktop scope rolling still requires identical key/binding/write paths, the actual saved visible revision, monotonic authorized reads limited to declared outputs, and the current input manifest. Removing the extra scopeHash/revision condition permits an unrelated canonical commit without widening authority.
- `assertExecutionProfile` remains closed and unchanged.

## Independent verification

Ran `node --import tsx --test --test-concurrency=1 tests/execution-backend.test.ts`: **4/4 passed**, exit 0. This suite made no database queries or model requests.

No integration database suite was rerun while another worker owned the isolated flow test slot. The worker's reported 10 bridge + 17 canonical + 13 admission/heartbeat + 31 unit checks and TypeScript success were inspected as supporting evidence, not represented as independently rerun checks.

## Considered and set aside

- Approved-row revocation between durable receipt and merge: no current product route mutates an already decided approval; direct database tampering is outside this review's trusted-database boundary. No finding was filed from that hypothesis.
- Full ProductDshRuntime/Handoff behavior, dynamic-tool guard completeness, and runtime composition belong to the parent's parallel review scope.
- Task 5 recovery/consumers/lifecycle maintenance, actual OpenShell isolation and CLI/process fencing, independent PostgreSQL locks, JJ deployment, and real model business acceptance remain their existing later gates.

Only this review report was written. No source, dependency, model configuration, database, production service, or JJ state was changed by this review.

## Resolved full-runtime integration follow-up

Final narrow verdict: **PASS after the file-revision integration correction.** No definite issue remains in this follow-up diff. The earlier static PASS missed the actual file wrapper argument shape; it must not be used as evidence that the pre-fix file transport worked.

The genuine Runtime-to-HTTP path subsequently exposed a real integration defect: `filesystem` and `artifact_write` carry `expectedWorkspaceRevision = scope.workRevision` (the full canonical revision), but the API's previous transport conversion covered only terminal/native operations. The desktop remote executor compares that field with its task-visible files. When canonical includes an unrelated private file, the two hashes differ and legitimate file tools fail before executing. The new targeted RED log confirms this exact mismatch (`02945e…` full versus `00b766…` visible).

Reviewed the correction in `apps/api/src/local-execution.ts:146-152`, the file wrapper construction in `services/agent-runtime/product-tools.mjs:73-86`, the remote executor revision check, the new `file operations preserve canonical arguments and transport only the visible revision` test, the updated bridge fixture call sites, and both `task-4-api-file-revision-{red,green}.log` files.

- Every task non-prepare operation now checks the original full revision and exact public scope in its arguments before insertion. File read/write path checks and context admission remain in force.
- The separate `deviceArguments` object now translates the expected revision to `revision(scope.workspace.importedFiles)` for file tools as well. `approvedArgs` and the SQL `payload.arguments` are not mutated; terminal approval equality and native trusted metadata retain their existing behavior.
- Prepare remains excluded and retains its exact empty-arguments/imported-files contract. The legacy branch is unaffected by this task-only change.
- The new regression uses a private canonical file to force different revision domains, exercises real HTTP poll/start/result for both filesystem and artifact write, checks original SQL arguments and transport values, checks canonical preservation, and rejects stale full revision/missing argument scope. The rejection guards precede the operation INSERT, so those cases cannot enqueue.
- The inspected GREEN log reports **11/11 passed**. These integration checks were run by the API worker, not rerun by this reviewer while the full-flow worker owned the DB slot.

Reviewed final `local-execution.ts` SHA-256: `e9394ca4c1a6068b1c26026b7625a2e8ba7f33fbc23bf2af3e9b318024b5ee20`. This follow-up made no source changes and ran no database tests. The parent's full-runtime rerun and all previously listed later gates remain separate.
