# Core live non-recovery checkpoint v2 cohort

Scope: shared contracts, pure checkpoint codec/object validation, private runtime refs/barriers. Recovery admission/initialization, backup, desktop maintenance, profile gates and full Task 5/6 remain closed and are not implemented by this cohort.

## Owned changed files

- packages/contracts/task-execution.ts
- services/agent-runtime/step-checkpoints.mjs
- services/agent-runtime/step-checkpoints.d.mts
- services/agent-runtime/handoff.mjs
- services/agent-runtime/handoff.d.mts
- services/agent-runtime/task-tool-context.mjs
- services/agent-runtime/product-tools.mjs
- services/agent-runtime/native-plugin-tools.mjs
- services/agent-runtime/host.mjs
- services/agent-runtime/product-runtime.mjs
- services/agent-runtime/task-checkpoint-v2.test.mjs (new)
- services/agent-runtime/task-sandbox-flow.test.mjs
- services/agent-runtime/task-readonly-handoff.test.mjs

Shared CanonicalRef/TaskMergeReceipt shapes are unchanged from API originals, with compatible API reexports owned by the refs worker. TaskCheckpointRefs follows the frozen plan. Codec rejects recoverySource/checkpoint-origin/unknown origin variants, validates manifests and every input/work/full-canonical immutable object, and keeps files equal to task workManifest. v1 writer/digest/legacy inheritance branches remain intact. v2 unfinished verification inheritance is refused. Canonical B and lastMerge A are independently checked.

References remain private to trusted API/Handoff/archive state. Product/native tool before/after barriers await private refs; after-tool requires the exact taskExecution.operationId. Host completion prepares refs before native completed state. Active-task cycle refs prepare after employee-owned sessions.flush. Handoff stores the trusted session privately so knowledge-only node acceptance also creates a v2 checkpoint. ProductDshRuntime requires prepareCheckpoint during task executor preflight. No sandbox export, paid model, new operation or employee command is added by checkpoint preparation.

A true accepted-rejection test exposed subsequent model dispatch through DSH tool-error continuation. A per-attempt/generation private Handoff failure latch now prevents follow-up preparation/model dispatch after private-ref or synchronous checkpoint persistence failure; a fresh generation has a distinct trusted binding.

## TDD evidence

- runtime-codec-RED.txt: initial 5 failing tests before the first source edit (v2 absent, malformed refs accepted, corrupt private canonical object ignored, canonical/work separation absent, promise barrier absent).
- runtime-checkpoint-rejection-RED.txt: 58/59; actual Host accepted-reject allowed an extra model call (4 vs 3). Saved before implementing the failure latch.
- runtime-codec-GREEN.txt: 59/59, 0 failures/skips, 25.453 seconds, process exit 0.

Exact GREEN PowerShell command (run with approved require_escalated only for filesystem test restrictions; all temporary files owned by this workspace):

```powershell
$env:TEMP=(Resolve-Path .superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/tmp).Path
$env:TMP=$env:TEMP
node --test --test-concurrency=1 services/agent-runtime/task-checkpoint-v2.test.mjs services/agent-runtime/step-checkpoints.test.mjs services/agent-runtime/task-sandbox-flow.test.mjs services/agent-runtime/task-readonly-handoff.test.mjs services/agent-runtime/employee-checkpoint-policy.test.mjs services/agent-runtime/inherited-step-evidence.test.mjs services/agent-runtime/product-tools.test.mjs services/agent-runtime/run-evidence-native.test.mjs services/agent-runtime/handoff.test.mjs services/agent-runtime/step-checkpoint-crash.test.mjs *> .superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/runtime-codec-GREEN.txt
```

Coverage includes legacy v1/inheritance/crash, malformed v2 identities/origins/receipts/digests, forged work alias/recovery fields, missing/corrupt/hardlinked full canonical refs, atomic append failure, A lastMerge versus newer canonical, private API promise hold/reject, actual Product before/after operation hold/reject, and installed actual Host cycle/acceptance hold/reject. Host rejection tests await actual reader.whenIdle, not a timing-based assumption.

