# 原生能力接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公司能力和社区工具使用同一 DSH 注册、发现与调用流程，先用原版办公插件完成员工授权、隔离执行、交付与恢复验证。

**Architecture:** 保留 DSH 0.1.5-rc.1 和现有 EmployeeHostFactory、OpenShell、知识 Skill、预算及交接机制。插件由原生 Context/tools 加载执行；为伍只保存可信安装元数据、员工权限和不可变运行绑定，并将原生工具调用转发到既有隔离执行器。普通 npm 插件不导入持有模型凭据的 API 进程。

**Tech Stack:** 固定 DSH/Cordis、原版 @huiliyi37/dsh-office@0.2.4、已有 esbuild、OpenShell 0.1.2、Node 24.19、Postgres/PGlite、React。

**Spec:** AGENTS.md；docs/research/multi-department-release-scope-2026-10-18.md；docs/validation/dsh-office-plugin-pilot-2026-10-18.md；本计划下述范围约定。

## 调研结论与范围

- 固定 DSH 已有 `dsh plugin --profile <name> <pnpm args>` 和公开 app-boot profile/Loader 接口；尚未安装新版 `dsh-plugin-manager`。安装、配置和原生工具执行复用这些机制，不开发替代插件引擎。
- 原生 `tools.guard()` 是不可被 allow 覆盖的执行防线；`restrict()` 只过滤继承工具，单独使用不能保护动态注册。修复旧固定八工具名单的扩展障碍。
- 公司 Skill 已使用原生 skills/skill 工具，保留；MCP 保留现有只读授权，不能借本轮放开 stdio 或写权限。
- Office 原版十个工具在固定 DSH 下已验证。新增隔离探针将原依赖打为 10,584,944 字节 JS（gzip 2,012,448 字节）及一份原 package.json，无业务逻辑重写；正常 Office 操作均成功，0 模型调用。
- 文件工具型首先接入；后台服务与原生网页插件仍分别验收。本轮不承诺任意 npm 包可直接运行，不升级 DSH、不新增本地大模型。
- 官方来源：https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/src/plugin.ts （与固定安装源码分别核对）；当前实际接口以 services/agent-runtime/node_modules 下固定包为准。

## Global Constraints

- 保留原运行、未提交文件、凭据、六笔历史未知费用和所有既有权限；不手改数据库代替产品流程。
- 新能力使用命名空间和版本绑定，不与原生协作工具同名；恢复不能偷换版本，撤权立即停止后续调用。
- 不提高金额授权；真实新项目调用前核算已授权范围，必要时只为具体可执行方案询问一次。
- 模型调用仍用现有 API、预算、收据链路；本地回归禁止模型网络调用。
- 原版插件代码在已有隔离边界内执行；不使用 terminal 名义绕过命令审批。
- 二进制交付复用原有 Base64 镜像、sha256、workspaceRevision、交接封存和备份；工具结果不等于质量验收。

## Review Focus

- 新注册及同 scope 工具不得绕过授权；缺身份、未知名称、冲突和重复注册均拒绝。
- 升级、禁用与恢复并发时，固定快照不能静默改用新版本。
- 插件读写越界、隐式修改或调用中断，不能产生伪成功回执或自动重放。
- 私有公司方法与社区工具共同发现时，不能暴露他人的资料或权限。
- 缺失依赖、超限和不可打开的文件须显示真实失败，不能写成功文案冒充验收。

## Task 1: 原生动态工具授权边界

**Files:** services/agent-runtime/employee-tool-access.mjs、employee-hosts.mjs、employee-tool-access.test.mjs。

**Interfaces:** `installEmployeeToolAccess(ctx, agentCtx, {agent, employee, infrastructureNames})` 使用原生 restrict/guard，为新注册工具维持默认拒绝；工具业务实现不感知部门系统。

- [x] 写本地失败测试：获授权动态工具可见可调用，未授权/后注册/同 scope 绕过/伪身份均拒绝；协作和公司 Skill 保留。
- [x] 实现共用访问边界并接入真实 EmployeeHostFactory，不改变无产品身份的基础 DSH host。
- [x] 运行新测试及现有 employee-hosts、employee-capabilities、approved-skills 回归。

## Task 2: 固定能力目录与原版包构建

**Files:** services/agent-runtime/native-capabilities.mjs 及声明/测试；scripts/plugins/build-native-tool-bundle.mjs；apps/api/src/native-capabilities.ts；product-schema.ts、backup.ts。

**Interfaces:** 安装元数据含 namespace/package/version/source/lock 摘要、bundle sha256、原生 tool schemas、文件权限声明；`snapshotNativeCapabilities(agents, db)` 只绑定启用且获授权版本；`assertNativeCapabilities(snapshot, db)` 拒绝缺失/撤权/变更。

- [x] 测试命名冲突、非法绑定、同版本不同摘要、恢复丢包及旧快照兼容。
- [x] 使用原生安装产物和现有 esbuild 构建隔离入口，保存来源/完整性；目录只读取数据，不导入插件。
- [x] 接入批准/恢复和备份；工具 schema 扩展接受规范动态 ID，但最终授权必须匹配已安装目录。

## Task 3: 隔离工具调用与交接

**Files:** services/agent-runtime/native-plugin-tools.mjs、host.mjs；apps/api/src/local-execution.ts；apps/desktop/openshell-executor.cjs；对应测试。

**Interfaces:** 原生定义转发到 `native_plugin` 操作，外层携带固定 bundle 身份及 originalTool；内层保留原参数 schema。OpenShell 内受限 Node 加载原版插件并 `ctx.tools.execute()`；父进程独立封存文件和回执。

- [x] 验证越界、篡改 bundle、无权调用和断线不重放。
- [x] 串行复用现有 handoff 文件输入/输出合同和文件版本锁；既有二进制回传不重新实现。
- [x] 实际原插件生成/读取三种文件，独立解析内容；证明结果进入正常交付列表。

## Task 4: 网页连接与部署

**Files:** apps/web/src 的能力目录、员工工具授权及项目策略组件；API 路由；部署与验收文档。

- [x] 网页呈现已安装/启用/未授权/不兼容状态、来源版本；员工工具授权从共用目录读取。
- [x] 类型检查、构建、相关 API 隔离回归；部署 JJ 前校验原服务目录与数据目录。
- [ ] JJ 实测原版插件，浏览器最后检查主流程；真实员工验收在有效预算授权内执行，单独标记本地探针与真实验收。
- [ ] 审查、明确记录未验证/受阻项，按具体文件提交并推送，不混入历史未跟踪文件。

## 进度

- 2026-10-18：调研和隔离依赖探针通过；JJ 服务 active，当前发布目录 weiwu-handoff-paths-20261017。产品集成尚未完成。

- 2026-10-18：Tasks 1–3 与网页连接已实现，JJ 新版本已部署。组件证据含原版插件 7 次真实 OpenShell 调用和执行器进程重启。真实模型验收、网页完整验证尚未通过；用户已批准新项目最高 $0.40，累计 $3.41 不变。详细证据见 docs/validation/native-capability-integration-2026-10-18.md。

- 2026-10-18 后续：新验收项目 5b0f9606-859f-4c63-96b3-4e7e0d7412ec 已创建，原版插件已启用。规划目录收窄到获授权工具后报价通过，原输出/金额上限不变；付费规划的 SSH 命令在连接阶段超时。真实员工与网页仍标记受阻，先保存已通过的组件证据及代码。
