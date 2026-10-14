# 恢复与 QA 交接链路修复计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在再次付费前修复资源规划协议缺口，联合验证恢复、额度和正式交接。

**Architecture:** 保留现有 Express / Zod / 预算收据 / DSH AgentTeams 与检查点。AI 决定资源分配和质量结论，程序计算预留、验证结构与权限并封存证据，不从文字推断通过。

**Tech Stack:** TypeScript、Zod、现有 completion-protocol、DSH、PGlite 隔离测试。

**Spec:** `docs/validation/recovery-output-real-2026-10-13.md` 与 `recovery-continuity-real-2026-10-13.md`。

## 调研与选择

- 项目已有 `provider.CompletionOptions.response_format`、Chat/Responses 协议转换和 `completeBudgeted` 完整请求估算，无需安装结构化输出框架。
- [DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode/) 要求 `response_format: json_object` 与 JSON 提示；JSON 模式不保证符合业务 Schema。
- [OpenCode Go 官方目录](https://opencode.ai/docs/go/) 列出 `deepseek-v4.1-flash` 的兼容接口。目录不能证明这台中转站实际支持某个参数，真实兼容性仍待验收。
- 不启用仅特定端点支持的 strict/beta，不迁移 API、不自动回退重试。对已知模型启用现有 JSON 模式，其他模型保留原通道并严格验证。
- `recoveryOutputSnapshot`、`recoveryTaskMinimumBudget` 和 `recoveryMinimumProjectBudget` 已具备输出调整后的程序计价；复用它们向 AI 提供常用输出长度的预留，避免让模型自行换算。

## 约束

- 本轮不发付费模型请求；之前的一次有限续验已失败。累计授权仍 $2.80，不增加金额、次数、权限。
- 不修改旧运行、原始数据、未知费用或员工交付；不手工生成 QA/经理结论。
- 本地模拟仅验证软件行为；不能替代真实模型、OpenShell 或网页验收。

## 步骤及验收

- [x] 1. `tests/recovery-conditions.test.ts` 增加 RED：实际请求启用已知 JSON 模式；缺字段、包装、Schema 回显均拒绝，保留用量且不自动重试。
- [x] 2. `apps/api/src/recovery-resource-router.ts` 接上现有格式约束并明确返回实例；诊断保留标准资源字段名、不暴露任意模型正文。
- [x] 3. `recovery-resource-plan.ts` 复用现有输出快照与计价，为常用输出额度生成预留表；覆盖完成节点不变、不可用共享路线和新输出费用。仍由 AI 选择并由旧校验确认，不自动分配或批准。
- [x] 4. 运行隔离 API 资源候选→确认→新快照→运行协议验证，以及 DSH 原生恢复/交接相关回归；独立检查缺失证据、未知操作不盲目重放。
- [x] 5a. 类型检查、构建、独立审查；JJ最终131项通过后发布，525条用量、费用预留及原交付核对不变。证据见 `docs/validation/recovery-qa-chain-2026-10-14.md`。
- [x] 5b. 本轮修复和证据单独提交到 `codex/weiwu-mvp-validation`；先前未提交资料不纳入本提交。推送状态以最终 Git 核对为准。
- [ ] 6. 根据本轮证据准备一次真实验收；需要新的明确付费续验授权后才执行，不把本地成功记成真实成功。

## 审查重点

未知中转站参数被拒绝时无自动付费回退；无效 JSON 不能产生候选；新额度估算不能改旧快照；正式交接必须有真实工具证据；完成开发节点及知识固定版本恢复后不变。

## 审查追加的必要修复

独立纯内存复现发现 `nextRequestCount` 只参与预留估算，运行时继承经理原累计45次，可能借用项目剩余次数发出第8次。这不符合有限续验中经理后续最多7次的约束，真实续验须保持停止。

- [x] 只有显式提供可选 `taskContinuationLimits` 时，将本段授权与实际历史绑定，封存绝对累计上限到现有 `resourceApproval`；复用 GoalContract，不改原任务合同。预留估算 `nextRequestCount` 不自动成为所有用户的次数上限。
- [x] 复用 ExecutionBudget 的同步准入，取原任务上限与封存上限的较小值；普通恢复继承，不能重新加7；恢复检查显示实际有效上限。
- [x] RED/GREEN 覆盖 QA44+4、经理0+7，第8次禁止；经理已用6次时再恢复只余1次；非法字段失败、旧档案兼容。
- [x] 独立审查补齐：后续授权保留完成节点旧门禁；无新授权时先检查剩余再付费；大于7次的显式授权进入累计上下限计算。
- [x] 网页复用现有恢复表单，依据只读检查结果显示未完成节点，支持可选本段次数；未填写保持兼容，候选明确展示后再确认。

Ruling：这是审查发现的现有授权边界缺口，属于本轮调度/恢复修复，追加后才能宣称本地链路可用于该有限真实验收。不会因此提高任何授权。
