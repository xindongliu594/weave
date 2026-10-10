# Goal check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将批准目标独立固定，在执行、交接、恢复及网页中使用同一合同。
**Architecture:** 共享纯函数生成和校验快照封印，运行宿主保存独立副本。节点语义验收沿用真实命令及独立审查。
**Tech Stack:** Node/TypeScript、React、DSH AgentTeams、现有数据库 JSON 快照。
**Spec:** docs/superpowers/specs/2026-10-10-goal-check-design.md

## Global Constraints

- 无新依赖、无每回合目标评判模型、无预算提高；历史运行和未知费用保留。
- 恢复、知识资料及压缩不能修改批准合同；合法返工不能降低原验收。
- 本地替身不是模型验收；网页不得把完整性校验显示为交付已通过。

## Review Focus

- 恢复行与原档案封印不一致：拒绝创建后续运行。
- 原合同嵌套字段或 seal 被改写：停止新准入，保留原始原因。
- 合法返工：原验收仍注入而不拒绝已授权修复。
- 无封印历史项目：继续既有规则，明确未启用。
- 网页终态与历史阶段记录：未检查不误显示通过。

### Task 1: 合同封印与执行门禁

**Files:** packages/contracts/goal-contract.mjs；services/agent-runtime/goal-guard.mjs；host.mjs；product-runtime.mjs；tests/goal-contract.test.ts；services/agent-runtime/goal-guard.test.mjs。
**Interfaces:** createGoalContract(snapshot) → seal；assertGoalContract(snapshot, expected?) → boolean；GoalGuard.check(point, taskId?)；GoalGuard.context(taskId?)。
- [ ] 写测试：嵌套验收、目标、权限变更被拒绝；费用历史与恢复上下文改变允许；知识注入不替换目标；旧合同兼容。
- [ ] 运行 Node/tsx 单文件测试；Expected: 缺少模块失败。
- [ ] 实现纯函数及宿主的每请求/工具/交接门禁和原目标上下文；复用 HandoffGate 的真实证据。
- [ ] 运行上述测试及受影响宿主/返工/监督器测试；Expected: 全部通过。

### Task 2: 批准及恢复

**Files:** apps/api/src/app.ts；run-management.ts；recovery-conditions.ts；tests/recovery-conditions.test.ts。
**Interfaces:** 消费 Task 1 两个共享函数；新批准快照包含 goalContract；恢复检查与 POST 使用同一校验。
- [ ] 隔离数据库测试：已封印运行的目标被改写或档案 seal 不同，预检及实际恢复均 409、没有子运行或模型请求。
- [ ] 运行隔离恢复测试；Expected: 新测试失败。
- [ ] 在批准时封印；恢复及预检校验行和档案；API summary 保留 goal/* 事件。
- [ ] 运行隔离恢复、批准及相关回归；Expected: 全部通过。

### Task 3: 网页、验证与交付

**Files:** apps/web/src/RunGoalChecks.tsx；RunExtras.tsx；tests/run-goal-checks.test.ts；docs/validation/goal-check-2026-10-10.md。
**Interfaces:** 消费 snapshot.goalContract、原 tasks 及 goal/*/handoff 事件。
- [ ] UI 测试：legacy、待检查、完整性正常而交付未验收、已封印异常四种状态区分；Expected: 新组件缺失失败。
- [ ] 实现目标/验收映射和暂停原因显示；Expected: UI 测试通过。
- [ ] 类型检查、构建、运行项目测试命令及相关运行回归；Expected: 变更检查通过，基础环境失败按名称记录。
- [ ] 最后一次独立全变更审查；修复重要问题并复跑相应回归。
- [ ] 部署 JJ；网页验证；最新费用检查后尝试原授权内的小任务正常及恢复路径；真实阻塞明确记录。
- [ ] 验收证据和限制保存后按既有授权本地提交、推送当前分支。
