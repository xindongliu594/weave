# Enterprise Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 复用 Promptfoo 提供版本固定、证据关联、区分模拟与真实业务的发布评测。

**Architecture:** Promptfoo 独立工具目录和 lock，不进入生产服务依赖。薄 JS provider 接为伍证据；数据集、标准、源码、锁文件和报告关联。真实执行后续接服务端授权，不能把可编辑配置当成预算批准。

**Tech Stack:** Promptfoo, Node.js, JSON datasets and manifests, existing trace evidence.

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`; `docs/research/enterprise-quality-operations-2026-10-20.md`。

## Global Constraints

- 不调用真实模型、不触碰生产、不加载本地 LLM、不改已有预算。
- 默认 replay。第一任务 execute 模式无条件拒绝，直到企业服务端授权接入；不存在环境变量跳过。
- 只安装精确验证的 Promptfoo 版本到 `tools/evaluations`，不改根 dependency lock。
- 不使用云 provider、LLM judge、遥测、分享上传或真实 credentials；输出不含原始用户对话。
- fixture/已存在运行不能计为新真实运行，不能宣称模型质量已验收。

## Review Focus

- 报告/数据/规则 hash 不符、遗漏样本和空报告必须失败。
- fixture 改标签成 live、旧运行标 fresh 都拒绝。
- NaN/Infinity、错误/blocked/skipped/未知费用不可被平均分掩盖。
- 配置企图加载云 provider、函数式付费断言或任意外部资源，必须在 runner 启动前拒绝。
- Promptfoo 无法运行或返回非零、证据缺失时，不可产出 pass gate。

### Task 1: Offline Promptfoo bridge and versioned gate

**Files:** own `tools/evaluations/**`, `tests/evaluation-bridge.test.mjs`, `tests/evaluation-release-gate.test.mjs`. No root lock, workflow or production edits in first task.

**Interfaces:**
- `WeiwuProvider` standard `id()` / `callApi(prompt,context)` JS provider. Replay reads only bounded local fixture paths under datasets root; exact case/version and digest validated. `execute` throws `LIVE_AUTHORIZATION_REQUIRED` before any HTTP request. No transport/request mutation in this module.
- Fixed synthetic dataset v1 includes successful delivery, missing QA, stale artifact digest, unknown operation and recovered-run duplicate action cases. Expected outputs express actual evidence invariants, not superficial prose. At least five cases.
- `report-manifest.mjs` binds evaluation ID/date, source commit+dirty/root/runtime/evaluator lock digests, dataset ID/version/digest/case IDs, criteria version/digest, executionKind='fixture', modelExecuted=false, Promptfoo raw result digest and normalized case results. Use explicit schema validation and bounded file reads.
- `release-gate.mjs` CLI/function checks expected source/dataset/criteria digests and required cases, unique cases, actual normalized pass/error/blocked/skipped, finite scores, evidence completeness and executionKind. `requireLive=true` must fail with `live-evidence-required`. Offline pass only means local engineering invariants passed.
- `run.mjs` generates controlled Promptfoo config with this one provider and deterministic assertions; no user-supplied arbitrary Promptfoo providers/assertions. Disable telemetry/share/network judge. Pin installed version and record it. Emit private JSON/JUnit/HTML and manifest into explicit ignored output dir, not checked-in temp results.
- Package versions: verify official release/npm metadata during implementation, pin exact compatible version with integrity lock, `npm install --ignore-scripts`; record dependency size/compatibility and license without reporting nonexistent audited guarantees.

- [ ] Write failing bridge/gate tests covering mutation/empty/omitted/duplicate cases, false-live, bad score, missing receipt/evidence, unsafe path and execute rejection with zero requests.
- [ ] Install selected runner in isolated directory and build minimal adapter (do not implement a parallel scoring engine).
- [ ] Run real Promptfoo CLI on controlled fixture dataset and verify report+manifest+nonzero failure behavior. This proves tool integration, not cloud model quality.
- [ ] Run `node --test tests/evaluation-bridge.test.mjs tests/evaluation-release-gate.test.mjs` and capture compact output.
- [ ] Independent review and scoped commit, list live/API/CI integration still outstanding.

### Task 2: Authorized product API execution and CI

- [ ] Expand precise brief after identity/authorization integration. Server-issued batch binds exact project/version/cost/call cap/expiry and evaluator principal; no arbitrary JSON authorization.
- [ ] Implement only verified API `/cost-readiness`, `/approve`, run/events/export/artifacts; stable idempotency, no retry unknown mutations or automatic approvals.
- [ ] Add isolated CI job with sanitized artifacts; live reports require real request/usage/tool/test evidence.
- [ ] Within available explicit budget run one real small case and compare fixed baseline. Mark any missing permission/budget/external requirement, never auto-spend.
