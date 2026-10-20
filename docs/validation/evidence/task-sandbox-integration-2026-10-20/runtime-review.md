# Task 4 runtime independent review

Date: 2026-10-20. Base: `a581e7a`. Result: **PASS for the bounded runtime changes after the corrections below; no remaining definite finding in this review scope.** This is not approval to open the execution profile or a claim that Task 4–6/B2 are complete.

Reviewed `AGENTS.md`, the B2 implementation plan Task 4 and global constraints, runtime brief, early runtime review, installed-DSH research and boundary report. Source scope: `task-tool-boundary.mjs`, `task-tool-context.mjs`, `product-tools.mjs`, `native-plugin-tools.mjs`, `host.mjs`, `employee-hosts.mjs`, `employee-tool-access.mjs`, `handoff.mjs`/`.d.mts`, `run-evidence.mjs`, `product-runtime.mjs` and their changed/new tests. Read the relevant task binding/executor interfaces only to check runtime contracts; did not duplicate the full HTTP/API review.

The reviewer initially performed read-only source/test review. The parent subsequently authorized adding only `services/agent-runtime/task-readonly-handoff.test.mjs`; no production source, DB, dependency, model/API, JJ or commit changes were made by this reviewer. Scratch reproduction and this report are under this task's `.superpowers/sdd` directory. No subagents were spawned.

## Finding discovered and closed during review

**P2 — knowledge-only tasks could not complete.** Before the correction, `host.mjs` registered the active attempt before a completion call but only file/terminal/native adapters called `prepareTaskTool`. `HandoffGate.prepare` requires a task work revision. A task with empty input/output/verify contracts that used an authorized `knowledge_search` therefore reached the real completion boundary without an execution scope.

Actual `createTeamHost → EmployeeHost → AgentTeams` reproduction with a fixed model fixture produced:

```json
{"bound":7,"prepared":0,"knowledgeSucceeded":true,"completion":"HANDOFF_BLOCKED: read: TASK_SCOPE_REQUIRED: 缺少任务工作版本","accepted":0}
```

The tracked regression was observed RED against the old Host, with a valid real `createTaskWorkspace`-derived empty scope available in the executor fixture; the Host never requested it. The parent changed the completed-update mutex section to refresh the trusted task scope before Handoff preparation (`host.mjs:324-338`). The regression now passes, requiring exactly one prepare, one accepted record, and the exact run/generation in that record. It does not require an undeclared file or terminal tool.

The parent also closed a source-audit concern in that new section: work was captured before waiting for the Handoff mutex, while `prepareTaskTool` independently selected the active work after waiting. Current code rereads the submitted task/attempt inside the mutex, then compares the prepared work to the original submitted work after the await (`331-334`). The old-A/new-B combination cannot be sealed by those paths. This narrow queued-task scenario was assessed from the final source; no separate full API/OS race reproduction is claimed.

## Earlier findings and other boundaries rechecked

- Generation-bound command reuse: `HandoffGate.bindExecutionScope` invalidates command/inherited proof when the execution key, stable workspace binding or capability hash changes (`handoff.mjs:131-136`). The real Handoff regression rejects generation-1 proof after generation-2 binding with identical bytes. Canonical/scope renewal alone does not invalidate proof when the authorized task content is unchanged.
- Downstream partial/full revision confusion: enterprise `run-evidence` checks the accepted task work revision and matching task key/generation proof. Legacy records keep the full canonical comparison. Regression covers distinct canonical/task revisions and rejects a different generation. Handoff still rejects own-file changes before acceptance.
- Coordinator and employee registries install the shared boundary before their registrations. Policies snapshot exact admitted definitions, require the live principal, retain the explicit infrastructure list, and enforce domain grants. Late definitions/scoped shadows do not inherit permission by name. Actual coordinator Host and shared-boundary tests cover these paths.
- The body boundary rechecks the final guard admission, argument reference and invocation identity, current scoped definition and synchronous policy. Frozen captured definitions preserve the registered callback; nested/scheduler calls require their own admission. This is the normal DSH registration/execution boundary, not isolation from arbitrary hostile JavaScript rewriting service internals.
- Product terminal approval captures the exact public task key/scope/work binding before waiting, and compares it against a newly prepared scope behind the Handoff mutex before transport. File/native adapters use the prepared task scope and trusted generation; they do not obtain identity or extra read paths from model arguments. Invocation binding is rechecked after relevant waits. API remains responsible for transactional authority/revocation and immutable native bundle verification.
- Handoff observes only matching committed task merge evidence, distinguishing full canonical baseline/after versions from the partial sandbox receipt. Command proof is measured over authorized task paths, so unrelated employee files do not make a valid test stale.
- `ProductDshRuntime` requires the task OpenShell executor interfaces and initializes committed cache before the first supervisor/Handoff cache read; it has no task-profile `RunSandbox` fallback. Task recovery is explicitly rejected here. `execution-policy.ts:21-22` still rejects task-profile launch/recovery, preserving the closed gate until Tasks 5/6.

## Fresh independent verification

All runs set `TEMP` and `TMP` to `.superpowers/sdd/2026-10-20-task-sandbox-integration/independent-review-temp` in this workspace. No escalated permission was needed.

```powershell
node --test services/agent-runtime/task-readonly-handoff.test.mjs services/agent-runtime/task-sandbox-flow.test.mjs services/agent-runtime/product-tools.test.mjs services/agent-runtime/run-evidence.test.mjs services/agent-runtime/task-tool-boundary.test.mjs services/agent-runtime/employee-tool-access.test.mjs services/agent-runtime/employee-hosts.test.mjs
```

Final run after the exact task/attempt mutex recheck: **54/54 pass, 0 fail, 0 cancelled, 0 skipped**, exit 0, 3.94 seconds. This includes the RED→GREEN knowledge-only Host regression, actual Host late/scoped definition denial, exact approval-scope renewal rejection, renewed-generation proof rejection and no shared fallback/cache-order checks.

`npm run test:handoff`: **7/7 pass**, exit 0, 31.87 seconds. Output: `.data/handoff-fixtures/2026-10-20T09-01-30.588Z-17fa6560`. These are existing local fixed-file/protocol compatibility fixtures; the suite expressly excludes production DB/approval UI, real model/API quality and Docker/OpenShell execution.

`git diff --check` over the reviewed production files and the added test: exit 0; ordinary LF-to-CRLF notices only.

Final source anchors (SHA-256):

- `host.mjs`: `d6eda7c2e12da3095af734a9ddcceeb6692968836bb72a7a28ed19028dc876c1`
- `handoff.mjs`: `e892286e1f3be84a9d213ab4b73be3568183b46aa622d019e946e94ca0fea2ab`
- `task-tool-context.mjs`: `66b5c9a6fdd92fa609730a2c8d581d46c1c8802f1b2be7f614a1dcd10f77ab24`

## Limits and gate

No DB test, full `ProductDshRuntime → HTTP/device poll/start/result → LocalRunExecutor` validation, PostgreSQL concurrency, build, real native plugin/OpenShell execution, JJ, paid model, checkpoint v2, canonical HTTP consumer/recovery/storage/backup verification was run by this reviewer. The parent and other Task 4 worker own the full product/API evidence. Tasks 5/6 remain necessary and the profile must remain closed. The 54 runtime tests and seven compatibility fixtures prove only the explicitly described local layers.
