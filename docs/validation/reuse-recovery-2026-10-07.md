# 恢复能力复用核对与最小接入（2026-10-07）

结论：当前系统已经使用 DSH 和 AgentTeams，恢复不需要重写一套调度器。已安装的官方 `@deepseek-ai/dsh-session-checkpoint-policy` 正好补足 DSH 会话 JSONL 的请求/工具前强制落盘边界；本次直接挂载固定版本，没有升级或修改插件源码。

## 本机已存在的实现

| 范围 | 实际来源与边界 |
| --- | --- |
| 会话、事件、投影、续接 | DSH `0.1.5-rc.1` 的 session、projection、query 与 JSONL persistence。JSONL 的 live event 通常在 200 ms 批窗口内写入，`sessions.flush` 才是明确的持久化屏障。 |
| 团队 DAG、员工、任务调度、质量字段、队列锁 | AgentTeams `0.1.20`。安装包的 `compatibility.json` 推荐 Host `0.1.5-rc.1`。 |
| 已完成节点恢复 | `checkpoint-team.mjs` 使用固定 AgentTeams 的 `withTeamLock/readTeam/writeTeam`，只恢复尚未开跑的 staged 团队，不改正在运行的团队。 |
| 费用、批准版本、文件 SHA、权限、知识版本、未知操作 | 为伍业务连接层；官方 session 插件不替代这些约束。`recovery.mjs` 只允许瞬时只读失败重试，修改/模型调用结果不明需核对。 |
| 宿主事件持久化 | `trace-store.mjs` 对追加记录同步 `fsync`，保存恢复证据；这不等价于 DSH JSONL 会话日志已 flush。 |

## 已接入的官方插件

实际文件：`services/agent-runtime/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-checkpoint-policy/lib/index.js`，版本 `0.1.5-rc.1`，通过项目已有的 `baseRequire.resolve` 加载。

官方实现未修改：

- `llm/stream`：会话完整请求前缀 flush 成功后，才构造下游模型流。
- 顶层 `tools/execute`：flush 成功后检查取消，再进入工具体；嵌套调用沿用外层已持久化的边界。
- `agent/pre-step`：进入下一步前 flush，保留前一步结果。
- flush 失败阻止模型或工具进入下游，不把写盘失败当成成功。

最小产品改动：`employee-hosts.mjs` 在 JSONL persistence 后挂载插件；`host.mjs` 增加挂载位置说明。Captain 和成员都经 `EmployeeHostFactory` 创建，分别拥有本地会话，因此均受此插件保护。

不能在 coordinator 再裸挂同一个 policy：coordinator 的 session store 不拥有这些员工会话，工具桥接传入员工 session 会被官方 `liveEntryFor` 以 `not live in this store` 拒绝。本次隔离测试实际复现该拒绝及零工具副作用，选取会话所属 Host 挂载避免引入这个兼容问题。

## 验证结果

Node 使用本机 bundled `24.19.0`。相关 9 个测试文件 **35/35 通过，0 失败、0 跳过**。其中新增 7 个测试使用实际 `createTeamHost`、官方 policy、真实 JSONL 后端与临时目录，覆盖：foreign-store 边界；模型请求等待落盘、落盘失败零下游；模型产生的工具调用在真实日志中可读后才进入工具体；工具落盘失败零副作用；落盘等待期间取消；Host close 保留取消并排空等待。

工程测试使用隔离 transport fixtures 核对调度顺序，未调用付费模型，不能作为 Todo 项目真实模型验收的替代。

其余回归包括员工冷恢复/权限、真实 DAG 调度、原始跨进程日志、质量 seal、真实本地文件并发冲突、模型结算和取消/批准截止时间。`tsc --noEmit` **exit 0**。

证据：

- `docs/test-evidence/reuse-recovery-checkpoint-tests-2026-10-07.txt`
- `docs/test-evidence/reuse-recovery-checkpoint-types-2026-10-07.txt`
- `docs/test-evidence/reuse-recovery-checkpoint-manifest-2026-10-07.json`

本次没有访问 live API 或原始数据库，没有修改凭据、已有员工交付物、批准预算或历史运行。**新源码尚需由主代理重启服务加载；当前真实 v10 服务重启恢复、QA/经理验收和知识版本固定验证尚未因这些工程测试而宣告完成。**

## 固定源码 SHA256

| 文件 | SHA256 |
| --- | --- |
| `services/agent-runtime/host.mjs` | `85d7c15004c6bf163a07dfcb1d5d2de9dec483270b3ae4a2e8e97c63a5a4a4a2` |
| `services/agent-runtime/employee-hosts.mjs` | `798f9aabbf03708cf9ef41319dac8aac33951c46c467755b18768dca18df5b6e` |
| `services/agent-runtime/employee-checkpoint-policy.test.mjs` | `85a64cb2bd3ce0d62a533fe5a39704b47c0969ab9d7699cae9f9ce384326ca40` |
| 已安装官方 policy `lib/index.js` | `80a4475de0594399bfdd3203e000cfe0bf1967af163f8747c45b9b80e9549f2a` |
