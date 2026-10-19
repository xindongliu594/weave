# Organization draft feedback repair

> **For agentic workers:** Use superpowers:executing-plans inline; one focused review at completion. Existing user authorization covers this repair, without new paid calls.

**Goal:** An invalid handoff must remain rejected while other safely checkable task errors reach the same existing correction turn.

**Architecture:** Reuse installed Zod 4.1.5, `validatePlan`, task file contracts, acceptance checks and `previousDraftIssue`. A diagnostic-only schema projection omits handoff for independent checks; its result never leaves the helper, never becomes a candidate and never reaches persistence. Existing-team lookup stays behind the original complete schema.

**Tech Stack:** Existing TypeScript/Express/Zod/PGlite; no new dependency.

**Spec:** `docs/validation/orchestration-smoke-result-2026-10-19.md`, original saved raw responses and AGENTS.md.

## Research and decision

- Current DSH is pinned to `0.1.5-rc.1`. Locally inspected `dsh-llm`/`dsh-llm-deepseek` packages did not expose a JSON-schema reply switch usable by this direct organization conversation route. No plugin engine replacement is warranted for a failed draft.
- [Zod error formatting](https://zod.dev/error-formatting) and [safeParse](https://zod.dev/basics) support collecting structured issues; installed 4.1.5 already suffices. Reuse original schemas and validators, with a strictly diagnostic projection of fields independent of handoff.
- [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode/) describes syntactic JSON, not our cross-field authorization and file contracts. [Strict tool calling](https://api-docs.deepseek.com/guides/tool_calls/) has a different beta endpoint/contract; the Go gateway's support has not been established. Do not add unsupported request options or hidden retries.
- [OpenCode SDK structured output](https://docs.opencode.ai/docs/sdk/#structured-output) uses its server and a `StructuredOutput` tool with retry control. This is not documented as the Go model endpoint's equivalent capability. Importing another runtime would require separate integration and receipt accounting; not selected for this fix.

## Evidence correction

Task `maxBudget` values are shared-pool ceilings, not independent allocations guaranteed to be spent. Their sum is not the existing program's budget admission rule. Correct the previous report: the saved candidate's $0.37 cap sum alone is not a $0.25 authorization violation. Reuse the actual estimated-total check; do not introduce a new sum-of-caps gate. The same raw result also has missing acceptance mappings/test minimum counts and an output task without write permission.

## Constraints and review focus

- No real model call, production deployment, permission expansion, unknown-fee change, or automatic repair/retry.
- No invalid input is saved, including a handoff-only error whose other checks all pass.
- Malformed tasks/teams/unknown existing-team identities cannot reach typed semantic checks.
- Valid candidates and existing-team flows preserve original behavior.
- Diagnostic text is bounded for the current 4000-character feedback input; never include raw candidate content.
- Actual budget-estimate overflow remains an error; summed task ceilings alone do not become an error.

## Task 1 — failure feedback and generation guidance

Files: `apps/api/src/organization-draft-diagnostics.ts`, `organization-chat.ts`, `organization-task-planning.ts`; tests in `tests/organization-draft-diagnostics.test.ts`, `organization-task-planning.test.ts`, `orchestration-pattern-integration.test.ts`.

- [x] Add RED tests using the unchanged real failed response: handoff error, writer error and acceptance errors arrive together; raw hash and save counts unchanged; one request only; next turn carries feedback through existing input.
- [x] Implement a pure string-diagnostic helper using original schemas minus handoff only for analysis. Extract shared task-contract checks from the route, preserve normal validation. Bound feedback text to its existing input contract.
- [x] Reuse the office write-permission sentence in terminal planning; clarify handoff contains only sections and financial/Token fields remain at task level. Leave output envelope, output limit and provider protocol unchanged.
- [x] Verify malformed inputs safely stop analysis; new/legacy/valid/existing-team and real-budget cases are covered.

## Task 2 — verify and record

- [x] Run related unit/API tests, typecheck/build; use original raw responses for local replay only, never claim new model success.
- [x] Run related checks on JJ in a fresh isolated directory, without production configuration or credentials.
- [x] Focused independent review; correct duplicate diagnostics and verify RED/GREEN. Record evidence and unresolved real-model quality.
- [x] Prepare exact-file integration on the existing authorized branch; final commit/push outcome is recorded in the session ledger and user reply.

Results: Windows and JJ each 85 unit + 44 API; Windows typecheck/build passed. Zero new paid calls. See [validation report](../../validation/organization-draft-feedback-2026-10-19.md).
