# 节点内部检查点 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 DAG 恢复之上，让员工沿用已可靠保存且仍有效的节点内部结果，并支持受控的分支派生。

**Architecture:** 复用已安装 DSH 会话、checkpoint policy、AgentTeams 和现有费用/权限/交接机制。新增产品侧边界清单与继承证据；文件恢复和分支使用隔离目录，保留原日志，不引入第二套调度器。

**Tech Stack:** 现有 Node.js/ESM、TypeScript、React、PostgreSQL、DSH 和 OpenShell；不新增 LLM 服务或大型本地模型。

**Spec:** [复用调研与接入边界](../../research/step-checkpoints-2026-10-19.md)。状态：待实施设计；本轮仅调研、计划和既有本地回归。

## Global Constraints

- 固定 `@deepseek-ai/dsh-session-checkpoint-policy` `0.1.5-rc.1`、`@nanmicoder/dsh-agent-teams` `0.1.20`；不升级依赖实现本功能。
- 已完成节点不重复执行；未完成节点仍需员工交接、独立 QA 和经理验收。
- 费用/调用次数/未知预留累计不回退；沿用现有授权，不在计划中分配新付费额度。
- 不修改旧运行、用户文件、权限或凭据；无明确完整回执的外部操作不自动重放。
- 保存检查点不调用模型；历史知识正文仍走当前授权，不以恢复摘要扩大资料访问。
- 分支工作区隔离；新增 DAG 合同仍走现有确认流程。

## Review Focus

1. 工具成功后、回执提交前崩溃：必须 unknown，不能显示成功或自动重放（任务 1、2）。
2. 文件相同但依赖/环境/权限/测试方法变化：不能继承测试通过（任务 3）。
3. 并行工具写文件、旧 worker 迟到提交：不能封存混合状态或覆盖新版本（任务 1、2）。
4. 新 attempt 错用旧团队身份或审批：保留来源但重新绑定当前身份与授权（任务 2、3）。
5. 配额、损坏/缺失内容、清理与分支引用冲突：阻止不完整恢复，保留被引用内容（任务 1、4、5）。

## Task 1：文件版本与边界清单

**Files:** 新增 `services/agent-runtime/step-checkpoints.mjs`、`.d.mts`、`.test.mjs`；复用 `trace-store.mjs`、`sandbox.mjs`、`archive-storage.mjs`。

**Interfaces:** `commitStepCheckpoint({ archive, boundary, files, receipts }) -> CheckpointRef`；`readStepCheckpoint({ root, checkpointId }) -> VerifiedCheckpoint`。boundary 固定包含 version/runId/taskId/attemptId/sessionId/parentId/trigger/eventCursor/contractHash；files 为允许路径及内容哈希引用，receipts 为可信归档引用。检查点含 committed 标记，read 拒绝未提交/缺失/篡改内容。

- [ ] 先写失败测试：中途写失败不可恢复、同内容去重、路径越界/符号链接/超限拒绝、被引用文件不可清理。
- [ ] 运行 `node --test services/agent-runtime/step-checkpoints.test.mjs`，确认上述行为尚未实现。
- [ ] 采用“先写内容、最后提交清单”；使用已有路径和配额校验，不能把有限交付文件枚举当作完整工作区快照。
- [ ] 重跑上述测试及 `node --test services/agent-runtime/trace-append-cursor.test.mjs services/agent-runtime/archive-storage.test.mjs`。
- [ ] 只提交本任务明确文件。

## Task 2：接入原生工具与循环边界

**Files:** `employee-hosts.mjs`、`host.mjs`、`supervisor.mjs`、`checkpoint-context.mjs`；新增 `step-checkpoint-boundaries.test.mjs`。

**Interfaces:** 消费 Task 1；生成跨 attempt/分支保持稳定的逻辑操作身份、源事件游标和 nextAction 状态。同一操作恢复时查询最新权威账本，不将 checkpoint 内的旧操作状态当作当前状态。继续用原生 session flush，不另造 session 格式。新 attempt 仅接收重新绑定后的合法恢复上下文。

- [ ] 先写失败测试：高成本结果完成后立即持久化；循环完成后停机可读；并行工具未收束不能提交；迟到旧 worker 被拒绝；嵌套工具缺少独立回执不能假定安全复用。
- [ ] 运行 `node --test services/agent-runtime/step-checkpoint-boundaries.test.mjs` 确认 RED。
- [ ] 在既有事件边界关联文件清单/回执，用现有工作区锁或版本核验形成一致边界。保留 native attempt 生命周期，不把旧 session 的任务身份直接赋给新成员。
- [ ] 测试“派发前/派发后未知/结果已提交”三种中断，核对未知状态和实际工具调用计数。
- [ ] 重跑边界测试及 `employee-checkpoint-policy.test.mjs`、`checkpoint-context.test.mjs`、`supervisor.test.mjs`，只提交本任务文件。

