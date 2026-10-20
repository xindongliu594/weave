# Task 2a scoped re-review — 1ed2563..6bc0404

Spec compliance: **PASS**. Code quality: **PASS**.

- The previous blocking admission-reentrancy finding is resolved. `services/agent-runtime/openai-compatible.mjs:499` registers the original request before preparation/reservation can invoke synchronous budget callbacks. A reentrant `stopAdmission()` therefore sees that original owner and cannot fulfill actual drain while admission is still pending.
- `services/agent-runtime/openai-compatible.mjs:500` centralizes removal, original done-promise settlement, and actual-drain recheck. Preparation failure calls the existing synchronous error observer while ownership remains held, then releases in `finally` (`:508`, `:509`); normal request handling releases through its existing final block (`:630`). These branches are exclusive, so they do not introduce duplicate completion or remove another request.
- Request accounting and transport order remain intact: budget preparation/reservation precedes call increments and durable admission; undispatched error accounting remains inside the original request lifetime. The fix adds no request, reservation formula, fee rewrite, retry, or observer-created rejecting promise. The earlier runtime/coordinator rejection observers are unchanged.
- `services/agent-runtime/writer-drain.test.mjs:16` exercises the exact synchronous budget-stop path with both admission and undispatched-error callbacks held in sequence. It verifies pending actual drain at each tail, stable promise identity, zero transport requests, one original local/run call count, one undispatched stop receipt, and released reservations. The rejection control at `:46` verifies error-observer ownership, zero durable admissions, and zero charged calls.

## Evidence inspected

- Read `task-2a-fix1-report.md` and the supplied two-file diff once. No source exploration beyond the diff and no unrelated Host/coordinator sections reopened.
- `task-2a-fix1-red.log`: focused regression command exit 1 before implementation.
- `task-2a-fix1-green.log`: same focused command, 2/2 passed, exit 0.
- `task-2a-fix1-regression-ordinary.log`: affected adapter, budget, Responses and preflight coverage, 96/96 passed, no skips/cancellations, exit 0.
- `task-2a-fix1-reproducer.log`: original reviewer reproducer now reports `beforeRequestPending:true`, `writerDrained:false`, `activeRequests:1`, then `RUNTIME_STOPPING`; exit 0.
- `task-2a-fix1-build.log`: TypeScript/Vite build exit 0. The previously recorded >500 kB bundle warning is unchanged and is not a new regression.

No remaining actionable finding in this fix. The original Task 2a blocker can be closed. This is a scoped re-review of request ownership, nearby accounting/finally ordering and regression evidence; it does not expand prior acceptance boundaries to native archive fencing, source recovery, production shutdown, native PostgreSQL or real device quiescence.

No tests rerun, heavy-test slot taken, source/Git mutations, production access, model API calls, or subagents. This requested report is the only file written.
