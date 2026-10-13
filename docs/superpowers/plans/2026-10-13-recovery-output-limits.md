# 恢复输出额度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** AI 可在用户允许范围内重新分配未完成任务的单次输出额度，网页确认后用于恢复和费用预留。
**Architecture:** 扩展现有资源候选、批准快照和路由，复用 DSH 请求与结算。
**Tech Stack:** TypeScript、Zod、React、现有 DSH，无新依赖。
**Spec:** ../../research/recovery-output-limits-2026-10-13.md

## Global Constraints

- 输出范围 1～32768，8K/16K 为规划候选；累计 $2.72、阶段 $0.64、库存 $0.48、原次数授权保持。
- 不改旧快照、交付、完成节点、知识版本、权限或未知费用。
- 不将本地模型夹具当作真实员工验收。

## Review Focus

- 共享主/备用路由不得扩大其他任务的实际额度。
- 新输出上限必须用于费用预留，不能按旧输出额度通过审批。
- 候选、批准与恢复来源链须包含输出授权，伪造或超额输出拒绝。
- 省略新字段的旧记录与旧恢复链仍可读取。
- 供应商限制或连接失败必须保留错误和收据，不静默截断或重试。

### Task 1: 后端与批准链

**Files:** recovery-resource-plan.ts、recovery-resource-router.ts、tests/recovery-resource-plan.test.ts、tests/recovery-conditions.test.ts、tests/run-lineage-evidence.test.ts。
**Interfaces:** maxTaskOutputTokens 请求/候选授权；taskOutputLimits 逐任务 AI 提案；applyRecoveryResources 应用后返回重新封印快照。
- [x] RED：允许 2048→8192，拒绝未授权/超额/完成节点/共享路由溢出；新预留不足拒绝。
- [x] GREEN：校验、候选、批准、来源链和费用统一使用新输出额度；兼容旧记录。
- [x] 隔离 API 验证生成不启动、确认才应用、真实 wire 参数及旧记录不变。

### Task 2: 网页与交付

**Files:** RunResourceResume.tsx、tests/run-resource-resume.test.ts、执行规划提示、对应验证文档。
**Interfaces:** 允许的输出上限输入、候选前后额度、原额度继续保留提示。
- [x] RED→GREEN：网页输入和逐任务差异；新方案提示按任务选择 8K/16K。
- [x] 相关回归、类型、构建，一次独立审查并修复重要问题。
- [x] JJ 新版本发布；86 项检查和类型通过，原数据保留。
- [ ] 实际网页：SSH 与隧道再次超时，待连接恢复核对。原授权不足以进行 8K 真实续验，提案与未验证状态见验证报告。
- [x] 保存证据、精确文件提交并推送当前分支：eb6596c。

后续授权执行见 `../../validation/recovery-output-real-2026-10-13.md`。发现单次规划预留超额后，使用真实数据只读预演及详细中文上下文回归，压缩重复说明和已完成任务正文；本机/JJ 87 项相关检查通过。唯一实际模型规划返回不合格结构，按授权停止追加；8K 员工、QA 和经理仍未验证。
