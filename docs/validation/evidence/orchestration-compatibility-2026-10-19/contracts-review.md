# Task 1 independent review

Spec compliance: **changes requested** (one P2 compatibility issue).

Code quality: **changes requested** for the same issue; no other important defects found in the scoped implementation.

## Finding

### [P2] Preserve `validatePlan(..., false)` tool-validation behavior

Location: `packages/contracts/orchestration-patterns.ts:92` (the unconditional `taskContractErrors(plan.tasks, plan.agents)` call), reached from `packages/contracts/index.ts:253`.

The existing validator deliberately passes no agents to `taskContractErrors` when `requireToolSupport` is false (`index.ts:251`). The new pattern validator then calls the same function again with the full agents list regardless of that flag, restoring its employee tool-grant checks for any new template. This contradicts Task 1's explicit requirement to preserve the existing parameter meaning. Structural pattern validation should remain unconditional, while this added call should not duplicate the authorization checks whose context the existing `validatePlan` caller already controls.

Trigger and focused probe: create the valid pipeline fixture, set every agent's `tools` to `[]`, and call `validatePlan(plan, orchestrationPolicy, orchestrationModels, false)`. With the template present, the errors are `a: 输出文件需要写入工具权限；check: 输入文件需要工作区读取权限`. Delete only `plan.orchestration.template` and the identical call returns `errors: []`. This is a preview-validation compatibility regression, not an execution-approval bypass.

Suggested correction: keep shared structural task-contract validation in `orchestrationPatternErrors` without unconditionally supplying agents, and retain permission validation in the existing context-aware `validatePlan` chain. Add a focused regression proving the false flag keeps its former behavior while invalid template bindings are still rejected and normal/default validation still enforces tools.

## Reviewed evidence and positive checks

- Read the binding brief, implementation report, complete review package, all five implementation/test paths, existing task/delivery contracts, and relevant validator callers.
- Seven strict discriminated references, registered definition/hash matching, deep runtime freezing, and unconditional offline execution errors match Task 1's intended contract.
- Legacy references return no new pattern or execution errors. No automatic legacy backfill, runtime changes, budget changes, or executable acceptance state was added in this task.
- Explicit delivery criteria retain independent checks and manager ordering through existing contracts. QA and manager evidence outputs do not create recursive review obligations; the added regression covers this distinction.
- Branch joins, immutable map inputs, bounded review-repair expansion, and proposal/critique/manager bindings are represented in code and focused test cases.
- Inspected supplied logs: targeted suite records 56/56 passing; compiler evidence records exit code 0. These are supplied implementation evidence, not independent reruns.
- Independently ran only the above targeted in-memory probe (exit code 0); no repeated suites, model calls, production database operations, deployment, source/index/HEAD/branch edits, or agent spawning.

Remaining scope: actual acceptance and approval/run-admission integration belong to later tasks. This review does not certify those paths or semantic completeness of user requirements.

## Scoped re-review: fix round 1

Previous P2: **ADDRESSED**.

Updated spec compliance verdict: **PASS** for the reviewed Task 1 scope. Updated code quality verdict: **PASS**; no important new issue found in the fix.

The fix removes the unconditional agents argument from the pattern-level `taskContractErrors` call, leaving structural validation active while the original `validatePlan` call controls employee tool/grant validation. The paired regression covers template and legacy plans with `false`, explicit `true`, and omitted/default flags; it also proves an incomplete frozen binding still fails with `false`. This addresses both the reproduced regression and the risk of accidentally disabling pattern validation.

Read the fix package, appended implementation report, actual changed source/test lines, and supplied covering log (57 tests, 57 pass, 0 fail). Did not repeat the suite or type check, edit source/Git, or spawn agents. Approval/run-admission and real acceptance remain outside this scoped re-review.
