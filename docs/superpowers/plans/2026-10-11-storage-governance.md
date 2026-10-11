# 文件与数据治理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 网页展示容量，安全预览和确认回收已完成项目的重复工作区文件，保留恢复及证据。

**Architecture:** 纯文件检查模块提供有界不跟随链接的盘点与重复文件清单；Express 路由以持久预览和数据库锁保护清理。设置页面沿用现有面板。当前文件版本、备份、档案门禁保持。

**Tech Stack:** Node 标准库、TypeScript、React、Express、现有 PostgreSQL/PGlite。

**Spec:** docs/superpowers/specs/2026-10-11-storage-governance-design.md

## Global Constraints

- 不增加依赖，不调用模型；本批默认无自动删除。
- 保留 64 MiB / 1 GiB 档案门禁，256 MiB 可用磁盘门禁；原档案永不清理。
- 只允许已完成本机执行项目的、与不可变交付档案相同的普通工作区副本；30 分钟预览。
- Windows 与 JJ Linux 回归；历史修改、费用、凭证、发布依赖保留。

## Review Focus

- 未完整扫描、目录链接和硬链接应阻止清理并明确说明。
- 活动/失败运行和未知操作不得成为可清理现场。
- 预览后状态或文件变化应整批拒绝，不能先删一部分。
- 确认重复/服务中断不得自动重放删除；核对记录要可重启读取。
- 清理记录备份恢复、正式交付与历史账单完整性不能遗漏。

### Task 1: 文件盘点、候选和磁盘门禁

**Files:** 新建 `services/agent-runtime/storage-governance.mjs` / `.d.mts` / `.test.mjs`；修改 `archive-storage.mjs`、`product-runtime.mjs`。

**Interfaces:** `scanStorage(root,limit=100000)` 返回统计和扫描状态；`workspaceCopyCandidates({traceRoot,workspaceRoot,runs})` 返回清单及保护原因；`validateWorkspaceCopies(options,candidates)` 全量核对；`removeWorkspaceCopies(options,candidates)` 删除普通副本并记录已完成项；`assertStorageHeadroom(root,minFreeBytes?)`。

- [x] 真实临时目录测试先失败：分类、链接/变化、完成/失败、内容一致、证据保留、低磁盘门禁。
- [x] 最小实现，观察测试通过；门禁复用现有执行调用点。

### Task 2: 持久清理 API 和备份

**Files:** 新建 `apps/api/src/storage-governance.ts`、`tests/storage-governance.test.ts`；修改 `app.ts`、`db.ts`、`backup.ts`。

**Interfaces:** GET `/storage` 扩展兼容现有字段；POST `/storage/preview`；POST `/storage/cleanups/:id/confirm`（confirmation=CLEAN_WORKSPACE_COPIES）；GET `/storage/cleanups`；POST `/storage/cleanups/:id/reconcile`。`storage_cleanups` 存储预览和结果，纳入备份。

- [x] 隔离 PGlite + 真实文件测试先失败：清理/保护/过期/重复/变化/重启/中断核对/备份恢复。
- [x] 持久预览、表锁及结果核对实现，观察通过。重复确认只读取最终结果；未知中断需要显式核对。

### Task 3: 网页、部署和证据

**Files:** 新建 `apps/web/src/StorageCenter.tsx`、`tests/storage-center.test.ts`；修改 `SettingsCenter.tsx`；新增验收报告及证据。

- [x] 网页静态渲染测试先失败：容量不完整说明、清理确认、中断入口、无误导成功状态。
- [x] 设置页接入，测试、类型和构建通过；相关恢复/备份回归。
- [x] 一次独立完整变更审查，严重/重要问题复现并修复。
- [x] JJ 部署、浏览器验证，历史交付/费用核对；记录证据、限制。

结果见 `docs/validation/storage-governance-2026-10-11.md`。提交与推送以当前分支 Git 记录为准。