## Resource-limited full-suite attempt

`npm run runtime:test:portable` was attempted as required by the TDD skill, with owned workspace TEMP. Its default parallel child spawning exhausted V8 zone memory in the managed sandbox. Original output is runtime-full-sandbox.txt. Stopped this exact exec session 73050 using Ctrl-C (exit 1); no global node process kill. No full-suite pass is claimed.

Observed failures in that interrupted output: approved-skills.test.mjs; archive objects hardlink setup EPERM; browser-mcp-runtime real Product routing fixture; delivery-settlement successful-tail and cancellation fixtures; employee-admission-context.test.mjs and employee-checkpoint-policy.test.mjs (V8 Zone Allocation OOM); employee-hosts isolation fixture; goal-guard.test.mjs; handoff-fixtures.test.mjs; handoff-selfcheck.test.mjs; handoff.test.mjs; journal-archive.test.mjs; knowledge-chunks.test.mjs; limits.test.mjs; manager-handoff.test.mjs; model-settlement.test.mjs. This interrupted parallel run is resource/environment failure evidence, not an adjudication that every listed test is a product defect. Relevant checkpoint/hardlink/Handoff/native/product/policy suites were rerun serially above and passed.

## Remaining validation boundaries

No physical JJ/OpenShell run, paid model call, production access, installation, dependency change or git commit. Full project API/TypeScript/Product integration validation is owned by root and the trusted refs/consumer workers. No full Task 5 completion or task profile opening is claimed.

## Independent-review correction: synchronous publication uncertainty

Reviewer identified a real post-effect gap: native completion schedules a dependent before Handoff's node-accepted checkpoint is committed. The previous per-task/generation refs latch did not stop a different task. Genuine actual Host A→B tests injected both `step/boundary` and `step/checkpoint` synchronous node-accepted append faults. Both initially dispatched two B model calls; expected zero. The original native completed state and accepted journal event were already present and were preserved in the assertions.

- `sync-publication-red.txt`: 0/2, downstream B model count 2 vs expected 0, saved before the fix.
- `sync-publication-notification-red.txt`: 0/2, no immediate Product runtime failure callback, saved before callback propagation.
- `sync-publication-green.txt`: final related serial suite **64/64**, 0 failed/skipped, 25.496 seconds, process exit 0.
- `sync-publication-product-green.txt`: standalone actual Product last-node local HTTP fixture passes; its final combined rerun is in `sync-publication-green.txt`.

Correction uses a task-profile **run-wide fatal checkpoint publication latch**. All subsequent Handoff mutex admissions, scope bindings and model/tool/native admissions check it, including after capacity waits and before native attempt registration. It cannot be cleared by a different task, attempt or generation. Async refs failures before native effects retain their existing per-attempt/generation fence. Synchronous before-tool checkpoint persistence failure also sets the run-wide fatal latch.

Task-profile Handoff now appends the truthful acceptance history and the required checkpoint before publishing a runnable `committed` seal. If publication fails after native completion, rollback retains the actual native/provisional acceptance history instead of presenting it as undone/retriable. The failed publication never becomes a usable committed seal.

The first fatal publication synchronously notifies the existing Host→Product `onHandoffBlocked` failure callback, sets the Product runtime failure, stops supervisor admission and calls adapter.stopAdmission. This also covers the final node when there would be no later model/tool request to observe the latch. An actual ProductDshRuntime with a local HTTP fixture confirms: the last node's native status remains completed; the accepted journal history remains; no node-accepted checkpoint is fabricated; the returned status and `run/finished` status are **failed**; no completed final event is emitted; and no model request dispatches after failure. SQL row projection and knowledge registration are owned by root/API and are not independently claimed here.

