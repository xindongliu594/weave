# Runtime terminal finalization — independent review

Result: **CHANGES REQUIRED — two P1 findings and one P2 finding**, reported together after a complete review of the supplied runtime slice and its existing coordinator caller.

Date: 2026-10-20. Scope: `services/agent-runtime/product-runtime.mjs`, its `.d.mts`, new `terminal-finalization.test.mjs`, and the two existing task test fixtures that now assert finalization must not follow their deliberate failures. The frozen contract is `docs/superpowers/plans/2026-10-20-task-stop-finalization.md`. Existing adapter, Host, executor and coordinator/run-state code were read only where necessary to establish actual async semantics. Other agents' API stop implementation is not reviewed here.

## P1 — the durable business boundary does not require completed model settlement

Locations: `services/agent-runtime/product-runtime.mjs:219-238`; actual adapter semantics: `openai-compatible.mjs:340-352,605-619`.

The success path awaits `adapter.drain(30000, signal)` and logs its result, but never checks `settlement.pendingRequests`, `settlement.timedOut`, or a remaining `adapter.pendingRequests`. The installed adapter deliberately resolves at its 30-second ceiling with `{pendingRequests:1,timedOut:true,...}` while the original request is still active. With a longer approved business deadline, execution then appends the final checkpoint, sets `businessAccepted`, clears the business timer and invokes the source-only finalizer. This grants cleanup authority before the frozen prerequisite that original dispatched model requests have settled. It can also abort that unanswered original request during Host close instead of retaining the original business/settlement failure behavior.

There is a related pre-boundary error gap in the same awaited tail: `runtimeFailure` is checked before deliverable verification but not after verification/settlement. A genuine provider-response/usage persistence failure arriving during that wait can be ignored when drain reports zero remaining requests. The deliberate `DELIVERY_FINALIZING` stop itself reaches the adapter `onError` callback after a successful late response; that expected stop must be distinguished from real pre-acceptance errors, rather than blindly adding a check that fails every successfully settled tail.

Smallest correction: require a positive completed-settlement outcome and zero original pending requests before the final durable business boundary; retain real pre-acceptance errors through the awaited tail while excluding only the known internal delivery stop. A timed-out/unsettled or genuinely failed original request must produce zero finalizer calls and no completed acceptance. Preserve the existing bounded model-settlement policy; do not wrap or abandon a device stop with a caller race.

Minimum REDs: hold an original manager request while the last worker becomes deliverable, reach the actual drain ceiling under a longer business deadline, and assert finalization stays at zero and no completed terminal result is emitted. Separately fail a genuine late response/usage persistence callback during settlement and assert it remains a pre-boundary failure. Keep the successful original-response settlement case green.

## P1 — an accepted archive error is reclassified as business failure by the existing caller

Locations: `services/agent-runtime/product-runtime.mjs:244-255,65-75`; actual caller: `apps/api/src/run-coordinator.ts:150-157`.

The new runtime branch correctly avoids appending a fabricated failed terminal record after `businessAccepted`, but it rethrows an ordinary error when the maintenance/final terminal append fails. `RunCoordinator.launch` awaits that same completion and handles every rejection by calling `finishRun(...,'failed',...,traceFinished(...,'failed',...))`. Its SQL row is still running under the original owner, so this path records the accepted business as failed; if the terminal archive fault was transient, it also appends the failed trace that runtime explicitly avoided. Runtime job cleanup can remove the only in-memory `businessAccepted` flag before the coordinator handles the rejection, and the declared completion boundary conveys no accepted/unrecorded distinction.

The same caller catch can reclassify a successful completed runtime result if its subsequent usage replay throws before `finishRun`. This is an actual post-acceptance consumer boundary, not an API stopping-policy review.

Smallest correction: carry a trusted accepted-but-recording-incomplete outcome across the runtime promise/type boundary and handle it explicitly in the existing coordinator. Preserve accepted business classification while exposing that terminal recording/bookkeeping is incomplete; do not claim fully recorded success and do not write failed business state/trace merely because a post-acceptance append or replay failed. No additional lifecycle store is needed.

Minimum RED: route the existing final-archive-failure scenario through the real coordinator completion-consumption path (with isolated database/test doubles as appropriate), and assert neither SQL nor trace is marked failed for that accepted business; the recording uncertainty must remain visible. Include a post-completed-result usage-replay failure. The current runtime-only archive test proves a rejection and no local `run/finished`, but does not cover this caller's rewrite.

