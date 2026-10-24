# C1 固定工具定义与目录元数据切片 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. 本片执行已授权；不提交代码。

**Goal:** 实际员工 Host 发现和调用都固定同一工具定义，原地改写不能绕过现有对象身份门禁；目录保留可核对的定义摘要和诚实的效果审核状态。

**Architecture:** 复用 DSH 0.1.5-rc.1 的 registry/get/schemas/guard 和现有严格 JSON `effectDigest`；不注册第二个工具引擎。原 coordinator 定义与员工 forward 定义分别捕获，在现有 forward/access 检查点核对；B2 仍拥有执行边界。

**Tech Stack:** 现有 Node ESM、DSH 0.1.5-rc.1、AgentTeams 0.1.20，无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`；C1 总计划 `2026-10-20-tool-effect-integration.md` Task 1/3；B2 `2026-10-20-task-sandbox-integration.md`。

## 复用核对与约束

- 固定安装 `services/agent-runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js`：defineTool:837、register:2773、guard:2816、schemas:2918；registry 保留定义对象，schemas 只投影 name/description/parameters，输出 schema 必须从 definition.output.schema 取。
- `employee-tool-access.mjs` 已检查 employee/agent/对象引用；补充原地字段和执行函数变化检查。B2 `task-tool-boundary.mjs` 已冻结定义，本片仅消费最终注册对象，不修改或替换边界。
- `tool-effects.mjs` 已提供有界严格 JSON 摘要和合同格式校验。合同格式、插件 annotations 和名称不证明已审核；现无持久审核服务，目录必须标明 unreviewed/unknown，不能自动启用新工具、重试或放宽审批预算。
- apps/api 全部只读；不修改 host.mjs、product/native wrappers、task-tool-boundary、知识/工作文件或 schema。无 CUA、生产、安装、模型/付费调用。

## 文件与接口

- 新 `services/agent-runtime/tool-definition-effects.mjs` / `.d.mts`：`captureToolDefinition(definition, registrationBinding)`；固定摘要含版本、工具名、description、参数、输出 schema 和显式注册绑定。保存实际执行/展示回调引用用于 `matches(actual)`，不对函数源码做 hash。
- `employee-hosts.mjs`：首次 admission 同时固定 coordinator 定义指纹；forward 前检查。结构化 handoff 的员工 schema 与原 schema 分别固定，不假定二者摘要相同。
- `employee-tool-access.mjs`：捕获员工实际 registry 定义，沿现有同步 guard 检查；目录读取仅返回当前仍匹配且获授权的工具，避免后注册或 scope shadow 出现在可用列表。
- `employee-capabilities.mjs`：工具条目增加 `effectContract` 摘要描述（最初 unreviewed/unknown），不更改知识或 Skill 加载/采用规则。新元数据接口不授予执行权限。
- 测试：新增 helper 单测，修改现有 access/capabilities 测试；真实 DSH 无模型 adapter 验证默认路径生效和旧授权兼容。

## 步骤与验收

- [x] 先测试真实 Host：原地 execute/schema 变化在 body 前拒绝；后注册/同名 shadow 不进入 capability_search；原定义稳定时已批准调用照常成功；冷恢复维持 factory 固定定义。
- [x] 捕获 RED，补有界定义摘要/引用校验，接现有 Host/access/catalog；对不合法定义采用拒绝而不是 unknown 成功。
- [x] 跑 helper/access/capabilities/原合同测试；补 B2 边界及 handoff 相关回归，确认没有新操作 ID、审批或预算路径。34/34 + 57/57；全工作区 tsc 受其他进行中的 API 签名改动影响，5 条错误，不标绿。
- [x] 写 `.superpowers/sdd/2026-10-23-enterprise-plugin-completion/tool-effect-catalog-*` 证据与交接，明确本片不代表 C1 审核、intent、receipt、query 或补偿已接通。

## Review Focus

- definition 对象未换但 execute、parameters、output/schema 或 timeout 变化必须拒绝；返回原值再调用不能抹掉已检测到的变化。
- coordinator 替换或漂移不能因员工 Host 重建继承新的实现；新 factory 是新 admission，持久 source/approval 仍由后续服务核对。
- DSH/ B2 wrapper 引用与原工具实现身份不同；只比较实际注册对象，不 hash 函数或把名称当来源。
- 元数据只展示已授权条目，未知审核不能变为 read/retry-safe；契约登记的可信源校验另片接入。
