# Independent runtime/core v2 review

Verdict: **CHANGES REQUIRED** (2026-10-20).

Scope: non-recovery shared contracts, step-checkpoint v2 codec, Handoff private refs, task tool/native wrappers, Host completion/cycle barriers and Product executor preflight. Read AGENTS.md, the frozen integration plan, runtime-codec-report.md, the changed source and three associated test files. This is an independent static review; no source/test mutation, database, physical JJ/OpenShell run, paid model, dependency change or large suite run was performed.

## P1: A synchronous node-accepted checkpoint failure can release dependent work

Location: `services/agent-runtime/handoff.mjs:221-228`, with failure isolation at `handoff.mjs:89-90` and completion handling at `services/agent-runtime/host.mjs:344-354`.

The actual Host first calls native `next()` (line 346), which durably marks the task completed and queues dependents. `HandoffGate.commit()` then appends `handoff/accepted` and writes `committed` before calling the synchronous node-accepted checkpoint (lines 223-225). If the boundary append or v2 checkpoint append/fsync throws, `checkpoint()` latches only that task/attempt/generation (line 111), and the Host catch rolls back only `accepted` (line 354 / Handoff line 228). The native completed state, accepted journal event and `committed` entry can already remain.

Once the shared mutex releases, a dependent task uses a different key and passes `assertCheckpointReady()`; the failed task's generation latch cannot block that downstream task. A new generation also does not match the old latch. Thus the claimed guarantee that a synchronous checkpoint persistence failure prevents the next model/command is incomplete, despite the current single-task asynchronous refs-rejection tests passing. This is a real failure path, not a need to enable recovery or add new architecture.

Required correction: task-profile checkpoint persistence failures must set a run-wide fatal barrier that is checked at all subsequent model and tool admission boundaries, including a newly scheduled dependent and fresh generation. Preserve any already durable native/accepted records as evidence; do not make them appear undone or authorize an automatic repeat. Also avoid treating `committed` as a successful completed seal before the required checkpoint has succeeded. Do not introduce an `archive.dir` or fake-archive exemption.

Required focused regression: actual Host with A -> B (different task keys), injected synchronous `step/boundary`/`step/checkpoint` append error specifically for A's `node-accepted` checkpoint after native completion. Wait for actual member idleness and assert no B model dispatch or tool transport; assert the failure survives fresh generation checks and retains truthful original state/evidence. Existing accepted-reject coverage rejects `prepareCheckpoint()` before native completion and does not exercise this sequence.

## Reviewed boundaries without an additional blocking finding

- v1 writer/digest branches and legacy evidence path are preserved; task-profile unfinished verification inheritance explicitly refuses reuse.
- v2 uses `workManifest` for `files`, independently retains full canonical and own last-merge identities, rejects recovery/unknown origin variants and validates SHA objects from all input/work/canonical manifests, including absent/corrupt/hardlinked objects.
- Runtime refs are cloned/frozen in trusted Handoff state; wrappers pass only the existing bounded execution-scope binding to commands. The new full canonical refs are not placed in employee tool arguments/results or protected context.
- Product/native sandbox calls await private before/after refs; after-tool requires the original operation ID. Completion and cycle hooks await current refs, and knowledge-only node acceptance has a private session binding and v2 checkpoint path.
- Product task executor preflight now requires `prepareCheckpoint`; task-profile missing archive/refs fail closed rather than falling back to the compatibility workspace.
- Current generation rebinding invalidates old observed command proof; acceptance records derive their key from the registered scope.

## Evidence limits

Read the supplied `runtime-codec-GREEN.txt`: 59 tests passed, 0 failed/skipped, serial duration 25.453 seconds. That is worker-run evidence, not a fresh independent rerun. The interrupted default-parallel portable suite is explicitly resource-limited and is not counted as passed. The source review found no reason to reopen recovery inheritance, capacity release or restored-source admission; those remain outside this cohort and closed. A real synchronous node-accepted failure across dependent tasks is still unverified and is the required correction above.
