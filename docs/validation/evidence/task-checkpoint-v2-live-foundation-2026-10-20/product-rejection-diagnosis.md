# Product approval regression: narrow diagnosis

Read-only static diagnosis on 2026-10-20. No test runs, runtime changes, database access, dependency changes, or Git operations performed by this worker. The report is the only file written.

## Finding

The recorded approval failure is explained by the fixture's coordination timeout before the product reaches its stale-scope check. There is no evidence in this failure that `TASK_SCOPE_CHANGED` was serialized incorrectly, pruned from context, or searched in the wrong field.

Evidence:

- `tests/task-sandbox-flow.test.ts:62–65`: `until` defaults to 20,000 ms and throws `assert.fail(label + ': ' + JSON.stringify(value))` when the condition remains false.
- `tests/task-sandbox-flow.test.ts:133–136`: the fixture first persists an approved record and adds it to `approvals`; on the first producer approval it then waits for B's acceptance **before returning the approval ID**. A timeout therefore rejects `requestApproval` despite the already recorded approved row.
- `services/agent-runtime/product-tools.mjs:63–64`: product execution awaits that callback without swallowing its rejection. Rejection exits before the dispatch preparation and stale binding check at lines 74–78, and before `sandbox.execute` at line 87.
- `services/agent-runtime/task-tool-context.mjs:2–5`: the stale binding check explicitly creates an error whose message contains `TASK_SCOPE_CHANGED`. It cannot produce that message if execution never reaches it.
- Parsing the saved `approval-v2-diagnostic2.txt` assertion payload yields exactly one distinct plain tool error: `Error: B commits after the old A approval is approved: false`; zero payload items contain `TASK_SCOPE_CHANGED`. This matches the fixture's `until` label, including the last observed `false` value.

## Why the other approval assertions passed

`tests/task-sandbox-flow.test.ts:114–116` scripts two consecutive `terminal_test` calls in approval mode and advances its response step regardless of the prior tool result (`120–121`). Consequently the fixture can continue after a timeout and ask for another approval. It can finish with two different scopes, zero operation for the old approval, and a single operation for the renewed approval (`255–259`) even though the first call failed inside the approval fixture rather than at scope rebinding.

The employee-visible stale-scope assertion at line 260 is therefore valuable and must remain. It distinguishes the intended scenario from this timeout path.

## Minimal correction and verification boundary

The root's current source already gives the two B-acceptance coordination waits 40,000 ms: provider interleave wait at `tests/task-sandbox-flow.test.ts:108`, approval callback wait at line 135. This is a narrowly scoped fixture timing change. The B-start boundary wait at line 109, product deadline (`86`), model/budget limits, zero-old-operation check, explicit renewed approval check, and employee-visible rejection assertion remain unchanged.

Rerun both affected Product cases and retain all assertions at lines 255–260. A green rerun must show that the actual stale-scope error reaches a subsequent model request while the old approved scope still creates zero device operations. This worker has not rerun either case, so the timing correction remains unverified here. If the 40-second waits fail, inspect the new concrete error before changing context serialization or authorization behavior.
