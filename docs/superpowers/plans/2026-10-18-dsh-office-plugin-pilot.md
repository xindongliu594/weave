# DSH 办公插件与公司 Skill 共用接入验证

> **For agentic workers:** Use superpowers:executing-plans to execute this bounded compatibility pilot. No product rollout or paid-model acceptance is included.

**Goal:** 原样加载一个已发布办公插件，用现有 DSH 注册器及公司 Skill 验证组合调用，找出生产接入的实际缺口。

**Architecture:** 保留为伍固定 DSH 0.1.5-rc.1 与生产 EmployeeHostFactory；第三方包放独立试验目录，不修改生产依赖。探针采用原生 DSH 内存组合及现有 `installApprovedSkills`，调用原生工具执行接口，使用拒绝模型请求的 adapter。工具生成真实 Office 字节，独立解析核验；测试文件明确是兼容性样例，不是员工业务交付。

**执行偏差（已记录）：** 原计划直接使用 createTeamHost/EmployeeHostFactory；首次受限进程执行发现 Node 24 权限模式禁止 trace-store 所需 fsync。为保留生产持久化保证，改成内存组件探针；生产 Host 插件加载与恢复未验。Node 24 不提供网络隔离，本次未提供网络输入/模型凭据，也没有网络监测，不能声明“无网络访问”。

**Tech Stack:** Node、DSH/Cordis、@huiliyi37/dsh-office、现有公司 Skill provider、node:test。

**Spec:** docs/research/multi-department-release-scope-2026-10-18.md；用户确认优先复用已有插件、公司能力与 DSH 共用。

## Global Constraints

- 不调用模型、不读凭据、不修改 JJ 或生产数据库；金额与权限不增加。
- 不升级 DSH，不改第三方业务源码，不执行依赖安装脚本；固定包版本及完整性摘要。
- 本地写入只允许本次独立试验目录；保留原文件和其他历史修改。
- 成功的本地协议调用不能冒充员工自主选用、真实 QA 或浏览器验收。

## Review Focus

- npm 实际发布版与 GitHub main 不一致：以下载包版本及 integrity 为准。
- 插件直接使用 node:fs：通过受限进程阻止越界，记录生产需要的沙箱位置，不宣称 DSH 注册即隔离。
- 动态工具不在固定八工具权限名单：验证原生限制接口，记录产品授权缺口，不能默认开放。
- 同时存在公司/第三方 Skill：同一 DSH 目录查到、按需读取，版本校验沿用现有 provider。
- 文件存在不等于可用：独立打开 ZIP/XML、回读文字、核对表格/公式结果；视觉渲染单独标未验证。

### Task 1: 获取并检查固定插件

**Files:** `.data/plugin-pilot-20261018/`（忽略目录）、本报告证据目录。

**Interfaces:** npm 元数据与 tarball；现有 DSH node_modules 只读。

- [x] 读取实际发布版、tarball SHA512、依赖和生命周期脚本。GitHub main 0.2.5 在 npm 未发布，改用实际可得 0.2.4。
- [x] 在独立目录下载/解包并核对 SHA512，检查实际发布源码的工具接口和直接 I/O。
- [x] 只安装试验依赖，禁用生命周期脚本，复用现有 DSH 单一实例；保存锁文件和来源证据。

### Task 2: 执行共用接入探针

**Files:** `scripts/validation/dsh-office-plugin-pilot/`、`docs/validation/evidence/dsh-office-plugin-pilot-2026-10-18/`。

**Interfaces:** 原生 `Context`、`ctx.plugin`、`ctx.tools.execute`、现有 `installApprovedSkills`；EmployeeHostFactory 仅由已有 Skill 回归覆盖，不代表办公插件已接入该生产接口。

- [x] 先编写断言：原版插件工具能注册；公司 Skill 正文按需读到；DOCX/XLSX/PPTX 工具创建/读取真实样例。
- [x] 受限 Node 子进程执行：探针模型 adapter 调用 0 次；读写白名单；网络隔离未验。
- [x] 验证未授权工具及公司 Skill 调用被原生权限接口阻止、越界文件读写被进程拒绝；不添加自制 Office 实现。
- [x] 独立核对文件格式/文字/表格/公式，并导出工具清单、错误、耗时、哈希及调用数。XLSX 数值缓存未持久化，明确保留 acceptancePassed=false。

### Task 3: 判定并保存下一步

**Files:** `docs/validation/dsh-office-plugin-pilot-2026-10-18.md`、研究记录、协作约定。

- [x] 运行现有批准 Skill 的相关回归，2/2 通过；测试临时目录在进程内设置以适配托管环境。
- [x] 独立审阅试验脚本与证据；修复过宽读权限、加强拒绝错误/内容断言，列出最小产品连接缺口。
- [x] 仅纳入本轮 16 个明确文件；文档区分组件通过、整体能力未通过、生产未接入、真实模型/网页未验证。既有其他修改和历史数据保留。
