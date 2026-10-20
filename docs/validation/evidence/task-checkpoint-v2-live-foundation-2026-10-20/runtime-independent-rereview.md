# Independent runtime/core P1 re-review

Verdict: **PASS for the scoped P1 correction** (2026-10-20).

This supersedes the blocking finding in runtime-independent-review.md for the reviewed current source. This is a static re-review of the publication-failure correction and supplied focused RED/GREEN evidence; no independent test execution, source/test mutation, database, JJ/OpenShell access, model call, dependency change or large-suite run was performed.

## Correction verified in source

- `services/agent-runtime/handoff.mjs:89-99`: synchronous checkpoint publication failure is now a task-profile run-wide fatal latch; it is never keyed away by a new task, attempt or generation. The original error is retained and the Product failure callback is notified once.
- `handoff.mjs:110-122`: checkpoint publication asserts the global latch first. Missing task-profile refs/archive fail closed, and missing session/task now throw rather than silently returning without a checkpoint. Existing codec/object validation remains in the publication call; malformed refs do not become a durable checkpoint.
- `handoff.mjs:235-254`: after native completion the accepted journal history is preserved, but the usable `committed` seal is published only after the mandatory node-accepted checkpoint returns successfully. Failure leaves truthful original evidence and a fatal barrier; rollback does not turn the historical acceptance into authorization to repeat work.
- `handoff.mjs:62-65` and `services/agent-runtime/host.mjs:64,134,273-297,416-427`: the global latch guards the shared mutex, model admission before assignment binding and again after capacity wait, tool admission, and protected-context pre-step before captain/no-active-task early returns. Product/native wrappers also check the barrier; the external-tool path rechecks it after capacity wait.
- `host.mjs:64` calls the existing `product.onHandoffBlocked` path and stops supervisor/model admission immediately. `services/agent-runtime/product-runtime.mjs:126,149-158,184-202` retains this error as `runtimeFailure` and records a failed outcome even when native tasks already completed.

## Focused evidence inspected

- `sync-publication-red.txt`: both genuine actual Host A -> B cases failed before the correction because B received 2 unwanted model calls.
- `sync-publication-green.txt`: 64 tests passed, 0 failures/skips; covers synchronous node-accepted `step/boundary` and `step/checkpoint` failures after actual native completion. The tests wait for actual member idleness, check one fatal notification, preserve original native completed/accepted history, and assert zero B model/bind/prepare/refs/transport dispatch.
- The actual final-node Product fixture in `services/agent-runtime/task-readonly-handoff.test.mjs:109-139` uses loopback HTTP model fixtures, verifies returned and archived `failed`, preserves completed native and accepted history, observes no completed final event and no model request after failure.
- `refs-earlyreturn-red.txt` / `refs-earlyreturn-green.txt`: genuine 3-argument `bindCheckpoint` without session, and bound task removed before commit, went from 0/2 to 2/2. Neither can publish a checkpoint-free committed seal, and the fatal state survives a fresh generation check. These two guards were added after the 64-test run; no combined 66-test pass is claimed here.

No remaining blocking finding was found in the scoped correction. Recovery/restored-source admission, inheritance, capacity release, physical JJ/OpenShell validation and full Task 5/6 remain closed or outside this review. The resource-limited interrupted full portable suite is not considered passed.
