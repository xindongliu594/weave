# DSH 接入验证记录

更新：2026-09-19（本机 America/Los_Angeles）。阶段：依赖检查与独立 Host 的测试模型团队流程通过；产品桥接和真实模型执行验收尚未完成。

| 项目 | 实际检查结果 |
|---|---|
| 系统 | macOS / arm64 |
| Node | 22.19.0，复用相邻项目工具链 |
| npm | 10.9.3 |
| DSH | `@deepseek-ai/dsh@0.1.5-rc.1` |
| AgentTeams | `@nanmicoder/dsh-agent-teams@0.1.20`，精确锁定 |
| 插件 import | 通过，导出 `name=agent-teams` 和 `apply` 函数 |
| DSH CLI | `--version` 返回 0.1.5-rc.1 |
| 插件 doctor | 231 个 DSH 包身份检查通过 |
| Runtime 安装审计 | npm 报告 0 vulnerabilities |
| PostgreSQL | `pgvector/pgvector:pg17`，独立 Docker Compose 服务健康 |
| 真实 Provider | 待用户在本地页面配置中转站 |
| 三模型团队 / 取消 / 恢复 / 用量 | 尚未验收 |
| 独立 Host + 测试模型 | 两位成员依赖调度、结果传递、审批门禁、完成历史冷恢复、Host 关闭取消通过；详见 [运行验证](runtime-spike.md) |

## 已解决的依赖问题

仅固定 DSH CLI 和 AgentTeams 的顶层版本不足以固定传递依赖；第一次安装解析出了 rc.2，造成 peer conflict。固定全部 DSH 依赖并去重后，通过插件自带 doctor。精确安装结果保存在 `services/agent-runtime/package-lock.json`，后续使用 `npm ci`，不使用浮动 latest。

doctor 曾在打印 FAIL 时返回退出码 0；项目的 `runtime:inspect` 同时检查输出中的 FAIL，防止误报通过。

## 实际接口检查

9 月 15 日初查已安装 npm 0.1.17 包；9 月 19 日升级并锁定 0.1.20 后验证正式工具入口。插件入口暴露 `apply`、Config 和协议文本；Web 路由包括 `/plugins/dsh-agent-teams/state`、`/halt`、`/plan`。计划批准路由需要一个已经挂载的 captain session 和存在的 staged team。因此不能把某个臆造的 HTTP create-team 路由直接接到产品后端。

已新增独立 `host.mjs`，使用 DSH 正式注册工具流水线完成创建和批准，验证模型路由与子 Agent 调度，不直接写插件状态文件。下一步是具体中转站的真实模型适配、产品 Run 生命周期和员工工具授权。业务 API 当前仍使用 PendingDshAdapter 并明确返回未就绪。

## 已完成的产品侧验证

- TypeScript 检查与 Vite production build。
- 独立 PostgreSQL 测试 schema：部门保存/删除、项目历史保留、方案版本与过期写入拒绝。
- 本地协议服务：单中转站模型列表读取、指定模型的 Chat Completions、用量记录、密钥加密与不回传、并发生成去重。
- 确定性校验：单经理模式、经理数量/唯一 ID、目录外模型、循环依赖、负责人缺失、费用与并发越界、验收标准缺失。
- 浏览器：创建四人部门、保存 Todo 需求、方案编辑生成 v2、查看 v1/v2。

本地协议服务只用于测试，不代表已连接用户中转站，也不代表真实 Agent 执行成功。
