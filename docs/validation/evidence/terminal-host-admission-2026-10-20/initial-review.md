# Terminal Host synchronous admission fence — independent review

Result: **CHANGES REQUIRED — one P1 finding**.

Reviewed on 2026-10-20 against the frozen synchronous Host seam in `docs/superpowers/plans/2026-10-20-task-stop-finalization.md`. This is a read-only source/evidence review of the five supplied uncommitted files; only this review report was written. The desktop files, Product finalizer, 10-second quarantine/readiness, runtime success classification, GUI and later terminal-contract slices are outside this review.

## P1 — a stopped boundary can still be disposed into a raw registry after a native plugin teardown error

Locations: `services/agent-runtime/task-tool-boundary.mjs:55-59`, with callers at `services/agent-runtime/host.mjs:249-255` and `services/agent-runtime/employee-hosts.mjs:58-61`.

`stopAdmission()` irreversibly sets `closed`, but the effect cleanup returned as `boundary.dispose` unconditionally removes the guard and restores the original raw `tools.register`. Both Host close paths call that cleanup whenever their local `failures` list is empty. Their only observation of a plugin teardown error is a rejection from `await fiber.dispose()`.

The installed Cordis does not provide that rejection for normal plugin effect cleanup failures. Its `Fiber._unload()` catches each disposer rejection, invokes `this.ctx.logger.error(reason)`, then resolves the unload (`services/agent-runtime/node_modules/@deepseek-ai/cordis/lib/index.js:1371-1382`). `Fiber.dispose` waits for this resolved inertia (`:1074-1089`). Consequently, a real plugin disposer can fail while both local `failures` lists remain empty. The Host then removes its last boundary and restores raw registration despite the teardown uncertainty. A saved tool-manager reference can register a new raw body after that close; the body no longer has the closed wrapper. This violates the requested irreversible fence and error-retention behavior on both coordinator and employee Hosts.

This is one shared-root finding, not two separate requests. The existing pending-disposer tests only inspect the registry while a disposer is held; they release it successfully before close settles, so they do not cover the swallowed-error path.

### Smallest repair direction

Once `closed` is true, boundary cleanup must retain the closed registration wrapper and final guard rather than restoring raw registration. Keeping that boundary on an otherwise unreachable closed Context is sufficient; the Context can be garbage-collected. An ordinary `dispose()` performed before `stopAdmission()` should preserve the existing cleanup/reuse behavior. No logger observer, global registry, alternate dispatcher or vendor change is required.

This closes the admission hole even when a native disposer failure is swallowed. It does not establish that native resource teardown succeeded, and this slice must not claim that stronger result.

### Minimum RED cases to add before the repair

1. Boundary-level case: register an admitted tool, call `stopAdmission()`, call `dispose()`, register a new tool through the same saved native manager, then assert its registered body still rejects and its raw body count remains zero. Also keep the ordinary unstopped-dispose behavior covered. The present implementation restores raw registration and fails the stopped-boundary assertion.
2. Parameterize the real Host fixture for coordinator and employee managers. Save the selected `ctx.tools` reference; install a real mounted plugin's `fiber.ctx.effect(() => () => { throw Error('TEARDOWN_PROBE'); })`; call `host.close()` and allow the installed Cordis lifecycle to settle. Register a late tool through the saved manager and assert its direct registered body rejects with zero raw calls, as the existing pending-close test already does. Do not monkeypatch `fiber.dispose` to reject: that would miss the actual dependency behavior. The present code reaches raw registration after Cordis logs the error.

These are proposed minimal REDs, not newly executed evidence. Per dispatch instruction, this reviewer did not launch tests or code execution.

## Remaining reviewed behavior

- The existing DSH final guard and registered-body wrapper both consult the same `closed` flag. An already-guarded scheduled exec, fresh exec, late global registration and late scoped registration are denied; `setPolicy` cannot reopen the stopped boundary.
- `Host.stopAdmission()` synchronously reaches the coordinator boundary, every currently live/pending employee slot, and the existing model adapter. It reuses the existing employee factory and native registry/dispatch.
- Employee materialization is checked around plugin loading/awaits, after caller setup, at commit, and before returning a Host. Slots own a stopper that reaches their own boundary; a future boundary cannot be installed after the stopped check around the tools mount.
- `Host.close()` calls the same synchronous fence before its first await and retains one original close promise. The boundary remains installed while the supplied pending coordinator/employee plugin teardown tests are held. The P1 above concerns disposal after a swallowed teardown error.
- The stop-only path does not abort original model requests or replace the adapter settlement code. The installed adapter denies new preparation/dispatch but settles original response usage before checking its stop reason. Legacy Hosts without a task boundary retain their native tool behavior and can stop model/employee admission.

## Evidence checked and limits

Read `AGENTS.md`, the frozen plan, all five source/test files, the report, RED logs and final GREEN log. Relevant installed DSH/Cordis and existing adapter/access/Skill/capability code were inspected only to verify the call and lifecycle semantics above.

The current SHA256 values of all five files and the installed DSH tools file exactly match `host-admission-source-sha.json`. The supplied final serial log records **63 passed, 0 failed/cancelled/skipped** across the eight named related test files; this reviewer did not rerun it. The supplied RED logs show the original four boundary failures and eight intended Host/factory behavior failures; the earlier EACCES log is correctly excluded as behavior evidence. The report's excluded actual Product scenario and absent full Product/PGlite/portable evidence remain explicit limits. The reported five syntax checks were not independently rerun.

No network, Git, JJ, installation, model call, source edit or heavy test was performed. The wider terminal contract and Task 5 are not certified by this review.
