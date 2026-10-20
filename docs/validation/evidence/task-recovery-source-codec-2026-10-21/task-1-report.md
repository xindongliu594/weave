# Task 1 report — private recovery record codec

Status: implementation, bounded regression, type-narrowing correction and build complete; independent spec/quality review is owned by root and is not claimed here. Baseline requested by controller: `35d2b1f`; no Git commands/mutations performed by this worker.

Only deliverable source changes:

- `apps/api/src/task-recovery-state.ts` (new, 9,076 bytes)
- `tests/task-recovery-state.test.ts` (new, 13,567 bytes)

Private logs/report reside in this plan directory. No database/schema, product routes, shared runtime types, existing codec/redactor, test profiles, permissions, credentials, deployment, model or network changes. No child agents.

## API

```ts
decodeTaskRecoverySource(value: unknown): TaskRecoverySource
taskRecoveryApprovalDigest(value: unknown): string
decodeTaskRecoveryInitialization(value: unknown): TaskRecoveryInitialization
taskRecoveryInitializationDigest(value: unknown): string
decodeTaskRecoveryEvidence(value: unknown): TaskRecoveryEvidenceV1
```

Also exports `TaskRecoveryInitializationInput` (initialization without its `digest`) and the three return types above. `taskRecoveryInitializationDigest` requires the exact unsigned record, including a valid `approvalDigest`; it does not omit fields for callers. Source digest helper validates the source shape and cross-field bindings first. All malformed states return AppError status 409/code `TASK_RECOVERY_STATE_INVALID` with fixed Chinese text and no input payload.

Passing these codecs proves only format consistency and digest agreement. It does not prove an authentic source, authorize recovery/execution, establish a network connection or restore any project. A SQL NULL is rejected; an explicit empty V1 evidence object is accepted without manufacturing a live source.

## Implementation and self-review

- Uses installed Zod strict objects at every nesting level, existing `validPath` and `canonicalManifest` from `apps/desktop/local-executor.cjs`, and Node SHA256.
- Manifest revision preserves the original fixed `path,size,sha256` object order and UTF-16 path sorting. New domain-separated record digests recursively sort object keys, preserving array order.
- Enforces source/checkpoint/authority/head ownership and committed receipt requirements, safe integers, lowercase UUID/SHA, backend identity version, read/write/delta limits, case-insensitive Windows aliases and prefix collisions, no removals or implicit changed/added files, and no hash-equal fake changes. Actual checkpoint work-set/dependencies remain Task 2's responsibility.
- JSON preflight rejects undefined, nonfinite/negative-zero-loss, function/symbol/bigint, accessors, symbols/nonenumerable fields, custom objects, Proxy objects, sparse/augmented arrays and cycles before encoding; rejects records over 512 KiB. It does not mutate or repair input. It compares with the existing pure redactor and rejects rewritten values; the redactor was not modified.
- Identity strings reject Unicode Cc characters and surrounding whitespace. Gateway/image remain bounded opaque identity data.
- Tests cover valid source, signed/unsigned initialization and V1 evidence; insertion-order stability; both digest domains; exact limits (128 files, 5 MiB each / 20 MiB aggregate); unchanged child/no delta; strict nested fields; source/child/key/sequence/receipt corruption; noncanonical/unsafe paths; scope/delta mismatch; lossy JSON; archive rewriting. Manifest negative fixtures are resealed with the existing canonical algorithm so rejection does not depend on an unrelated stale revision.

## Verification evidence

Commands below ran from the repository root. Node was v24.15.0. No dependency installation or full Product suite was run.

