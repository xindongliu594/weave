# Endurance and Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user approved inline work in chat.

**Goal:** 验证至少 30 分钟真实沙箱文件/测试/恢复，交付网页保留建议及证据。
**Architecture:** 专用仪器调用现有 OpenShell 执行器；耐久运行和生产数据隔离。保留建议只是只读投影，全部维护继续复用已验证确认链。
**Tech Stack:** Node 标准库、OpenShell 0.1.2、既有 Express/React/PGlite。
**Spec:** docs/superpowers/specs/2026-10-11-endurance-retention-design.md

## Global Constraints

- 不安装依赖、不调用付费模型/员工、不修改原数据或预算。保留所有旧发布与凭据。
- 实测至少 1800000 ms；每轮间隔约 30 秒，原测试命令每次有独立仪器授权/收据。
- 固定 1 CPU/512 MiB/无网络，单条命令仍沿用 60 秒和输出/目录门禁。
- 中途只在已完成且持久保存的边界重开进程，未知绝不重试。
- 完成日志 24 h，完成副本/沙箱 7 d 为建议门槛，实际维护仍需全部原保护和确认。

## Review Focus

- 断电在 started 与 receipt 之间时，恢复不能把未知命令当成未发送。
- 仪器文件必须标识，不能掺入员工来源或改写员工原文件。
- 30 分钟必须是实际经过时间，短测试/模拟时钟不算。
- 建议不能提升权限或绕过原费用、版本、活动、未知门禁。
- 未来/无效时间、失败和未知运行不得成为建议清单；列表必须有界。

### Task 1: 可恢复的隔离耐久脚本

**Files:** scripts/validation/sandbox-endurance.cjs、sandbox-endurance.test.cjs。
**Interfaces:** checkpoint has runId/grant/sandbox/revision, startedOperation or completed round; validateCheckpoint refuses in-flight or failed state. Script controller launches two worker processes with persisted checkpoint and enforces 30 real minutes.
- [x] RED: 未知/失败/来源变化拒绝；原文件不变；真实 elapsed >= duration 的判定。
- [x] GREEN: 最小脚本，预检后在 JJ 启动一次 30 分钟探针，输出增量证据。
- [x] 提交脚本与本任务检查结果。

### Task 2: 网页保留建议

**Files:** services/agent-runtime/storage-retention.mjs/.d.mts/.test.mjs；apps/api/src/storage-governance.ts；apps/web/src/StorageCenter.tsx；tests/storage-governance.test.ts / storage-center.test.ts。
**Interfaces:** retentionAdvice(runs,now) returns fixed policy plus bounded recommendations; GET /storage/retention exposes safe runId/kind/age recommendation with no provider/executor mutation. UI recommendation buttons call existing kind previews.
- [x] RED: 完成且足龄建议；未来/坏日期/未知费用/失败保护；重复读取不改变清理表；UI 显示手动确认和保护规则。
- [x] GREEN: 复用原预览/确认和只读分类，不增加自动清理。
- [x] 相关回归、类型、构建，保存结果并提交。

### Task 3: 实测、部署和交付

**Files:** docs/storage-governance.md、README.md、本轮验收报告和 evidence。
- [x] 独立最终审查，重要问题一轮 RED→GREEN 修复。
- [x] 耐久实测通过或明确记录失败/受阻，不盲目重试。
- [x] JJ 部署建议入口，网页短验，项目/用量/原文件哈希一致。
- [x] 记录实测增长与限制，提交并推送当前分支。

结果和版本边界见 [验收报告](../../validation/endurance-retention-2026-10-11.md)。物理探针运行启动时版本；本轮计时修复的回归与独立 systemd 时长证据均单独记录，没有在运行中覆盖脚本。
