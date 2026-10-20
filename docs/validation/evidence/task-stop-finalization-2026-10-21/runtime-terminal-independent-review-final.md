# Runtime terminal finalization — final independent rereview

Result: **PASS for all three previous findings, the source-only preparation hook, and their directly related caller surfaces. No remaining required change was found within this rereview.**

Date: 2026-10-21. Reviewer: the same independent reviewer that wrote `runtime-terminal-independent-review.md`. This report supersedes that report's CHANGES REQUIRED conclusion for its two P1 findings and one P2 finding. It does not broaden acceptance to the complete terminal contract or later release gates.

## Previous findings closed

1. **Original model settlement is now a prerequisite.** `product-runtime.mjs:229-244` requires a non-timeout, non-aborted drain result with zero reported and actual original pending requests before the final checkpoint/business boundary. A timed-out delivery settlement is not granted a second settlement window in the failure path. The adapter error callback excludes only `error === deliveryStop`, not a shared code/message or every error during finalization. Genuine late response/fee persistence failures are retained in `runtimeFailure` and rechecked before acceptance. The positive original-response case remains accepted; the late fee failure and real drain-timeout cases make zero finalizer calls.

2. **Accepted recording uncertainty survives the coordinator boundary.** After the durable task boundary, an archive/recording exception produces a trusted resolved `{status:'completed',recording:'incomplete',maintenance:pending,...}` result with a fixed public warning, without fabricating a terminal trace. The declaration exposes that distinction. `RunCoordinator.launch` remembers only the completion actually resolved by its trusted runtime promise. Incomplete recording and failures in subsequent usage replay/terminal bookkeeping retain completed business classification with a fixed reconciliation warning; the completed catch does not append a failed trace. Existing owner/lease checks still decide whether any SQL terminal write is permitted. Ordinary errors before a trusted completed result retain the original failed behavior. Persistent SQL unavailability is not certified as successful bookkeeping.

3. **Quarantine preserves queued work instead of failing it.** The existing scheduler reads runtime readiness before claiming a queued run; launch checks it again before authorization/import work. A guard-to-start race is handled only when no runtime was created and the actual start rejects with `RUNTIME_TEARDOWN_PENDING`. `deferUnstartedRun` uses the existing transaction/maintenance/project/run locks and atomically requires the original project/version/attempt, same live owner/lease, current project version, no successor, and no local operation, model reservation of any status, or usage evidence. It returns only that effect-free claim to the existing queue. Racing cancellation becomes cancelled; refusal of a guard preserves the protected SQL row without a failed trace or fabricated queued retry. No new queue, scheduler or preparation memo was added.

## Source-only preparation hook and compatibility

`ProductDshRuntime.start` invokes optional synchronous `prepareWorkspace` only after its actual quarantine and duplicate-run checks, in the same stack before archive/job creation. Both existing coordinator preparation functions (`prepareImportedWorkspace` and `restoreStepWorkspace`) are synchronous. Async parent/canonical acquisition remains in the caller; only the synchronous restore/import closure crosses the source-only start boundary. Thus quarantine that becomes active during those async reads is rechecked before files are imported. No await separates the final guard from the preparation call.

The hook is an internal optional argument, never HTTP/model input. Existing direct runtime callers that omit it remain compatible. Its callback does not broaden permissions or bypass existing import/restore validation. Actual native runtime tests check successful preparation once before the original archive and zero callback invocations on a quarantined start. Coordinator tests check that the same deferred run later imports its approved input once without deleting or reusing conflicting prepared files.

The previously reviewed resource mechanics remain intact: one original Host close promise and one executor close promise, a single all-settled resource group, bounded local wait, retained resources/readiness quarantine until that same group settles, and no second close/finalizer dispatch. This is not a claim of clean native resource release after a swallowed disposer error.

## Evidence inspected

- Runtime repair RED: 4 named cases, 3 intended failures and 1 positive settlement characterization, exit 1. Runtime terminal GREEN: **13/13**, exit 0.
- Related real loopback/native runtime regression: **27/27**, exit 0. Covers the existing deadline, successful-delivery settlement/cancellation, original fee settlement, checkpoint barriers and task sandbox surfaces.
- Coordinator maintenance RED: 19 tests, 14 intended failures and 5 passing characterizations, exit 1; corresponding GREEN: **19/19**, exit 0.
- Existing live-lease/terminal regression: **9/9**, exit 0. The coordinator evidence uses the isolated serial PGlite/product connection and trusted runtime completion/readiness fixtures; it is not independent native PostgreSQL concurrency or native Host acceptance proof.
- All five files in `run-terminal-maintenance-source-sha.json` match current source. All five scoped runtime/test files in `runtime-terminal-and-storage-source-sha.json` also match current source. The storage entries in that manifest are outside this rereview.

This is source/evidence review; no tests were rerun by the reviewer. The native runtime/model/executor fixtures and coordinator SQL fixture evidence remain separately labeled. This report makes no passing full TypeScript/build claim: the reported web-owned type surface was still in progress. It does not certify physical JJ/OpenShell/paid execution, three consecutive full Product projects, retirement, recovery/carrier work, Task 6, Task 5 release, or the full terminal contract.

No source, network, PG/PGlite, test process, build, paid model, JJ, Git, installation or device action was performed. Only this final independent report was written.
