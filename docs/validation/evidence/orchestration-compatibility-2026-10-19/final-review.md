# Whole-phase review — orchestration compatibility

Date: 2026-10-19. Reviewed increment: `8fac1e1..8ea78ae` (research/spec/plan, Task 1, Task 2). Prior MVP changes are outside this review.

Spec compliance verdict: **CHANGES REQUESTED** for two P2 planning-contract integration issues. The narrower local compatibility milestone is the applicable completion scope; real acceptance and rollout are intentionally deferred.

Code quality verdict: **CHANGES REQUESTED** for the same two issues. No demonstrated new execution-admission, permission, budget, legacy-layout, or historical-recovery regression found in the reviewed increment.

## Important actionable findings

### [P2] Make the terminal task instructions distinguish template preview rework from legacy zero rework

Changed location: `apps/api/src/organization-routing.ts:57`; integration call sites: `apps/api/src/organization-chat.ts:120,127`. Conflicting existing source: `apps/api/src/organization-task-planning.ts:21`; rejecting validator: `packages/contracts/orchestration-patterns.ts:112`.

When organization routing is enabled and terminal/terminal_test is authorized, the actual assembled first system message contains both the unconditional `maxReworkRounds 固定 0` instruction and the new `review_repair 可预览 1..2 轮返工` instruction. The application-constraints catalog separately requires 1..2 for that template. The new text does not explicitly scope or supersede the zero-only contract. A model following the first mandatory instruction produces a structurally invalid review_repair preview; resolution returns a draft issue instead of a saveable preview. This can consume the existing planning call without producing the newly advertised candidate. The static response fixtures bypass instruction following, so their successful seven-template cases do not cover this conflict.

Focused evidence: an in-memory probe evaluated the complete `messages` construction extracted from organization-chat.ts using its imported instructions, actual routing/catalog definitions and output schema, with routing enabled and terminal granted. Both phrases were present. Setting only the valid review_repair fixture's review task to `maxReworkRounds=0` yielded `review_repair: 返工绑定必须为批准 1..2 轮的合法独立实现审查入口`.

Requested correction: make the instructions explicitly context-sensitive (or state a clear template-preview exception) so legacy no-template candidates retain zero rework while a referenced review_repair preview requires 1..2. Keep server approval closed. Add a focused assertion on the composed request for routing+terminal and the legacy path; no paid model experiment is needed.

### [P2] Tell the planner that every new-template delivery criterion requires independent=true

Changed location: `apps/api/src/organization-routing.ts:57`; enforcing contract: `packages/contracts/orchestration-patterns.ts:94`.

The routing instructions still say `需要独立核对时 independent=true`. However every referenced template rejects any delivery criterion whose independent flag is false. The JSON Schema permits either boolean and the bounded catalog does not state this shared additional requirement. A model can therefore follow the delivered instructions, assign a separate checker but mark a routine check independent=false, and lose an otherwise valid preview. This is a deterministic disagreement between what the planner is told to emit and what the server accepts, independent of any unmeasured model-selection quality.

Focused evidence: the same complete-message probe found the conditional instruction and no explicit all-template independence rule. Changing only the pipeline fixture's criterion to independent=false (leaving its distinct checker and DAG intact) yielded `pipeline: 必须声明独立交付检查与经理验收`.

Requested correction: explicitly require independent=true and a different author/checker for every delivery criterion when orchestration.template is present, while retaining the conditional legacy behavior when absent. Add a composed-request assertion or focused catalog/prompt regression for that distinction.

## Evidence and cross-component review

