# Task 5 checkpoint / recovery interface map

Read-only mapping against Task 4 (`8cda280`), 2026-10-20. No implementation, tests, DB, JJ, models, dependency changes or commits performed. Full Task 5 remains the gate; this map does not defer its consumer, maintenance or backup requirements.

## Actual contracts and ownership boundaries

- `packages/contracts/task-execution.ts`: `TaskExecutionScope` already contains private `workspace`, `inputOrigins`, `capabilityHash`, `key`; `scope.workRevision` means **complete canonical baseline**, not task sandbox bytes. Before-tool task byte revision is `revision(scope.workspace.importedFiles)`; after-tool it is `taskExecution.afterWorkRevision` / `TaskMergeReceipt.workRevision`.
- `apps/api/src/task-canonical.ts`: actual `CanonicalRef={revision,manifest,mergeId}`; `TaskMergeReceipt={mergeId,operationId,key,scopeHash,beforeRevision,afterRevision,workRevision,status:'committed'|'rejected'}`. Neither ref includes archive owner/runId. Move these type definitions, unchanged initially, into shared contracts; retain compatibility re-exports if needed. `readCommittedCanonical(traceRoot,run)` verifies complete manifest, bounded immutable objects and head receipt, then returns `{ref,files}`. A non-null head receipt must belong to `run.id`.
- `services/agent-runtime/archive-objects.mjs`: reuse `storeArchiveObjects`, `readArchiveObject`, ordinary-file/link checks, bounded sizes, SHA validation, fsync and archive accounting. Canonical and checkpoints already share `<run>/checkpoint-objects/<sha>`. No second object store.
- `step-checkpoints.mjs`: only version 1 today; writer scans `workspace`, stores objects, rescans, appends journal last. Readers reject `version!==1`. v2 must never scan `LocalRunExecutor.root` as task work: root is the full canonical compatibility cache.
- `LocalRunExecutor`: `prepareTask` verifies latest persisted task result + sandbox identity, refreshes scope; `execute` waits, validates/commits via existing operation table, rebuilds cache, returns `taskResultSummary`. `taskResultSummary` intentionally excludes full files/full canonical manifest; its artifacts are scoped. Existing `prepareTask` returns full private scope only in process.
- `HandoffGate`: already holds private complete scopes in `executionScopes`; mutex, `checkpoint`, `observe`, `commit` remain synchronous except `exclusive`. Add a second private map for prepared checkpoint refs. Do not put refs on returned employee results, arguments, protected employee context or `artifact/updated`.
- Wrapper seams: product `prepareTaskTool` before pre-tool checkpoint; product/native `sandbox.execute` before synchronous `handoff.observe`; host completion already awaits `prepareTaskTool` before `handoff.prepare/commit`; `waitForProtectedContext` awaits the employee-owned DSH `sessions.flush`, then takes Handoff mutex and writes `cycle-complete`. DSH policy remains mounted on `EmployeeHostFactory` hosts, not the coordinator.

## Smallest proposed interface

Names below are proposals, not existing APIs.

```ts
type TaskCheckpointRefs = {
  profile: 'task-attempt-openshell-v1'; key: TaskAttemptKey;
  inputManifest: TaskWorkspace['inputManifest'];
  inputOrigins: TaskInputOrigin[]; // fixed real source, not inferable from Origin alone
  workManifest: TaskWorkspaceManifestEntry[];
  canonical: CanonicalRef; lastMerge: TaskMergeReceipt | null;
  scopeHash: string; capabilityHash: string;
  recoverySource?: {sourceRunId:string;sourceTaskId:string;sourceAttemptId:string;
    checkpointId:string;checkpointSha256:string};
};
// In-process trusted API; no model-callable endpoint/tool.
LocalRunExecutor.prepareCheckpoint(context, signal,
  {phase:'before-tool'|'after-tool'|'boundary', operationId?:string}
): Promise<TaskCheckpointRefs>;
HandoffGate.bindCheckpoint(taskId, attemptId, refs): void;
commitStepCheckpoint({archive,boundary,receipts,taskRefs}): StepCheckpointV2;
// Existing {workspace,...} overload and v1 digest stay unchanged.
```

`StepCheckpointV2` preserves `{id,runId,boundary,files,receipts,sha256}` and adds the planned v2 fields above. `files` must equal `workManifest`, never `canonical.manifest`; same validated object refs can be deduplicated. Keep size/count limits on each manifest and total archive use. `inputOrigins` is one explicit schema addition needing root ratification: current `inputManifest.origin` does not retain import snapshotId/agentIds/source.kind, and copying only its Origin cannot prove the fixed source. An alternative is embed that source in each input manifest row, but do not silently lose it or reconstruct by path.

