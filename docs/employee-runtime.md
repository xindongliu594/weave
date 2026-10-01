# 员工独立运行时

2026-10-01，本地实现版本 `employee-host-v1`。

## 运行边界

每个 Run 拥有部门协调 Host。协调层通过 DSH 的公开 `AgentRegistry.setFactory` / `AgentFactory` 接口，为经理和每个成员创建独立 Cordis Context；协调层本身不挂载 Agent loop。

每个员工 Host 独立挂载模型接口、Session 服务、Session projection、提示词与工具注册表、JSONL 持久化、历史查询和 Agent loop。员工自己的 Agent 注册表仅包含该员工，Session 服务不能查到其他员工的活跃会话。经理也按同一方式创建独立 Host。

C1 在此边界内接入各自的 Token 测量、工具结果缩减和自动摘要；固定批准任务合同、保留原始证据，并沿用共享预算和权限。配置及失败行为见 [员工上下文管理](context-management.md)。

各 Host 目前运行在同一个 Node 进程。这一边界隔离产品运行状态、上下文和宿主生命周期；进程崩溃仍会影响整个服务。共享交付物继续由 RunSandbox 和文件合同约束，不代表员工获得宿主机文件访问权限。

## 部门协调与授权

协调层汇总 live Agent 身份，挂载现有 AgentTeams 调度器，保留原生任务 DAG、消息、attempt 凭证和质量门禁。每个员工的工具注册表向协调层转发请求；请求必须仍属于注册的 live Agent，并经过既有工具权限、审批、不可变方案及文件交接检查。成员的本地工具限制继续屏蔽创建团队、批准等经理工具。

每人的模型接口向协调层转发已在本地组装好的请求。共享模型预算、任务费用、部门日额度和并发门禁仍在协调层执行；每人的模型选择、岗位提示词、历史和上下文组装留在自己的 Host。费用继续使用真实 session、员工、任务、attempt 和 request 关联。

## 取消、故障与恢复

- 单个员工 Host 释放会取消并等待该员工的请求，随后清理本地会话、插件和协调层登记。不会直接清理兄弟员工的 Host。
- 模型异常写入该员工自己的会话；是否终止整个产品 Run 仍由现有项目执行策略决定。正式 Run 的失败策略可以统一取消全体员工。
- 部门关闭先拒绝新 Host，再通过公开的子 Agent drain 接口清理后代，等待全部员工和未发布的初始化完成清理，最后释放协调层服务。
- 原生持久成员在空闲时可释放 Host。下一条分派或消息会通过正式 resume 接口创建新 Host，并读取该 session 的持久记录。长期保留员工配置不要求 Host 永久驻留。
- 产品服务重启仍使用原有任务检查点与人工确认恢复。重试创建新 Run，并记录本次架构版本；不会改写旧 Run 的快照或执行档案。

同一个 Run 的会话日志保存在其专用 `sessions` 根目录，文件按 session ID 分离；各 Host 不共享可变 Session 服务。追溯统一追加 `runtime/architecture`、`runtime/created` 和 `runtime/disposed`，记录宿主、会话与员工归属。仍只有一个 Node 进程写同一 Run 档案。

## 本地验证与 CI

```sh
npm run build
npm run test:rules
npm run runtime:inspect
npm run runtime:test:portable
npm run test:integration
```

Windows 本地验证覆盖独立注册表、角色与历史隔离、单员工取消、单员工模型故障、持久历史恢复、初始化失败回滚、初始化中关闭、团队依赖、同一员工继续分派、消息、工具拒绝、共享费用、文件版本、质量合同和审批取消。模拟产品流程使用 PGlite、HTTP 模型替身与固定文件执行器，不产生模型费用。

2026-10-01 在 Windows / Node 24.15.0 完成验证：非 Docker 运行时 43/43、模拟产品流程 14/14、规则 13/13、桌面连接 1/1、交接检查点恢复 1/1，共 72 项；TypeScript 检查与 Vite 构建通过。产品流程同时核对每条员工费用对应的 Host 身份，以及完成后每个 Host 的释放记录。CI 使用仓库支持的 Node 22.19.0；该版本和其他操作系统的结果须以云端作业为准。

核心 CI 在 push 到 main、PR 和手动触发时执行。Windows、macOS、Linux 作业运行构建、规则、依赖检查、非 Docker 运行时与模拟产品流程；另一个 Linux 作业使用真实 PostgreSQL/pgvector、Docker 沙箱和固定本地嵌入模型。

2026-10-01，提交 `f3d62514109970e47d56606f9d1a9d95b400ed2e` 的 [云端验收 run 36823778150](https://github.com/xindongliu594/agent-department/actions/runs/36823778150) 四个作业全部通过：Windows、macOS、Linux 均通过构建与核心测试，Linux 后端的 58 项测试和 2 项真实 Docker 沙箱测试通过。该结果使用 Node 22.19.0、真实 PostgreSQL/pgvector 和固定本地嵌入模型；中转模型请求仍来自本地协议替身。真实中转模型业务质量及远程部署尚未复验。

Windows 测试不再修改 PATH 或调用 Unix shell 模拟 Docker，就绪检查通过 `RunSandbox.assertReady` 边界替换；生产实现仍执行真实镜像检查。路径测试在 Windows 使用目录 junction，在其他系统使用目录符号链接，保持对链接路径与二进制正文的拒绝验证。
