# Task 4 full-flow test independent review

Verdict: **PASS for the three full-runtime engineering integration scenarios.** No definite test defect or fabricated success path was found. This verdict does not open the production execution profile or complete Task 5/6, physical isolation, JJ, or real-model acceptance.

Read-only review on 2026-10-20 of `tests/task-sandbox-flow.test.ts`, the relevant ProductDshRuntime/Host/tool and Handoff composition, `tests/model-fixture.ts`, and `task-4-full-flow-{red,green}.log`. No database test was rerun while the parent owned the final API integration slot. No source was edited.

## Genuine integration path

The test constructs a real `ProductDshRuntime` and calls `runtime.start` with the persisted approved snapshot. Runtime creates the actual Host, approved native AgentTeams graph, employee sessions, task mapping/registration, product/native tool adapters, and Handoff gate. Scripted responses arrive over a local OpenAI-compatible HTTP provider; they use task/attempt IDs taken from the Host's protected runtime context rather than inserting trusted assignment events manually.

`createExecutor` supplies the real `LocalRunExecutor` and `LocalOperationService`. The fixture polls the actual Express `localDeviceRouter`, authenticates as the fixture device, calls `/start`, and submits `/result`. It then waits for the real executor to produce `merge_state='committed'` and reads the canonical SQL head plus archive objects. It never inserts/updates completed local operations, registered task workspaces, merge intents/receipts, or canonical heads to manufacture success. The SQL writes in this file set up approved departments/project/run/device and plugin state, and store automatic approval decisions from the runtime's approval callback.

The provider and physical device execution are controlled engineering substitutes. The approval decision callback also auto-approves the exact arguments into the normal approval table; the production approval UI/pending-decision service and coordinator launch path are not exercised here. The test explicitly verifies that `assertExecutionProfile` still refuses this profile before directly starting the owned fixture runtime.

## Meaningful assertions

- Every delivered operation waits for durable committed merge and compares the full canonical file set against an independent expected map, including `in.txt`, the unrelated `private.txt`, both A outputs, and B output as they arise. This catches partial mirroring, dropped unrelated files, and incorrect publication.
- Device polls are checked for absence of the private filename/private task scope. Actual employee tool messages sent back through the provider are checked for private filenames; B's tool results also cannot list A's other output. Prepare imports exactly one authorized file, once per task, and B's accepted-dependency import requires a real preceding A `handoff/accepted` event.
- The consecutive-write case drives A's two outputs and revision plus a command, and B's native write/read/product revision/command. It asserts rolling scope hashes, the same task sandbox, different A/B sandboxes, merge revision continuity, immutable accepted upstream lineage, and B's own-output origin from its prior committed merge. It also checks an observed A command has a merge ID and task-bound execution receipt.
- Normal dependency mode uses distinct employees with A `implementation` and B `review`, `reviewedTaskId='a'`, a real dependency, and review verdict `pass`. Runtime reaches its unmocked native deliverable and Host verification path only after both tasks are accepted. Parallel modes use independent `work` tasks so their interleavings do not bypass or weaken the normal implementation/review graph.
- The unrelated-commit case blocks A's provider response while B completes, checks A's next operation follows B acceptance, retains A's original input origins, and confirms B's final content survives A's next canonical merge.
- The approval case approves the original A scope, waits for B's real acceptance, and observes the stale scope failure through the real employee tool response. Exactly two A approvals exist, only one A command reaches device transport, the old approval has zero local-operation rows, and the dispatched operation preserves the newly approved arguments exactly.
- Shared RunSandbox readiness and execution methods are replaced by counting failures, and the completed run asserts zero fallback calls. All recorded operations must have started, completed, and committed merges; the number of operation rows must equal jobs actually delivered through HTTP.

## Evidence and limits

The RED log fails at the physical-device fixture's revision-domain assertion on an actual runtime file tool, exposing the now-corrected API conversion bug. The inspected GREEN log records all three named scenarios passing with no skips or failures, total `77337.2309 ms`. That is worker-run evidence inspected by this reviewer, not an independently rerun suite.

Reviewed test SHA-256: `aa2b18cab9acab97a12c65f8a3e6ab7cbd9be47bc6d072300418c1f5bf05ef0d`.

Reviewed GREEN log SHA-256: `2f9814dbbcfc9ade323a9dfffccd31c19f8b909125c18a129f9f756edc430bef`.

The tests prove the real application wiring and durable merge/Handoff behavior under controlled responses. They do not run actual OpenShell CLI/process isolation, execute a real native plugin bundle, make paid/saved-model calls, prove independent PostgreSQL locks, deploy to JJ, exercise recovery/consumers/maintenance, or satisfy Task 5/6. The existing separate negative boundary suites remain necessary; these three scenarios do not replace them.