1. Initial RED: `node --import tsx --test tests/task-recovery-state.test.ts` → exit 1, 1 file failed because the requested implementation module did not exist; Node duration 491.646 ms, shell wall 0.725 s. Log: `task-1-red.txt`.
2. Assertion RED after a minimal all-reject stub: same command → exit 1, 9 tests: 7 pass / 2 fail, Node 3,359.136 ms, shell wall 3.603 s. Valid record and valid empty V1 evidence both failed with the missing-behavior rejection. Log: `task-1-red-assertions.txt`.
3. Initial GREEN: same command → exit 0, 9/9 pass, Node 3,338.735 ms, shell wall 3.567 s. Log: `task-1-green-initial.txt`.
4. First bounded regression:

   `node --import tsx --test tests/task-recovery-state.test.ts services/agent-runtime/step-checkpoints.test.mjs services/agent-runtime/task-checkpoint-v2.test.mjs tests/task-accepted-stop-state.test.ts`

   → exit 1, 42 tests: 38 pass / 3 fail / 1 skip, Node 20,385.323 ms, shell wall 20.634 s. Log: `task-1-green-regression.txt`. The three failures were existing tests failing while creating their hardlink fixtures with Windows sandbox EPERM: `hardlinked workspace files cannot enter a checkpoint`, `hardlinked stored objects are refused on restore and reuse`, and `v2 authenticates private canonical objects and refuses corrupt or hardlinked refs`. No product assertion failed in those cases.
5. Additional RED for Unicode control and Proxy acceptance, with strengthened boundary fixtures: new suite command → exit 1, 12 tests: 10 pass / 2 fail, Node 3,338.629 ms. Both new tests failed with `Missing expected exception` before the implementation was tightened. Log: `task-1-red-controls-proxy.txt`.
6. Final GREEN, root-authorized `require_escalated` rerun of the exact same four-file bounded command in ordinary local execution → exit 0, 45 tests: 44 pass / 0 fail / 1 skip, Node 14,891.050 ms, shell wall 15.085 s. All 12 new codec tests and all three hardlink tests passed. Log: `task-1-green-regression-unsandboxed.txt`.

The one skipped existing test is `existing-table product migration adds a nullable marker without changing prior task history`, whose own gate requires `SIMULATED_INTEGRATION=pglite`. No claim is made about that migration here. The existing stop-state suite itself uses its pre-existing isolated SQL fixture for admission tests; the new codec tests use no database or API fixture. The final test process completed and the single test slot was released to root.

## Root build feedback and type correction

Root's initial build failed with TS2345 at the three object APIs in `assertJson` (`Reflect.ownKeys`, `ancestors.add`, `ancestors.delete`): TypeScript did not retain the intended object narrowing after the indirect never-returning arrow call. Original failure logs `task-1-build.txt` and `task-1-build.txt.json` were preserved untouched. Root explicitly returned the single test slot for correction and authorized the new codec suite and `npm run build`.

Correction: the same malformed/proxy/cycle guard now uses `return invalid()` so control flow explicitly terminates on the rejected path. This is one word added, with no assertions, casts, removed checks, or changed rejection behavior; undefined/non-JSON tests remain unchanged.

- `node --import tsx --test tests/task-recovery-state.test.ts` → exit 0, 12/12 pass, no skip; Node 3,178.194 ms, shell wall 3.395 s. Log: `task-1-type-fix-codec.txt`.
- `npm run build` → exit 0; `tsc --noEmit` and Vite production build both succeeded, 1,720 modules transformed; Vite 9.68 s, total shell wall 34.566 s. Log: `task-1-type-fix-build.txt`. Vite emitted its existing >500 kB chunk-size advisory; no build errors.

Build generated ordinary ignored `dist/web` output as part of root's explicitly requested command. No additional tracked source/test files were changed. Test slot released after these processes exited.

## SHA256 of final deliverables

Measured using `Get-FileHash -Algorithm SHA256`:

```text
e5d978537531dbfa33bd66ba8f79e7222545d2b6ab712f6fc47cd78687458a77  apps/api/src/task-recovery-state.ts
493b86e864ca73b80c1a929ec6cb8a6236a04e4c66329cd252308d0833dffd43  tests/task-recovery-state.test.ts
```

Limits: no source authentication, SQL binding, object-file verification, actual Task A work-set/dependency verification, planner authorization, product restore, profile, end-to-end API or deployment validation. Those remain separate planned tasks. Independent review is pending root coordination.
