# 沙箱与日志生命周期 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Inline implementation and one fresh final review.

**Goal:** 网页核对沙箱磁盘、确认完成沙箱回收及完成日志压缩，保留交付与未知结果。

**Architecture:** 复用同进程 OpenShell 执行器队列和现有 storage_cleanups 记录；Node 标准库资源扫描/gzip 与 trace-store 读取兼容。所有维护动作有持久意图和版本校验。

**Tech Stack:** Node 标准库、现有固定 OpenShell CLI、Express/PGlite、React。

**Spec:** docs/superpowers/specs/2026-10-11-sandbox-lifecycle-design.md

## Global Constraints

- 不增加依赖、不调用模型、不提高预算，不更改沙箱 CPU/内存/网络权限。
- /sandbox 20 MiB、128 文件、512 条目；/tmp 64 MiB、4096 条目；文件系统可用至少 256 MiB。应用门禁不称硬配额。
- 只回收完整交付且已 completed 的确切沙箱；未知操作、身份/版本变化、在途工作阻止。
- 不递归删除生产目录，不使用 delete --all；中断只查询，保留原始交付、费用和旧发布。
- 压缩仅完成日志，最大原文本 128 MiB，gzip 64 MiB；固定 SHA/快照；归档不可追加。

## Review Focus

- 停止沙箱核对启动后的版本和身份必须重新确认。
- 缺少回执、delete accepted、同名不同 ID 不得判为完成或重放。
- 子命令写临时文件和目录链接不能绕过资源检查。
- 归档中断/坏 gzip/双份日志不得丢失唯一可读原文。
- 备份、列表缓存及既有恢复入口必须读到相同事件。

### Task 1: OpenShell 资源监管与维护

**Files:** apps/desktop/openshell-executor.cjs、openshell-executor.test.cjs；新增资源测试。
**Interfaces:** executor.storageScopes() 返回固定映射；inspectStorage(runId) 返回容量与文件版本；retireStorage(runId,expected) 单次删除；reconcileStorage(runId) 只查状态。

- [x] RED：目录容量、活动命令超限、身份/版本变化、删除断线、重开后核对。
- [x] 实现固定脚本监管和同队列维护，既有执行器回归 GREEN。
- [x] 保存结果并提交。

### Task 2: 完成日志 gzip 归档

**Files:** 新模块 journal-archive.mjs / .d.mts / .test.mjs；trace-store.mjs；归档/API测试。
**Interfaces:** journalArchiveCandidate(root,runId) 返回固定元数据；archiveJournal(root,candidate) 校验压缩后替换；readJournal(dir) 读取原文并验证；trace-store 调用兼容。

- [x] RED：相同事件/列表、坏 gzip、链接/变化、双份中断、不可追加、备份恢复。
- [x] Node gzip 最小实现，复用现有事件解析，相关 trace 回归 GREEN。
- [x] 保存结果并提交。

### Task 3: 网页维护、JJ 验证和交付

**Files:** storage-governance.ts / StorageCenter.tsx / local-api.ts / app.ts；新增生命周期 HTTP/UI 测试；验收资料。
**Interfaces:** 设置页增加沙箱核对/回收与完成日志归档；复用持久 storage_cleanups 状态和既有确认/核对入口，预览 kind 绑定执行方法。

- [x] RED：维护权限、活动/未知拒绝、明确确认、重复/重启、不同类型不可交叉确认。
- [x] 实现同进程适配及页面，回归、类型和构建通过。
- [x] 一次完整独立审查，重要问题一轮修复。
- [x] JJ 部署、实际沙箱资源验证与受控持续实验；保留数据/用量证据。
- [x] 记录限制，提交并推送当前分支。

验收范围：JJ 受控持续实验为约一分钟生命周期采样；多小时员工任务未验证，完整范围及审查修复见 docs/validation/sandbox-lifecycle-2026-10-11.md。
