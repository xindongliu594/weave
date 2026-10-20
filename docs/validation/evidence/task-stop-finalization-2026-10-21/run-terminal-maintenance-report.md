# Coordinator terminal-maintenance caller repair

Date: 2026-10-21. Source is frozen for parent-owned independent review.

Scope: apps/api/src/run-coordinator.ts, apps/api/src/run-state.ts, new tests/run-terminal-maintenance.test.ts only. Consumes the parent-owned source-only RuntimeCompletion.recording and ProductDshRuntime.start.prepareWorkspace contracts. No runtime source, HTTP/effect API, shared HTTP tests, web, new scheduler, queue, table, package or recovery architecture was changed by this worker.

## Behavior

RunCoordinator remembers only a completion actually resolved by the trusted runtime promise. After a completed result, usage replay or terminal SQL-bookkeeping errors can only attempt the existing finishRun with completed plus a fixed Chinese recording/fee-reconciliation warning. They cannot append a fabricated failed trace or fabricate usage. A recording-incomplete completed result also persists that bounded warning. Unknown receipts remain intact; the existing finishRun ownership/lease fence still controls whether any terminal SQL write is permitted. Ordinary errors before a trusted completion keep the original failed behavior.

tick reads runtime readiness before claiming work, and launch checks it again before authorization/import preparation. As agreed with the parent, async parent/canonical reads stay in the caller, while the existing synchronous restore/import operation is captured in prepareWorkspace and passed to the actual runtime start guard. No preparation memo was added. Quarantine rejection therefore occurs before this run imports its input; the same original queued run can later prepare once after the original close promise settles.

The narrow no-runtime-created quarantine rejection calls deferUnstartedRun. It reuses lockedRun's maintenance/project/run lock order and atomically checks the original project/version/attempt, live same-owner lease, current project version, absence of a newer attempt, and absence of every local_operations, model_reservations or usage row for this run. All reservation statuses count as effect evidence. Only that effect-free claim may clear its lease and return to the existing queued state. A racing cancellation becomes cancelled under the same transaction; a failed guard preserves the protected SQL state and does not write a failed trace or invent a queued retry. Attempt, snapshot, started history and fee evidence are not reset; prepared files are never deleted. Existing recovery behavior is unchanged.

## TDD and verification

The tests exercise the actual RunCoordinator.launch/tick, finishRun/defer transaction paths, authorization, SQL and workspace import code. Runtime readiness/completions are trusted in-process fixtures that model the guard-before-prepare source contract; they do not establish native Host teardown or durable task acceptance. The parent's separate real native DSH runtime/Host evidence remains separate.

- run-terminal-maintenance-red-fixture-stall.txt: an initial attempt stopped after the second test because the new finish-error test injection did not preserve pool.connect's callback overload. The exact owned session 89617 was interrupted using Ctrl-C; there was no global process kill. This partial attempt is not complete RED evidence. The fixture was corrected to forward callback connections unchanged and inject only the explicit terminal transaction connection.
- run-terminal-maintenance-red.txt / .exit.txt: complete named RED after that fixture correction, **19 tests, 14 expected behavior failures, 5 passing characterizations, exit 1**. The failures expose completed-to-failed replay/bookkeeping rewrites, quarantine queue failure, unsafe refusal/cancellation handling and project/version/attempt/successor behavior.
- run-terminal-maintenance-green.txt / .exit.txt: the same new file after the minimal caller/helper changes, **19 passed, zero failed/cancelled/skipped, exit 0**.
- run-terminal-maintenance-live-lease-green.txt / .exit.txt: direct existing lease/terminal-state regression, **9 passed, zero failed/cancelled/skipped, exit 0**. Covers own-active expiry exclusion, unknown receipt preservation, actual heartbeat and native admission, owner/cancel/version gates and terminal rollback/recovery.
- run-terminal-maintenance-tsc.txt / .exit.txt: TypeScript exited 2 with exactly one unrelated owned-by-parent diagnostic: apps/web/src/RunCenter.tsx(137,1083), TS2339 executionProfile missing from the Trace snapshot type. No diagnostic named one of this worker's three files. Parent was informed; this worker did not edit that surface or claim tsc passed.

Both SQL commands used the existing serial runner and a new in-memory PGlite database for each file:

```powershell
$evidence = '.superpowers/sdd/2026-10-20-task-checkpoint-v2-integration'
$env:TEMP = (Resolve-Path (Join-Path $evidence 'tmp')).Path
$env:TMP = $env:TEMP
node scripts/test-integration.mjs tests/run-terminal-maintenance.test.ts
node scripts/test-integration.mjs tests/run-live-lease.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The runner's one PostgreSQL backend/product connection verifies real transaction and CAS behavior, not independent native PostgreSQL backend concurrency. The lease regression's one local HTTP model wire is an engineering fixture, not a paid provider. No physical JJ/OpenShell, paid model, installation, Git, production database or budget change was performed. The full database/Product/portable suites were not launched.

## Handoff

run-terminal-maintenance-source-sha.json records SHA256 for the three frozen owned files and the two parent-owned runtime dependency files observed during this verification. The new-file and related-regression runner processes both exited 0, their PGlite instances closed, and the exclusive database window was explicitly released to the parent for the queued HTTP file. No further test/PG process or source edit will be started by this worker without a new dispatch.

This slice does not certify the complete terminal-finalization contract, clean native resource release or Task 5 completion. Persistent SQL unavailability cannot be reported as successful bookkeeping; no forced write bypasses the existing owner/lease fence.