Additional owned source edits for this correction: `services/agent-runtime/handoff.mjs/.d.mts`, `host.mjs`, product/native tool wrappers, `task-readonly-handoff.test.mjs` and `task-checkpoint-v2.test.mjs`. No API/shared contracts, recovery, backup, desktop or profile gate edits were made in this correction.

Final verification uses the same exact ten-file `node --test --test-concurrency=1` command listed above, replacing its output target with `.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/sync-publication-green.txt`. Tests ran with workspace-owned TEMP/TMP and approved escalation for local HTTP/hardlink/Windows filesystem restrictions, with no paid model, JJ or production access. Full Task 5/6 and recovery/profile gates remain closed.

## Final malformed-boundary correction

The follow-up review found that missing session/task metadata still returned `undefined` from task-profile checkpoint publication. Because a nonthrowing `commit()` looked successful, a public trusted three-argument bind without session could publish a committed seal with no checkpoint. Added actual v2 bound-reference regressions for (1) three-argument bind/no session and (2) task metadata absent at publication. Both first failed with “Missing expected exception” in `refs-earlyreturn-red.txt`.

Task-profile missing-session/task branches now throw `TASK_CHECKPOINT_REQUIRED`; legacy early returns are unchanged. The enclosing task commit turns this into the existing fatal publication fence. Both regressions assert no checkpoint, no committed seal, and a fatal barrier for a fresh attempt/generation. A low-level runtime fixture now supplies its actual trusted session when it intends to publish a checkpoint.

Final unchanged ten-file serial command, output redirected to `refs-earlyreturn-green.txt`: **66/66 passed**, 0 failed/skipped, 24.662 seconds, process exit 0. `git diff --check` on the owned corrected source/tests passed. Root owns the subsequent final build and broader SQL/Product integration evidence. No paid model, JJ, production service, dependency install or profile gate change occurred.

## Final metadata/redaction consistency correction

The final batch review found that an otherwise legal filename such as `docs/sk-abcdefghijkl.txt` could pass validators but be transformed by the existing archive redactor after v2 hashes were calculated. The old writer could report success while the durable checkpoint hash/canonical identity no longer matched. This was fixed without changing global secret redaction, trace-store or canonical identities.

Current non-recovery v2 limitation: **references, filenames, identifiers, boundary fields and receipt strings that global archive redaction would change are rejected with the fixed generic `CHECKPOINT_METADATA_UNSAFE` error.** The error contains no private filename. This is an explicit bounded metadata limitation until a separately designed typed archive policy exists; it does not forbid those filenames globally or silently rewrite their canonical/scope identity.

- `validateTaskCheckpointRefs`, also used by the trusted API preparation gate, rejects redaction-changing refs before object/publication admission.
- The writer compares the entire raw v2 metadata with its redacted form before any step/checkpoint append, covering boundary and receipt strings too.
- After append, the returned event.data must match a cloned pre-append expected record. Unexpected return/in-place mutation fails publication and triggers the existing Handoff run-wide fatal fence. An event that already durably appended remains historical evidence, never a usable committed seal.
- v1 writer/hash/redaction paths are unchanged.

Real archive tests cover a legal redaction-pattern filename in own work and in the complete canonical manifest only, both producing zero step/checkpoint events and no false committed seal; redaction-changing boundary/receipt rejection; and mutation of returned event data after a real archive append, which fails the task publication rather than reporting success. Safe v2 roundtrip and all v1 regressions remain passing.

`metadata-red.txt`: 0/4, before this source fix. `metadata-green.txt`: final unchanged ten-file serial runtime cohort **70/70 passed**, 0 failed/skipped, 24.759 seconds, process exit 0. Same exact test command listed earlier, with output target `.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration/metadata-green.txt`. Only step-checkpoints.mjs and task-checkpoint-v2.test.mjs changed in this correction; owned-file diff whitespace checks passed. No trace-store mutation, redaction bypass, canonical identity recomputation, dependency install, paid model, JJ, production access or profile gate change.
