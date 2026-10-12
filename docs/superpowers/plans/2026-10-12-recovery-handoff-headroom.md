# 恢复规划交接余量修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** 修复恢复规划没有为已有的一次交接纠正机制计入调用及费用余量的问题，先用本地测试验证，再单独安排真实验收。

**Architecture:** 复用现有资源候选、审批、预算历史、DSH `agent_teams_update_task` 和 `agent/turn-stopping` 提醒。资源下界属于宿主校验，AI 在用户允许上限内分配实际额度；下界只是有界续跑余量，不是完成保证。

**Tech Stack:** 现有 TypeScript、Zod、Node test、DSH；无新增依赖。

**Spec:** ../../validation/reuse-publication-continuation-2026-10-12.md，尤其是最后一次 QA 文字结束、提醒已产生但下一请求被次数门禁拒绝的记录。

## Global Constraints

- 本计划是当前故障修复，不替换运行架构；先检查现有能力、复用现有工具和接口。
- 真实调用目前停止。原“一次修复后续验”已执行完；本计划不授权下一次付费规划或执行。
- 原批准累计 $2.60、阶段 $0.52、库存 $0.30、后续项目 $0.09、库存总64/节点最多40次保持；AI实际节点额度仍需独立批准，不能直接把允许边界写成生效额度。
- 已用次数、费用、未知预留、完成节点、文件版本、权限和目标保持；不能手工生成员工报告、交接收据或知识候选。
- 本地协议夹具只证明程序行为，不能替代真实 QA 和经理验收。

## Review Focus

- 已完成节点不参与新调用余量分配，额度和交付不改动。
- 未完成节点只剩0或1次时，不能声称可以覆盖工作与一次交接纠正。
- 节点分别有余量但项目总次数不足时，应在付费规划前拒绝。
- 提案生成后历史计数变化时，确认恢复仍须重新检查；旧候选不能绕过下界。
- 保留旧批准资源边的历史验证，避免新规则使原档案不能读取或恢复。

### Task 1: 统一恢复调用和费用下界

**Files:** Modify `apps/api/src/recovery-resource-plan.ts`, `apps/api/src/recovery-resource-router.ts`; Test `tests/recovery-resource-plan.test.ts`。

**Interfaces:** 在现有资源模块增加 `recoveryCallRequirements(snapshot, history, completedTaskIds, callCeilings)` 纯函数，返回未完成节点的 `workRequests`、`handoffCorrectionRequests`、`minimumCallLimit`、`nextRequestCount` 与 `minimumTotalCalls`。路由的校验、提示和费用下界使用同一结果。

- [x] RED：历史总48，QA已用32/原上限32、经理已用0/原上限32，允许总64/节点40；QA下一段6次工作加1次纠正，累计至少39；两节点下一段共14次，项目累计至少62。已完成开发保持不变。
- [x] RED：未完成节点剩2次时分配1次工作+1次纠正；剩1次时返回 `RESOURCE_CALLS_INSUFFICIENT`；两个节点各需7次但总计只剩13次时同样拒绝。
- [x] GREEN：保留原最多6次工作段，每个未完成节点额外计1次现有交接纠正；工作段为 `min(6, 节点可用次数 - 1)`，不足1则拒绝。节点累计下界不低于原上限；项目下界不低于原上限和历史总次数加各下一段总和。
- [x] GREEN：用完整 `nextRequestCount` 计算现有 `recoveryTaskMinimumBudget`；提示明确区分工作、纠正、已用、允许边界和实际分配，禁止把余量视为完成预测。
- [x] 校验确认入口的实时次数/费用；为新候选记录规则版本。仅新候选应用新下界，历史资源边继续原规则验证，原档案不重写。
- [x] 使用 `scripts/test-integration.mjs` 跑恢复 API（避免普通命令跳过隔离用例）；纯函数18/18，恢复API22/22，费用11/11，来源10/10。

### Task 2: 本地验证正式交接与停止边界

**Files:** Modify `services/agent-runtime/employee-handoff-reminder.test.mjs`, `services/agent-runtime/product-concurrency.test.mjs` only as needed; update validation report and scoped evidence。

**Interfaces:** 继续使用现有 `EmployeeHostFactory`、任务编号映射、正式任务更新、`HandoffGate` 与模型准入门禁，不另建 Agent 循环。

- [x] 验证一次文字结束后提醒，同一任务尝试通过真实原生工具提交交接，才允许下游继续；失败结论不能作为通过。
- [x] 验证同尝试冷恢复不重复提醒、不同尝试不误用旧提醒；已完成、取消和无活动任务的提醒行为有明确断言。
- [x] 验证提醒后仍无交接时停止新模型准入；协调会话不能补写交付或代替员工验收。
- [x] 原生8个相关文件58/58；包括上述两文件及 status-lifecycle 等原回归。
- [x] Run `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/vite/bin/vite.js build`；仅在新增变化或失败需要时扩大回归。
- [x] 保存 RED/GREEN、独立审查结论与精确改动清单；通过后部署新 JJ 版本，核对原数据、文件哈希和计数不变。该部署不产生模型调用。
- [x] 精确暂存本轮代码和证据，按已有授权提交并推送当前分支；修复提交 `cfd2e4d`。

## 真实验收后续安排

- [ ] 本地验证完成后核对实时余额、节点计数和完整请求预留，给出具体的有限续验方案。原一次续验授权已用完，取得下一次真实续验授权后才调用规划模型。
- [ ] 在原库存项目仅续跑 QA→经理；已完成开发不重跑。若仍不足或失败，停止并保存实际证据。
- [ ] 第三个不同工作正式通过后，才验证经验候选审核发布和新员工实际选用；没有通过则这两项继续标为未验证。

## 当前状态

2026-10-13：代码和本地验证已完成并部署JJ，证据见 ../../validation/recovery-handoff-headroom-2026-10-13.md；尚未追加付费调用。当前QA38/38保持原历史状态；按原64/40允许边界只读核算，项目下一段最低累计预留$0.408798，高于现有$0.30。新的有限续验预算提案已保存，待用户确认。
