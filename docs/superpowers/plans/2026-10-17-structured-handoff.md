# Structured employee handoff implementation plan

> **For agentic workers:** Use executing-plans inline, TDD, then one independent review.

**Goal:** Remove nested JSON authoring from employee handoff without replacing DSH or weakening native completion gates.

**Architecture:** Extend the employee-visible agent_teams_update_task with optional structured `report`. Validate with installed Zod, serialize to native output only at the employee/coordinator boundary. Keep native identity, attempts, evidence, persistence, budgets and recovery authoritative.

**Tech Stack:** Existing Node ESM, DSH 0.1.5-rc.1, AgentTeams 0.1.20, Zod 4.1.5.

**Spec:** User-approved design in preceding conversation: structured report, actionable errors, bounded correction, no repeated file/test operations. This document records that approved design and its implementation steps.

## Research / reuse

- Local DSH agent-loop parseArguments preserves invalid JSON as a string; tools then emits INVALID_ARGS/object. Native update_task.output is a string. Use the existing plugin and adapter boundary, not a second scheduler.
- [Pydantic AI tool retries](https://pydantic.dev/docs/ai/tools-toolsets/tools-advanced/#tool-execution-retries-and-failures): validation feedback and bounded correction are the reference pattern, not a new Python service.
- [AI SDK](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling): schema-driven tools and repair; repair remains experimental. Do not install another model transport.
- [LangGraph Supervisor](https://github.com/langchain-ai/langgraph-supervisor-py): maintainers recommend tool-based supervisor pattern for most cases. Preserve existing AgentTeams orchestration.
- [Zod](https://zod.dev/error-formatting): reuse installed validation, expose field paths without values.
- [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams): upstream advertises 0.1.23; upgrading is separate compatibility work, not evidence it fixes this defect.

## Global constraints

- No new dependencies, model calls, budget increases or permission changes for local regression.
- Old string output remains accepted; report and output together must be rejected as ambiguous.
- Report validation does not prove test success; native gate still validates real files/commands/current attempt.
- No raw report values in errors; no auto repair of malformed JSON; no replay of mutations.
- Keep existing repeatErrorLimit (default 3), total request and dollar limits. Normalize format-error identity so changing field/position cannot evade consecutive-error stopping.

## Review focus

1. Legacy and new report both present: reject before forwarding.
2. Invalid/missing/extra fields: precise safe field paths, no private values echoed.
3. Quotes, backslashes and Unicode: round trip exactly once to native output.
4. Stale attempt or missing file/test evidence: native gate still refuses completion.
5. Differing syntax/field errors: stop within original retry limit, no extra calls.

## Task 1: employee report boundary

Files: packages/contracts/handoff-report.mjs; services/agent-runtime/employee-hosts.mjs; new services/agent-runtime/employee-handoff.mjs; employee-handoff-reminder.test.mjs; manager-handoff.test.mjs.

- [x] Add failing native fixture for schema publication, report-only submission serialized once, conflicting output rejected, bad report fields not forwarded, legacy output preserved.
- [x] Implement reusable strict report schema and bounded field diagnostics; employee definition gets optional report, serialization stays in the forwarding path. Update instructions to prefer report.
- [x] Extend real native HandoffGate fixture to cover structured submission, unchanged source report, missing section/evidence and stale attempt rejection; preserve old checkpoints.
- [x] Run targeted tests and inspect output. Fixtures are protocol verification, not real model acceptance.

## Task 2: bounded correction and verification

Files: supervisor.mjs; supervisor.test.mjs; docs/validation/structured-handoff-2026-10-17.md.

- [x] Add failing regression for different format positions/fields across three errors.
- [x] Normalize only handoff-format INVALID_ARGS family for consecutive-error counting; retain original detailed messages in trace.
- [x] Run related runtime tests, contract/API regression, typecheck/build; independent review.
- [x] Deploy only after JJ preflight and historical hash verification; verify on Linux before switching. Preserve failed run and artifacts.
- [x] Audit remaining real-run resources before any true-model continuation. Do not consume the last developer call blindly. Record deployment/real acceptance separately.
- [x] Commit/push only scoped files under standing user authorization.
