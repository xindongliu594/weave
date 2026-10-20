# Host synchronous admission fence

Plan: docs/superpowers/plans/2026-10-20-task-stop-finalization.md, synchronous Host seam only.

Implemented in services/agent-runtime/task-tool-boundary.mjs, host.mjs and the explicitly approved narrow extension employee-hosts.mjs. Tests are task-tool-boundary.test.mjs and new host-admission.test.mjs. No Product finalizer, deadline/10-second close quarantine, readiness, API, desktop, web, persistent state or public documentation change belongs to this slice.

The existing task boundary now has irreversible synchronous stopAdmission. The same closed flag denies native final guard admissions and already-guarded registered bodies. Policy replacement cannot reopen it; late global and scoped registrations retain the existing wrapper. Host.stopAdmission synchronously closes the coordinator boundary, each live/pending employee boundary, employee materialization and the existing adapter model admission. Host.close calls this same fence before its first await and retains its original close promise. Each employee slot owns its boundary stopper; no new registry or dispatch mechanism was introduced. Admission checks after plugin awaits and setup prevent a stopped pending employee from publishing a late Host. Ordinary stopAdmission does not abort original model requests or replace usage settlement; close retains its original cancellation/disposal path.

Coordinator and employee callers request boundary disposal after their plugin fiber awaits. Once stopAdmission has run, the boundary permanently retains its closed registration wrapper and last native guard even when its cleanup/disposer is invoked. The installed Cordis can swallow real effect-disposer errors and resolve fiber.dispose, so a resolved Host close is not evidence of clean resource teardown. A held close is deliberately still unbounded in this slice: the later Product owner must implement the frozen bounded close/quarantine contract.

## TDD evidence

- host-admission-boundary-red.txt: four expected behavior assertion failures before implementation: already admitted DSH scheduler execution, fresh execution, late global registration and late scoped registration all incorrectly ran. No source-string assertions.
- host-admission-boundary-green.txt: initial boundary green, 32 passed.
- host-admission-host-red.txt: initial managed temp attempt included Win32 MoveFileEx EACCES for local JSONL writes; it is not accepted behavior evidence for those tests.
- host-admission-host-red-workspace.txt: with workspace-owned TEMP/TMP, all eight named Host/factory cases fail at their intended admission/teardown behavior assertions before Host/factory implementation. Coordinator and employee late teardown raw bodies actually ran in RED.
- host-admission-initial-green.txt: combined initial green, 40 passed.
- host-admission-related-green.txt: first related regression, 61 passed.
- host-admission-final-green.txt: pre-review eight-file serial regression, 63 passed, zero failures/cancellations/skips. Installed DSH 0.1.5-rc.1 Hosts, registries, scheduler, guards, JSONL/checkpoint policy and original wrappers are exercised. Model adapters use fixtures; no paid model or OpenShell transport is invoked.

Final command (PowerShell, from repository root):

```powershell
$evidence = '.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration'
$env:TEMP = (Resolve-Path (Join-Path $evidence 'tmp')).Path
$env:TMP = $env:TEMP
node --test --test-concurrency=1 --test-skip-pattern='^the actual runtime' services/agent-runtime/task-tool-boundary.test.mjs services/agent-runtime/host-admission.test.mjs services/agent-runtime/employee-hosts.test.mjs services/agent-runtime/employee-tool-access.test.mjs services/agent-runtime/employee-capabilities.test.mjs services/agent-runtime/employee-checkpoint-policy.test.mjs services/agent-runtime/model-settlement.test.mjs services/agent-runtime/approved-skills.test.mjs
```

The actual Product case in model-settlement.test.mjs is excluded by the explicit filter; Node reports only selected tests. Full Product/PGlite/portable suites were not launched by this worker, per parent scheduling instruction. Parent owns broader serial verification and independent review. No Git/JJ/install/global-process-kill, budget, fee or physical-device action was performed. This does not mark the full terminal contract or Task 5 complete.

Final source hashes: host-admission-source-sha.json.

## Independent review P1 correction and source freeze

terminal-host-independent-review.md found one shared-root P1: installed Cordis Fiber._unload catches real disposer errors and only calls logger.error; local failures arrays therefore cannot authorize removing a stopped task fence. The parent approved the minimal boundary-only correction. The real native tools.guard effect was nested under the old boundary cleanup effect, so merely returning early from the cleanup would still let Cordis automatically remove that child guard. The existing guard is now registered on the same Context outside the cleanup's child effects; the ordinary unstopped cleanup still explicitly removes it and restores raw registration. Closed cleanup leaves both guard and wrapper installed. No logger, vendor, dispatch or global-registry change was made.

- host-admission-swallowed-disposer-red.txt: three expected behavior failures before the correction. Real mounted coordinator and employee plugin effects each throw TEARDOWN_PROBE; host.close resolves under installed Cordis; a saved manager's late raw body then runs exactly once. The stopped-boundary disposal case also exposes one late raw body. The unstopped native-reuse compatibility case passes before the correction.
- host-admission-swallowed-disposer-green.txt: the same eight-file serial command above, including the four added cases, passed 67/67 with zero failures/cancellations/skips after the single correction. Closed disposal keeps held bodies denied, fresh native admission denied and late registered bodies wrapped; tests also verify the last native guard remains. Unstopped disposal preserves native reuse. This is the one final related-surface regression after the P1 repair; source is frozen for the parent's narrow rereview.
- host-admission-pre-swallowed-disposer-source-sha.json preserves the SHA manifest reviewed before this repair. host-admission-source-sha.json is refreshed for the corrected sources and includes the inspected installed Cordis source hash.

This correction proves admission remains closed across the swallowed-error path. It does not prove native resources closed cleanly; no clean-teardown or full runtime terminal-state claim is made.
