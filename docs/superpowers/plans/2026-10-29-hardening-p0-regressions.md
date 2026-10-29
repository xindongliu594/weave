# Weave 加固 P0：剩余回归收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复现并修复已知员工历史、执行策略、身份存储及扩展备份回归，形成可继续企业加固的真实基线。

**Architecture:** 继续当前 DSH、身份、授权和备份保护；优先更新因产品边界变化失效的夹具。只有可复现的生产缺陷才修改共用实现，不为通过旧测试放松保护。

**Tech Stack:** Node/TypeScript、node:test、现有 PGlite 隔离入口、原生 PostgreSQL（环境可用时）。

**Spec:** `docs/research/reuse-and-ai-delivery-estimate-2026-10-29.md`；既有企业设计 `docs/superpowers/plans/2026-10-20-enterprise-foundations.md` 的权限及数据保护仍适用。

## Global Constraints

- 当前 linked worktree / `codex/weiwu-mvp-validation` 继续使用；原调研文件保留。
- 不访问生产数据库、凭据、真实供应商或改变预算；合成模型仅作协议回归。
- DSH 0.1.5-rc.1、OpenShell 0.1.2 和依赖锁版本保持。
- 不移除身份、来源、未知费用/操作、writer 排空或企业备份拒绝门禁。
- 后端优先接口/代码/数据库断言；本批不需要 Computer Use。
- PGlite 不证明独立 PostgreSQL backend 竞争；跳过必须单列。

## Review Focus

- 应用测试关闭后台运行器不能关闭身份服务；无身份的真实请求仍拒绝。
- 员工恢复应保留模型、工具、知识等历史配置，并重新验证当前授权；旧项目不变。
- 执行方案不能通过 fixture 或直接 SQL 绕过真实版本、费用和资源授权。
- 身份数据禁止退回失效 session 或接受错误 epoch；并发用正确环境分层。
- 当前备份格式不支持身份/审计等依赖时须拒绝且无物理/SQL部分恢复，不能为旧备份测试清除真实审计。

## Task 1：员工历史恢复回归

**Files:** `tests/employee-history.test.ts`；如确有生产问题，先报告再领取其最小生产文件。

**Interfaces:** 使用现有 `createApp()`、`app.locals.shutdownBackground()`、正式迁移及 HTTP；不更改 API 合同。

- [ ] 使用 `node scripts/test-integration.mjs tests/employee-history.test.ts` 留存原失败。
- [ ] 从首个错误向身份/来源/历史恢复链追踪，参考已修复 `api.test.ts` 的工作夹具；写明根因。
- [ ] 保留并发 CAS、唯一经理、配置完整和项目快照不变断言；按当前边界最小修复。
- [ ] 重跑完整文件及相邻员工/部门历史测试；标明备份新格式缺口，不掩盖。

## Task 2：执行策略回归

**Files:** `tests/execution-policy.test.ts`；生产修改须先报告共享归属。

**Interfaces:** 原项目/方案/批准/恢复 HTTP 入口、账本和 archive，权限/费用不变。

- [ ] 留存完整原失败及是否存在原生 backend 专属跳过。
- [ ] 定位生命周期/当前权限/账本错误与真实产品缺陷；新增缺陷先见红。
- [ ] 最小修复，保留无新模型调用、预算净额、撤权和快照断言。
- [ ] 跑完整文件与相邻策略单元测试；不把合成请求视为真实模型验收。

## Task 3：身份存储回归

**Files:** `tests/identity-store.test.ts`、必要时 `scripts/test-integration.mjs` 及其定向选择测试；若涉及生产文件，与主线协商。

**Interfaces:** 原身份 schema/store，版本、epoch、角色及审计不变。

- [ ] 留存失败并区分环境缺失、过期夹具和生产错误。
- [ ] 以正式 schema 及当前事务/审计合同修复最小根因。
- [ ] 若 PGlite socket 在触发器事务后错配响应，标准隔离入口明确复用该文件已有直接 PGlite adapter；保留所有断言，其他文件仍走原 socket，不能用选择器绕过原生 PG 专属验证。
- [ ] 跑完整文件及相关身份检查；独立连接竞争另记。

## Task 4：扩展备份回归与公共验证

**Files:** `tests/extensions-backup.test.ts`；仅确有根因时修改原备份/夹具依赖；报告 `docs/validation/hardening-p0-2026-10-29.md`。

**Interfaces:** 当前旧加密业务包；新完整企业格式不在本任务内静默实现。

- [ ] 复现扩展备份失败，验证因身份/审计门禁拒绝时是否符合正式合同。
- [ ] 保留不支持格式的明确负向测试；仍可支持的旧格式正向使用真实合法空白目的库，禁止删审计伪造环境。
- [ ] 若需新增完整格式，记录缺口并进入独立先调研后计划任务，本任务不强行宣绿。
- [ ] 汇总各任务 diff，独立审查后重跑本批与相邻测试、类型检查和构建。
- [ ] 报告每个问题根因、命令、退出码、用例/跳过数及证据位置；提交保存已验证的批次，后续继续执行总体计划。

## 分工与依赖

Task1/2/3 各自只改分配测试及独立文件，可并行。主线负责 Task4、公共生产文件与最后验证；共享 helper、app、schema、coordinator 不同时编辑。已有失败是本任务输入，继续诊断无需重新向用户询问是否修复。