`prepareCheckpoint` should live in a small API helper (e.g. `task-checkpoint-state.ts`) called by the executor. It uses the existing project→run→operation fence, validates actual active assignment/current permissions, queries unresolved SQL operations, reads the committed head, verifies the latest task operation's original queued scope/result/merge record and exact sandbox identity, persists/checks every referenced input/work object, and returns immutable private refs. No fresh employee command, export worker or additional execution operation is necessary: validated `row.result.result.files` already is the post-tool export. Before-tool uses prepared scope's known byte revision; after-tool must bind the exact `operationId`, not whichever row happens to be latest.

`canonical` may be the latest B commit while `lastMerge` is A's latest commit. Validate them independently; do **not** demand equal mergeIds/revisions. Require workManifest digest to match the task receipt and selected phase. The archive owner of a bare canonical ref is checkpoint.runId; a foreign source ref must always carry sourceRunId separately.

Order under existing mutex: awaited refs preparation → private bind → synchronous checkpoint; after execution: awaited exact-operation refs preparation → private bind → synchronous observe (which writes tool-result checkpoint). Host acceptance and cycle/DSH flush follow the same order. Missing/stale refs, failed object read/fsync or rejected DSH flush abort the boundary and prevent the next dispatch. Synchronous commit can revalidate immutable local object refs; it must not pretend to await sandbox I/O.

For `checkpointContract` / `checkpointEnvironment`, keep v1 algorithms byte-for-byte. A v2 overload hashes profile/key, fixed input/origin digest, permission/capability versions, and complete admitted backend/policy identity. Source key and sandboxId necessarily differ from the new target: authenticate source binding first, then compare explicitly defined semantic compatibility and create a fresh target binding. Never compare a hash including old key directly to one including new key and silently ignore the mismatch. No terminal approval is copied; v1 terminal_test does not become task-profile verification.

## Branch recovery: keep B and all later audit history

Current blockers requiring real changes:

1. `selectStepCheckpoint` is synchronous/archive-only, rejects any other task change after checkpoint, and returns globally truncated events. `run-management` passes those truncated events to `buildCheckpointContext`; this would erase later B context. It also passes checkpoint.files as a whole-run workspace override to `resumeHandoff`.
2. `run-coordinator.launch` restores checkpoint.files directly into child artifacts, then initializer treats that directory as the entire canonical. This would lose B.
3. `resolveTaskScope` and `admitTaskOperation` both categorically reject `snapshot.recovery` / handoff checkpoints; `pinnedInputs` only accepts current-run producer events. Recovery needs narrowly validated source ancestry, not removing checks wholesale.
4. `acknowledgeUnknownOperations` currently permits a child run after event-only unknown acknowledgment. For task-profile operations/merges, an acknowledgment is not a durable reconciliation receipt.

Root's preferred pending ruling (received during mapping): avoid fake successful device/recovery operations. While **child canonical is still NULL**, a trusted initializer verifies the approval-pinned source latest complete head and selected A checkpoint, builds a current-head pure planner scope for A's approved paths, applies selected A work as a proposed export, and CAS initializes child NULL→complete candidate. Read-only inputs must match current canonical; only authorized A outputs may differ; B survives. Source is never modified. Do not reset an existing child head. Record distinct recovery-initialization provenance, not a command/merge/device execution receipt.

This reuses `initializeTaskCanonical` directly: it already has project→run locks, lease/permission checks, NULL-only head publication, object persistence and initial `{mergeId:null,receipt:null}` shape. `readCommittedCanonical` accepts that initial shape. Copy/verify source blobs into the child's object directory before child publication. Copying the parent head verbatim is invalid because its receipt.key.runId names the parent.

The helper `buildWorkspace` insists imported bytes match its canonical baseline. Build the **restore plan** against latest source canonical (including latest A output read authorization/provenance); pass selected checkpoint files only as the proposed exported work. After publishing candidate, seed new A's authorized own outputs with explicit checkpoint provenance. Do not place older work bytes inside a mismatched scope.importedFiles. No helper relaxation or new engine is needed. Pending implementation detail: record/retry validation of recovery-initialization must survive SQL commit acknowledgment loss and archive append failure; later retries inspect the published child head + durable source record and never rerun a command.

Pin `{sourceRunId, source CanonicalRef, selected checkpoint id/SHA}` under the approval transaction and verify again at initialization; changed source head, missing/bad object, permission/capability/input/backend/profile mismatch, or unresolved source SQL operation/merge blocks. New child run/native attempt/generation/sandbox identities are fresh. The original source archive/events/operation table/approvals/costs remain untouched.

Use full latest events for B/completed seals, costs, unknowns, rework and source history. Only A's selected task context/session cursor is cut to the selected point. `resumeHandoff` must inspect the candidate complete manifest, not A's work manifest. Selected A checkpoint's recoverySource is source identity, never relabeled as a current-run accepted producer. v1 browser/backup and legacy recovery remain unchanged; enterprise upgrade can import only currently approved files and cannot inherit old passing evidence.

