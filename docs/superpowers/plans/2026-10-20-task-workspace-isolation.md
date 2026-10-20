# Task Workspace Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 员工任务在独立 OpenShell 沙箱工作，可信服务验证并提交产物，其他成果不暴露为可写目录。

**Architecture:** 复用 OpenShell 0.1.2、现有文件路径/大小校验和 DSH 工具 guard。task scope 固定输入来源和输出合同，私有工作副本只导入授权文件；发布用有界 delta 和 CAS，而非整个 task 副本替换项目。

**Tech Stack:** CommonJS shared executor helpers, ESM runtime, TypeScript contracts, OpenShell CLI。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`; `docs/research/enterprise-execution-boundaries-2026-10-20.md`。

## Global Constraints

- 不改变生产，不调用模型，不放宽现有权限和额度。
- 复用 `apps/desktop/local-executor.cjs` 的 validPath/decodeFiles/manifest/revision，不复制改良另一套路径校验。
- scope 只由可信服务从批准任务创建；纯函数不证明 caller 已授权，也不是 OS 沙箱。
- task 导出缺少文件不表示删除；首版禁止删除受管输入或原有输出。
- 合并必须保留未授权/未涉及文件；冲突零发布；不移除现有全局锁。
- 后续企业执行必须 OpenShell task 隔离，不静默降级 native/shared run。

## Review Focus

- 非规范路径、大小写重复、前缀冲突与伪造 sha 必须全部拒绝。
- 只读输入被修改/删除，以及额外输出文件，不得发布任何文件。
- 两员工同时修改同一输出的旧基线必须冲突；无关路径变化可保守拒绝。
- 输入来源、scope 身份或 backend/hash 变化必须使旧回执无效。
- 一部分合并后崩溃不能误报完整提交；此模块只产生计划，持久 commit 由后续实现。

### Task 1: Shared task workspace contract and merge planner

**Files:** create `apps/desktop/task-workspace.cjs`, `packages/contracts/task-workspace.ts`, `tests/task-workspace.test.mjs` only.

**Interfaces:**
- CJS functions `createTaskWorkspace({binding,readPaths,writePaths,canonicalFiles,origins})`, `validateTaskExport(workspace,exportedFiles)`, `planTaskMerge(workspace,exportedFiles,currentCanonicalFiles)`.
- `binding` contains nonempty `projectId`, `planVersion` positive integer, `runId`, `taskId`, `attemptId`, `assigneeId`, `generation` positive integer, `contractHash`, `permissionHash`, and `backend:{kind:'openshell',version:'0.1.2',image,policyHash}`. Hashes lowercase SHA256; all identity/path/size limits validated. No unknown schema/profile accepted.
- File arrays use existing `{path,content:base64}`. `origins` is exact per-readPath provenance `{path,runId,taskId,attemptId,acceptedRevision,checkpointId?}` with nonempty identity/hash fields. Inputs require a real baseline file and origin. Outputs already present may be imported only if also an authorized readPath with origin. New outputs need no origin, baseline `null`.
- Workspace result has profile `weiwu-task-workspace-v1`, binding, readPaths, writePaths, importedFiles, inputManifest with origins, baseline output hashes, base canonical revision and SHA256 scopeHash. All arrays canonical sorted; preserve existing file hash semantics. Revalidate whole workspace before using it; malformed/tampered object rejects.
- `validateTaskExport` validates full exported array before producing `{path,beforeSha256,afterSha256,size,content}` changes. Imported non-writable files must remain byte-identical. Missing imported files, undeclared paths, file limits or invalid hashes reject. Only declared output paths may differ. Empty delta valid only if no contractual output assertion made (completion handled by handoff).
- `planTaskMerge` verifies current canonical revision equals base revision (conservative v1), every target baseline unchanged, then returns complete mergedFiles, beforeRevision, afterRevision, scopeHash and delta. Output arrays include all untouched canonical files. This is a pure plan; no filesystem mutation or receipt creation.
- Types mirror exported runtime contracts; no production integration in this first task.

- [ ] Write failing tests for canonical order stability, disjoint outputs preserved, changed unrelated revision conflict, changed/deleted read-only input, missing/extra origin, mutated scope/binding/basehash, bad path/case/prefix, file limits and baseline output visibility.
- [ ] Run `node --test tests/task-workspace.test.mjs` to confirm failures then implement with existing helpers.
- [ ] Run task tests and existing local executor/path tests as relevant; `npx tsc --noEmit`.
- [ ] Independent review and scoped commit. Clearly state helper-only status; B2 remains unimplemented.

### Task 2: Trusted persistent commit and executor integration

- [ ] Expand detailed task after Task 1 interfaces stabilize. Add immutable blobs/merge intent/committed revision receipt and crash reconciliation; do not rely on multi-file rename being atomic.
- [ ] OpenShell task attempt create/admit/import/exec/export/stop lifecycle using pinned CLI; fixed transport preflight below verified 4 MiB stdin or verified bounded chunking.
- [ ] Thread scope into local-operation queue, result validation and canonical mirror; never feed partial task files directly to mirrorFiles.
- [ ] Use DSH guard for dynamically registered tools; old native/shared task execution explicitly unsupported under enterprise profile.

### Task 3: Recovery and actual adversarial validation

- [ ] Bind scope to checkpoint, parent/recovery evidence and current permissions. Legacy checkpoint cannot be upgraded by relabelling.
- [ ] Real OpenShell tests attempt sibling writes, traversal, link/device access, child processes and unauthorized network; verify canonical bytes unchanged.
- [ ] Inject crashes at intent/blob/revision/receipt boundaries and verify no replay; verify service restart and completed work preservation.