- Read the binding design, narrower implementation plan, progress rulings, both implementation reports, both task reviews including Task 1's addressed parameter-regression finding, review package, changed production/tests/probe files, and compact validation evidence.
- The seven strict discriminated references validate ID/version/hash and frozen task bindings. Registry definitions are deeply frozen; status is excluded from model/client reference fields. Existing validation still owns context-sensitive employee tool checks, and the Task 1 fix preserves validatePlan(..., false).
- The approval gate inspects the persisted plan after project/version locking and unconditionally rejects any present template reference before model/credential/target preparation, run creation or launch. Direct/automatic/forged-status test assertions exercise that boundary. This review found no client-controlled path through that gate.
- Legacy plans return no new pattern/execution errors. The old three layout names remain. New pattern validation composes with existing task, delivery, permission and budget validation instead of adding another runtime.
- Preview/confirmation/version persistence tests compare complete frozen orchestration data. The advanced save now spreads preview.plan; the main PlanEditor already clones/spreads the complete plan. AI project revision rejects silently dropping a confirmed reference. Explicit user editing remains governed by the existing plan workflow.
- Snapshot construction preserves orchestration/deliveryCriteria. The archive/resource regression preserves even an unknown historical definitionHash through archive read, resource adjustment and child archive, without looking up a latest definition. No runtime or recovery implementation was changed by this increment.
- The public native probe tests installed public configuration/tool APIs with a rejecting pre-step event and offline adapter. Its report correctly distinguishes persistence of a host contract in description JSON from native enforcement or actual employee execution.
- Supplied evidence records 57 contract, 36 integration, 4 UI, 1 native, 13 runtime and 38 recovery checks passing, plus a successful build with the existing chunk-size advisory. Those were reviewed, not rerun. The only independently executed probe here was the focused pure in-memory prompt/validator check above; it exited 0 and used no database, server, model provider or deployment.
- The documentation accurately separates fixture/static/API compatibility from real planning, real employee work, restart acceptance and future rollout. The stage rulings do not require completing those future milestones before this local increment; the two prompt issues concern the current milestone itself.

## Declined to judge / remaining limits

- Actual model selection accuracy, semantic completeness of delivery criteria, semantic independence of proposals, execution quality, timing or cost improvements: no real provider/employee experiment was authorized or run.
- Real per-template execution and supported restart acceptance, company template lifecycle, archived-template rollout policy and compatibility across future runtime versions: explicitly future work. All seven references remain preview-only.
- Browser interactive edit/save behavior and full recovery HTTP execution: inspected preservation code and supplied scoped regressions, without claiming end-to-end coverage.
- External research URLs and upstream current versions were not re-fetched; this is a review of the pinned implementation and recorded research, not a new research or dependency-update task.
- The entire pre-existing runtime/security surface and unrelated worktree files were not re-audited. No source/Git mutation, agent spawning, production DB access, paid inference or deployment occurred. Only this requested review report was written.

## Scoped final re-review — fix wave based on 8ea78ae

Date: 2026-10-19. Scope: only the two P2 findings above, their precise fixes, and newly introduced issues within that fix. Read `final-fix-review-package.md`, the actual scoped source/test diff, `final-fix-report.md`, exact GREEN logs, and the durable RED/GREEN evidence in `docs/validation/evidence/orchestration-compatibility-2026-10-19/final-review-fix.txt`.

1. **P2 contextual rework instructions: ADDRESSED.** The organization chat now passes its routing flag into the task-instruction helper. For template-aware terminal planning the helper explicitly requires zero without a reference and 1..2 for the bound review_repair review, with preview-only wording; the unconditional zero-only instruction is absent. Its default/exported string remains the legacy string consumed by project-planning.ts, and office-only instructions are unchanged. Unit assertions cover terminal and terminal_test, default/export equivalence and the office path. The new gateway-captured complete-request assertions cover both routing and non-routing requests, including the single planning-call count. The unchanged zero-round example is explicitly a contract example, so it no longer conflicts with the scoped mandatory rule.

2. **P2 all-template independent delivery criteria: ADDRESSED.** The routing instructions now explicitly require independent=true and a checker different from every producer author whenever orchestration.template exists; the conditional rule is explicitly restricted to the no-template path. A complete-request assertion covers both clauses. The legacy fixture with independent=false still previews/confirms without acquiring a template, proving the text correction did not change legacy acceptance behavior.

The fixes change instruction assembly and focused tests/documentation, not validators, permissions, budgets, runtime, or approval gates. Existing seven-template API cases still assert ordinary, automatic and forged-status approval denial before execution side effects; fresh supplied integration evidence includes all seven passing. No important new issue found within this fix scope.

Updated spec compliance verdict: **PASS for the local compatibility milestone**. Updated code quality verdict: **PASS**. Both original P2 findings are closed, with no outstanding important finding from this review. **The reviewed local milestone is ready to commit** through the controller's existing authorization; this is not deployment or execution approval.

Evidence reviewed: planning/routing unit tests 7/7; organization API integration 39/39 (13+3+23), zero failed/cancelled/skipped; TypeScript/Vite build successful with the existing chunk-size advisory. These are inspected fresh implementation results, not independent reruns. No suites, source/Git edits, deployment, real model calls or subagents were performed during this re-review. Real model instruction-following, per-template employee/restart acceptance and rollout remain future authorized work; every new template remains preview-only.
