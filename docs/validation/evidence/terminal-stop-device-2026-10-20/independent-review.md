# Terminal accepted-stop device prerequisite — independent review

**PASS.** No P0/P1/P2 behavior defect found in the frozen two-file device cohort. This is an implementation review of the device prerequisite, not completion of the full terminal finalization contract.

Reviewed baseline: `6af1ecc4edaf11b34f07e3689e3bca138a1bf4ab`. Scope is the uncommitted diff in `apps/desktop/openshell-executor.cjs` and `.test.cjs`, against `docs/superpowers/plans/2026-10-20-task-stop-finalization.md`. Runtime/Host edits by the separate worker were not reviewed. Source hashes match `terminal-device-source-sha.json`:

- executor: `6ac776928fc86c89cce0a6687574709d6683b17e0cd647b4f1ae9ed3502af82c`
- tests: `9e4851f13e336f224bef41c3811a044135df09a2ad60d1ff462576a42144221b`

## Verified behavior

- **Queue admission and settlement (396–409).** The existing queue owns one irreversible pending/started/cancelled latch. Pending abort removes the listener and rejects the caller; the original queued entry later skips fn. Starting removes the pending listener. Once started, the queue and caller await fn settlement rather than racing and abandoning an effect. The no-signal branch preserves the previous queue path. The post-fn signal check conservatively refuses late success; durable device facts remain separately readable.
- **One signal, including queue time (435–492).** Direct stop/reconcile select their single fallback at method entry, before enqueue; a supplied signal is used unchanged. Admission, stop and original-ID observation share it; the Now method creates no new timer. Entry, transport continuations, admission completion, callback completion and observation completion check cancellation. A repeated stop continues to observe only its original intent.
- **Last authority boundary (477–485).** After beforeDispatch, signal/grant/config/full-journal checks remain synchronous through the existing fsynced intent and the one stop dispatch. Cancellation before that boundary creates neither an intent nor a later stop. Cancellation after dispatch retains the original intent/unknown state and does not free running capacity or replay stop.
- **Capabilities (14,445).** The private method returns the exact frozen `{version:1,deadline:'shared-abort-v1'}` record with a stable prototype method reference. This does not itself enable API/runtime preflight; those consumers must still freeze and validate the provider/method/response under their separate gate.
- **Transport settlement and truthful execution classification (108–124).** Abort, timeout, overflow and post-spawn error retain one unknown outcome, request kill and await the original child's close. A late numeric exit cannot override cancellation. Kill false/throw cannot cause caller settlement. Cancellation before spawn notification is retained; actual spawn changes `notExecuted` to false before any close-based return. An already aborted signal never spawns. Definitive spawn failure remains `notExecuted:true`. Listeners/timers are removed at their appropriate final/abort boundaries.
- **Prior fences preserved.** No task journal format, identity, original-ID observation syntax, two-slot/128-scope/disk accounting, backend/policy/permissions, acceptedStop execution/export/inspection/retirement fence or legacy scope behavior is loosened. The new global cli continuation signal check only rejects a late response; it does not add an effect or authorize replay.

## Evidence examined; no tests rerun

Reviewed the implementation/status record, actual added test bodies, focused RED/GREEN and narrow regression logs. Focused GREEN is **13/13**, zero cancelled/skipped. The first managed three-file regression is **67/68** with its sole existing symlink fixture failing Windows `EPERM`; the same narrow authorized command is **68/68**, zero cancelled/skipped, exit **0**, with the source hashes unchanged. The real local Node-child test checks its original PID is gone before default transport returns unknown; deterministic child cases cover kill false/throw and a post-spawn error without early settlement. These are stronger than a caller-only timeout assertion.

No production source edits, tests, installation, paid API, Git operation or JJ access were performed by this reviewer; only this private review artifact was written.

## Explicit limitation and remaining integration gate

If the OS refuses termination or an injected/installed transport never settles, the started entry intentionally remains pending and retains uncertainty. There is no honest bounded settlement proof in that case; a timeout cannot manufacture child termination, release capacity, or allow another effect. This limitation is recorded accurately in the implementation status and is not hidden behind the capability record. It requires separate physical deployment evidence and operational handling, not a Promise.race around live stop work.

This PASS therefore does not certify a completed 120-second SQL/runtime/GUI finalizer, Host teardown/admission integration, sequential Product execution, native PostgreSQL or physical JJ/OpenShell acceptance. Those remain separately gated; the task profile stays closed.