## P2 — quarantine rejection permanently fails subsequent queued projects

Locations: existing `apps/api/src/run-coordinator.ts:104-132,135-157`, consuming new `product-runtime.mjs:49-57,78-102`.

The new runtime readiness/launch guard retains a quarantined Host correctly. Its existing coordinator never reads that readiness before claiming the next queued run. Once the original accepted run has returned completed/pending and its SQL status is finished, `tick` can claim the next queued project as running. `launch` performs its authorization/import preparation and then calls `runtime.start`, which throws `RUNTIME_TEARDOWN_PENDING`. The generic catch permanently marks this waiting project failed. A long-lived original teardown can therefore fail successive already-queued projects, even though they performed no business work and would be runnable after the original promise settles.

Smallest correction: make the existing scheduler honor runtime quarantine before claiming work and treat the narrow check-to-start readiness race as a temporary deferral, preserving the existing queued job rather than writing a business failure. Reuse the existing queue/lease mechanisms; do not create another scheduler or cleanup queue.

Minimum RED: queue a second project, hold the first accepted run's original Host or executor close past the bounded completion, and tick the coordinator. The second project must remain queued/unprepared, with no failed trace or model call. After that same close promise settles, it must be claimed and prepare once. Also exercise quarantine becoming active between the initial readiness check and `runtime.start`.

The REDs above are source-derived missing tests, not executions by this reviewer. No test/PG process was launched.

## Direct behavior verified without another required change

- Task-profile finalizer presence is checked before executor prepare and before model/tool execution. The actual LocalRunExecutor prepare path separately performs its existing trusted provider/deadline handshake. Legacy construction retains its prior optional finalizer behavior.
- After the current final checkpoint boundary, the Host fence is synchronous and precedes awaiting `finalizeAccepted`. The source-only finalizer is awaited without a caller timeout/race. Expected finalizer errors and malformed returns become bounded pending maintenance, and cancellation after acceptance does not set the business-cancelled flag.
- `closeAcceptedResources` creates one Host close promise and one executor close promise, retains both resources/promises on the job, and uses one all-settled group for the 10-second local resource wait. A hanging executor close is included in that same group; no second close or device-stop redispatch is introduced.
- After the local wait expires, runtime keeps the original job/Host/executor while unresolved, reports readiness false and refuses direct new starts. Its eventual group settlement releases readiness/references; late completion does not rewrite the returned business result. Finally does not re-await that close group or repeat executor close.
- The new task fixture finalizers explicitly fail if invoked after their expected prepare/checkpoint failure. The supplied native Host test establishes late registered body denial while teardown is held. The separate previously reviewed Host fence is reused.

## Evidence and limits

The supplied runtime RED log records 10 tests with **9 intended failures and 1 passing characterization**; its exit file is 1. The supplied GREEN log records **10 passed, 0 failed/cancelled/skipped**; its exit file is 0. These exercise installed DSH/AgentTeams, native task/Handoff and durable archives with fixture model/executor behavior. They do not authenticate SQL stop provenance, physical device facts, paid models, or the coordinator consumer cases above. Parent-owned broader regression evidence is separate.

Reviewed source SHA256:

| File | SHA256 |
| --- | --- |
| product-runtime.mjs | `3EDE7F8B687775D5862AEE9BB7D3045F45C52EA1837040D43020D087025163AB` |
| product-runtime.d.mts | `2E61572F39EFCAEA704CDA82170E5D08CB1590B267C6CF6BFAA53E1D11FFDFC2` |
| terminal-finalization.test.mjs | `C290A21D8F2C22D307B73443C93F747B6018CD813817B76A8534C6476A16CF67` |
| task-sandbox-flow.test.mjs | `9991ECBF2A790AB81687D1A83EED554D65A027779407BED0A8E3AAB0727E658F` |
| task-readonly-handoff.test.mjs | `22DD08D7EA56F31E1FFAFACFCA232C961851F25384C798BDA2CCAC4ACEB21020` |

Only this review report was written. No source, PG/PGlite, test suite, build, network, paid model, JJ, Git, installation or device action was performed. This review does not certify clean native resource release or the complete terminal/Task 5 contract.