`unresolvedOperations(events, taskOperations?)` can add an optional persisted index while preserving existing event-only callers/classifications and callId. Add optional category/key/operationId/mergeState fields. Reuse the SQL predicate already in `assertNoUnresolvedTaskOperation`: started/queued/claimed, completed task result without merge, pending/unknown merge, uncertain failed/cancelled or late result remain unresolved. `runtime/operation-finished` only closes execution; it cannot close the separate merge entry. Only matching committed/rejected/reconciled durable evidence closes it. Backups may preserve structurally sound unknown evidence but cannot certify it as runnable.

## File ownership for implementation (suggested, no work started)

| Owner | Exclusive source edits | Consumes/provides |
| --- | --- | --- |
| Core checkpoint/runtime | shared `task-execution.ts` + index, `step-checkpoints.mjs/.d.mts`, `recovery.mjs/.d.mts`, `handoff.mjs/.d.mts`, `task-tool-context`, product/native wrappers, host boundary | Owns agreed v2 schema; private bind API; awaits executor preparation; v1 compatibility. |
| Trusted recovery/API | `local-execution.ts`, helper `task-checkpoint-state.ts`, `task-canonical.ts`, `task-execution.ts`, `task-operation-admission.ts`, `step-checkpoint-recovery.ts`, run-management/coordinator/recovery-conditions | Provides prepareCheckpoint and source-pinned initialization; consumes shared schema; owns both recovery guard changes. Coordinate the shared filename `task-execution.ts`: packages vs apps are different files. |
| Readers/maintenance/backup | work-files/work-records/planning context/app canonical readers, storage-lifecycle/governance, backup/checkpoints and associated tests | Uses readCommittedCanonical and agreed operation/checkpoint refs. Avoid editing local-execution itself; ask trusted owner for required exports. |
| Root integration | initialization event/provenance policy, source snapshot shape, shared test fixtures and package/index edits if contention | Owns contract freeze and full Task 5 review gate; no scope shrink to checkpoint-only work. |

Do not introduce runtime import `step-checkpoints → task-canonical`: the reverse already exists. Shared types plus API-supplied verified refs avoid a cycle. Preserve full manifest privately in trusted API/Handoff/archives; public employee results remain the existing taskResultSummary projection.

## RED cases with existing fixtures

- Extend `step-checkpoints.test.mjs`: v1 still readable; v2 ref round-trip; files===workManifest; malformed origin/key/hash/receipt; foreign ref owner; missing/corrupt/hardlinked object; failed append never publishes checkpoint; no scan of full canonical cache. Existing temp archive/object fixtures suffice.
- `tests/task-checkpoint-recovery.test.ts`: reuse `task-canonical.test.ts` fixture/completedWrite and `checkpoint-branch.test.ts` archive branch fixture. A checkpoint→A later output→B commit→stop→select A→new child initialization must retain B, restore selected A only, leave source bytes/events/operations intact, create new key/sandbox, preserve original input and explicit checkpoint origin. Replay initialization after publication must not add commands/operations or reset newer child head.
- Same test, table-driven: SQL started/completed-without-merge/pending/unknown despite runtime-finished; acknowledgment=true still blocked; missing object; permission/native-bundle/input/image/policy/profile change; source head changes after approval; no terminal approval/evidence carryover. Child/source object hashes and operation counts are assertions.
- Extend `task-sandbox-flow.test.mjs` (and actual Product fixture where appropriate): async prepareCheckpoint promise holds before-tool body, tool-result observe, node-accepted and cycle/flush; reject promise means next body/model count zero. Employee JSON never contains private/B paths or full canonical manifest. Reuse `employee-checkpoint-policy.test.mjs` actual installed-policy barrier harness for flush failures; do not mount policy on coordinator.
- Extend `tests/task-sandbox-flow.test.ts` actual Product→HTTP fixture: capture A refs before B then renew; lastMerge A and canonical B may legitimately differ; stale approval never gets transport. Add checkpoint assertions to existing engineering fixture, do not label it physical/JJ/model acceptance.
- Full Task 5 tests still required: canonical readers seeing one complete head or failing during partial cache; scopes A/B maintenance and unknown capacity; backup raw task scopes/operations/merges/heads/blob refs, missing-ref rejection and audit-only restore. Reuse existing canonical fault points and backup-checkpoints fixtures. No DB or test execution in this mapping task.

## Root rulings still to record before implementation

1. Ratify inputOrigins as additive v2 field (or an equivalent source-bearing inputManifest schema).
2. Ratify source-pinned NULL→candidate recovery initialization and durable initialization-record placement/retry rules, including a source change after approval.
3. Specify source-key/target-key and environment compatibility comparison: full identity is authenticated, fresh binding is intentional, old terminal approval/evidence does not carry.
4. Freeze API/helper and source ownership above before parallel edits; checkpoint maps alone do not complete Task 5.
