# Resource resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** 用户明确批准 AI 分配续跑资源后，保留完成节点及预算历史，继续未完成任务。
**Architecture:** 复用模型计费、organization_previews、恢复/交接校验和网页组件。AI 候选只能设置项目预算及未完成节点调用上限；确认后创建带明确资源审批的子运行，保留原任务版本，原目标和权限保持。
**Tech Stack:** Existing TypeScript/React/DSH/PGlite; no new dependency.
**Spec:** ../../validation/goal-check-continuation-budget-2026-10-11.md（用户已确认，累计 $2、项目 $0.18）。

## Global Constraints

- 不覆盖旧运行、凭据、授权或员工文件；不确认未知费用为零。
- AI 分配与执行分离；只复用经宿主核验的完成节点；未知修改操作仍拒绝自动恢复。
- 资源续跑继续计入同一版本全部祖先的费用/预留/调用；不重复累计继承的汇总。
- 真实验证以累计 $2、项目 $0.18 为限；本地测试先验证行为。

## Review Focus

- 旧候选、不同源运行、修改过的目标或版本必须拒绝。
- 原调用与金额不清零；保持同一版本避免重复累计。
- 已完成节点文件或验收被修改时，不能借调整额度跳过。
- 只能调整未完成节点资源；全量重试不能借此绕过。

### Task 1: Resource snapshot and budget lineage

**Files:** apps/api/src/recovery-resource-plan.ts, cost-control.ts, packages/contracts/goal-contract.mjs; tests/recovery-resource-plan.test.ts, recovery-conditions.test.ts.
- [x] RED: resources-only change preserves tasks/grants and old snapshot; invalid bounds rejected; resource revision sealed; actual old/new calls and holds counted once.
- [x] GREEN: strict schema and shared snapshot builder; original version history retained; DB default task limit follows approved run limit.
- [x] Verify pure and isolated recovery tests.

### Task 2: AI candidate and confirmed resume

**Files:** apps/api/src/recovery-resource-router.ts, run-management.ts, app.ts; tests/recovery-conditions.test.ts.
- [x] RED: candidate cannot run; explicit confirm creates one resource-approved child with checkpoints and counters; bad source/goal and completed-task edits refused.
- [x] GREEN: reuse model and preview storage; transaction validates candidate, records resource approval and new seal; files restored through existing code.
- [x] Verify relevant API and runtime suites.

### Task 3: Web, deployment and real continuation

**Files:** apps/web/src/RunResourceResume.tsx, RunExtras.tsx; tests/run-resource-resume.test.ts; validation report.
- [x] RED/GREEN: draft/confirmation/failure states, explicit approval, retained holds and completed-node disclosure.
- [x] Types/build and one fresh independent review.
- [x] Deploy fresh JJ release preserving data; real AI candidate within authorized cap, confirm and run manager only; save actual receipts/tests/files/status.
- [x] Commit/push scoped changes; preserve unrelated data. Blocked work stays explicitly incomplete.

实际结果和限制见 ../../validation/resource-resume-2026-10-11.md；资源版本单独编号，未改语义方案版本。提交步骤在最终阶段执行，未验证项仍在报告注明。
