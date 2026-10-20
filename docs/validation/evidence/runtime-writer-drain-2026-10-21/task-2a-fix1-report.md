# Task 2a fix1 report

Status: DONE, ready for root's follow-up independent review. Root-supplied candidate baseline: `1ed2563` (not pushed). This implementer performed no Git operation, dependency change, paid/external model call, production/JJ access, native fence change, or production database action. Original Task2a candidate logs and source manifest were preserved unchanged.

## Review finding and correction

Read and verified `task-2a-review.md`. Its Important finding was reproducible: preparation and budget reservation could synchronously invoke onBudget before activeRequests registration; stopAdmission then permanently fulfilled writerDrained, although the same original stream subsequently entered a held beforeRequest callback.

`stream` now establishes the original request record before `#prepareRequest` and budget callbacks. One local finishRequest function removes that record, settles its original done Promise and rechecks actual drain. Preparation failure invokes the existing onError observer while request ownership is still held, then releases ownership in a finally; regular requests release in the existing original finally. This is ordering/ownership, without a microtask delay, additional dispatch, altered budget formula, new stop policy or accounting bypass. The original in-progress admission can finish and persist its undispatched error accounting, while the permanent stop blocks subsequent streams.

The new held-callback regression independently checks both beforeRequest and onCallError tails, zero transport dispatches, one original local/run call count, one undispatched RUNTIME_STOPPING receipt, zero spend/reserved holds and stable drain identity. A separate rejection control verifies the preparation error observer still sees the original owned request, no durable admission occurs and no call/reservation is charged when budget validation fails.

## RED → GREEN and bounded verification

- `task-2a-fix1-red.log`: `node --test --test-name-pattern='synchronous budget' services/agent-runtime/writer-drain.test.mjs`, actual exit **1**, **2 expected failures** before implementation. First: writerDrained was true while original admission was held. Second: budget-error observer saw activeRequests=0 instead of owned original request=1.
- `task-2a-fix1-green.log`: exact same focused command, exit **0**, **2/2 passed** after implementation.
- `task-2a-fix1-regression.log`: initial bounded sandbox attempt; local HTTP Responses fixture tests failed under the sandbox and their child did not exit. Interrupted exact tool session with Ctrl-C, observed exit **1**. No whole-command success is claimed. No source change was made in response to this environment limitation.
- `task-2a-fix1-regression-ordinary.log`: bounded ordinary-Windows rerun using synthetic data and ephemeral loopback HTTP only, exit **0**, **96/96 passed**, no skips/cancellations. No native Host/SQL full suites rerun.
- `task-2a-fix1-build.log`: `npm run build`, exit **0**; project TypeScript check and Vite build passed. Existing >500kB bundle warning remains. No declaration changed, so no additional changed-declaration check was needed; the candidate declaration manifest/check remains intact.
- `task-2a-fix1-reproducer.log`: reviewer's exact in-memory PowerShell here-string piped to `node --input-type=module`, exit **0**, no network request or database. Its script is preserved verbatim in `task-2a-review.md`; the fix1 tool invocation reruns it unchanged.

Regression command:

```text
node --test --test-force-exit --test-concurrency=1 --test-timeout=15000 services/agent-runtime/writer-drain.test.mjs services/agent-runtime/openai-compatible.test.mjs services/agent-runtime/responses-compatible.test.mjs services/agent-runtime/request-preflight.test.mjs services/agent-runtime/budget.test.mjs services/agent-runtime/coordinator-budget.test.mjs
```

Original review reproducer output (pre-fix, preserved in review):

```text
{"beforeRequestPending":true,"writerDrained":true,"activeRequests":1,"beforeRequestCalls":1}
RUNTIME_STOPPING
```

Same reproducer output after fix:

```text
{"beforeRequestPending":true,"writerDrained":false,"activeRequests":1,"beforeRequestCalls":1}
RUNTIME_STOPPING
```

No claim is made about Task2b/c, source fencing, native PostgreSQL, real Docker/device quiescence, production shutdown, or rollout. This fix changes only adapter request ownership at the reviewed synchronous callback boundary.

## Exact fix1 production/test allowlist and SHA-256

Only these two production/test files were changed in fix1. New fix1 logs/report/hash list are adjacent evidence, separate from the original candidate manifest.

```text
496638d364ec4a78b05bea8d4c3860260bbc57c9797cad69ab4b8d3c216ae1f6  services/agent-runtime/openai-compatible.mjs
6b288a67193f1644f50f723b6005047cb099242d24733932262861aa41b0bbaf  services/agent-runtime/writer-drain.test.mjs
```