## Task 3：受约束的结果与测试证据继承

**Files:** `handoff.mjs`、`run-evidence.mjs`、`apps/api/src/handoff-checkpoints.ts`、`run-management.ts`、相应声明/合同；新增 `services/agent-runtime/inherited-step-evidence.test.mjs` 及扩展 `tests/handoff-checkpoints.test.ts`。

**Interfaces:** `validateInheritedEvidence({ checkpoint, contract, principal, environment, files }) -> { reusable, reasons, evidenceRefs }`，置于 `step-checkpoints.mjs`；证据引用含源 run/task/attempt/receiptId。绝不改写历史为当前 attempt 的新执行。

- [ ] 先写失败测试：封闭本地测试通过后中断，恢复只继续分析与交接，命令执行计数仍为 1；文件、测试、镜像/依赖、合同或权限任一变化拒绝继承；网络测试、未知工具默认拒绝。
- [ ] 运行 `node --test services/agent-runtime/inherited-step-evidence.test.mjs` 确认 RED。
- [ ] 将目前“所有旧命令不可用于新 attempt 验收”细化为显式继承规则。只对依赖可核验的工具开放；其他命令保持原验证策略。QA 和经理仍须独立判断，不自动签收。
- [ ] 运行上述测试与 `node --import tsx --test tests/handoff-checkpoints.test.ts`；断言旧费用/调用数保留，复用本身无新增工具计费，不声称恢复后的模型调用免费。
- [ ] 提交；此任务完成后先做一例“测试结束、报告未提交”的真实小任务验收，再进入分支工作。当前计划没有自动批准新真实调用。

## Task 4：已批准路径的分支派生

**Files:** `step-checkpoints.mjs`、`checkpoint-team.mjs`、`apps/api/src/run-management.ts`；新增 `tests/checkpoint-branch.test.ts`。

**Interfaces:** 分支输入 `{ sourceRunId, checkpointId, approvedPathId }`；输出新 run/branch ID 与 parentCheckpointId。只允许已批准路径，默认串行试另一条路径，不在第一版增加并行搜索引擎。

- [ ] 先写失败测试：A 失败后从共同点开 B，原历史/费用不变；其他员工文件不被回滚；依赖被改变的后继验收失效；检查点之后 A 已产生的外部成功/未知操作仍可在最新账本查到且不重放；未批准路径拒绝；会话/文件/回执边界混配拒绝。
- [ ] 运行 `node --import tsx --test tests/checkpoint-branch.test.ts` 确认 RED。
- [ ] 恢复到新的隔离工作目录；沿用现有租约、预算、任务映射和恢复入口。会话派生只使用 DSH 原生合法完成 turn 边界；不支持的边界须重新发布会话游标/文件/回执一致的完整检查点，无法取得一致状态则拒绝，不伪造 native fork。
- [ ] 重跑分支及原节点恢复测试，验证仍是有向无环图，旧分支可审计；只提交本任务文件。

## Task 5：网页、存储治理与故障验收

**Files:** `apps/web/src/RunExtras.tsx`、`RunInheritedEvidence.tsx`、`run-recovery-confirmation.ts`、相应 API 合同；扩展 `storage-retention.mjs` 和测试；新增 `scripts/validation/step-checkpoints/` 及验收报告。

- [ ] 先写界面数据与保留策略测试：展示检查点时间/类型/已保存阶段/沿用或重跑原因；活动分支与交付引用阻止清理；容量不足明确暂停。初期不自动删除原数据。
- [ ] 用上面四类边界执行隔离子进程强制终止和重启；覆盖日志半写、文件篡改、权限撤销、未知操作、并行写入；记录恢复前后调用次数和哈希。
- [ ] 正向例：运行一次本地测试后杀进程，重启后沿用证据完成报告；反向例：改动一个依赖，必须重测；分支例：A 失败后开 B，A 的费用仍在。
- [ ] 运行相关 Node/TypeScript 测试及 `npm run build`，浏览器仅做一次主流程确认。真实模型验证沿用现有 API 与预算规则，和固定替身回归分别列证据。
- [ ] 记录 checkpoint/run/attempt ID、模型与工具实际调用次数、Token/费用、恢复时间、存储增量及文件位置。未验证、失败、受阻分别标明，再更新说明并提交。

## 本轮完成项

- [x] 核对现有实现、固定 DSH 版本与官方资料。
- [x] 确认底层 checkpoint 插件已在用，缺口位于产品侧恢复关联。
- [x] 原生策略本地隔离回归正常权限 7/7 通过；真实调用 0。
- [x] 形成复用优先的分阶段设计与验收方法。
- [ ] 实施以上新增能力。本轮没有改动产品代码或 JJ 服务。
