# Terminal Host synchronous fence — narrow independent rereview

Result: **PASS for the previous P1 correction and its direct admission surfaces. No remaining required change was found in this scope.**

Reviewer: the same independent reviewer that wrote `terminal-host-independent-review.md`. Date: 2026-10-20. This report supersedes that report's CHANGES REQUIRED conclusion only for the reviewed P1; its wider scope limitations remain.

## Why the P1 is closed

`services/agent-runtime/task-tool-boundary.mjs:45-62` now registers the native `tools.guard` outside the cleanup effect. The cleanup sets `disposed`, then returns immediately when `closed` is true, retaining both the last guard and the `registerWrapped` accessor. Cordis therefore cannot remove that guard as a child of the boundary cleanup. Previously admitted bodies still reject through the same closed/disposed check; fresh native admission remains denied; late registrations still receive the rejecting wrapper. Repeated cleanup cannot restore raw registration.

The ordinary, unstopped disposal path still explicitly removes the guard and restores the original descriptor or deletes the accessor as before. It retains native registry reuse. This is a local correction to the existing boundary; it introduces no logger observer, vendor change, global registry or alternate dispatcher.

The direct coordinator and employee callers remain correct for this narrow property: `host.mjs:240-255` calls the synchronous Host fence before awaiting close, and `employee-hosts.mjs:49-61` stops the slot boundary before disposal. Both may still reach `boundary.dispose()` after Cordis swallows a plugin cleanup error, but that invocation can no longer reopen a stopped registry.

## Evidence reviewed

- The new boundary test covers an already-admitted scheduler exec held across stop plus dispose, repeated dispose, a late registered direct body, and fresh scheduler admission. It checks both zero raw bodies and the native guard's denial. The separate unstopped-dispose test proves native registry reuse.
- The two real Host tests inject a throwing effect disposer into an installed coordinator/employee plugin. They do not replace `fiber.dispose`. They establish that the disposer actually ran once while native close resolved, then verify held-body rejection, zero late raw bodies, failed fresh execution and a remaining native guard.
- `host-admission-swallowed-disposer-red.txt` records the intended three failures with raw body count `1 !== 0`, and the unstopped-reuse compatibility case passing before the fix.
- `host-admission-swallowed-disposer-green.txt` records the same related eight-file serial regression after the correction: **67 passed, 0 failed/cancelled/skipped**, including all four new cases. This reviewer inspected that evidence without rerunning tests.
- Current hashes for all five scoped source/test files, installed DSH tools, and installed Cordis exactly match the refreshed `host-admission-source-sha.json`. The Host and employee source hashes also match the previous review; the correction is confined to the boundary and its tests.

The updated owner report accurately states the remaining native teardown limitation. The installed Cordis still catches and logs effect-disposer failures in `Fiber._unload`; a resolved Host close does not prove clean resource release. This PASS establishes that the admission fence survives that uncertainty. It does not certify clean native teardown, bounded close/quarantine/readiness, Product finalization, runtime success classification, the wider terminal contract or Task 5.

No source file was modified and no test, PGlite/Product/full suite, network, paid model, JJ, Git, installation or vendor action was run. Only this final review report was written.
