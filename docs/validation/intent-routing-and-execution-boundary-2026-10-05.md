# 意图路由与本机执行边界

此次按现有代码核对，没有改动运行合同、数据、桌面界面或执行目标。用户询问的是为伍的多员工架构，不能把 Codex 工具的沙箱权限等同于为伍的员工隔离。

## 路由设计与当前实现

建议将入口意图与执行分派分开。入口输出受约束的类型，如讨论需求、生成/修改团队草案、查看运行、请求中断/恢复；模型识别只是建议，程序再核对当前状态、项目/版本与用户明确操作。保存团队、运行、审批和恢复仍须走各自有权限检查及幂等保护的后端入口，不能因聊天模型一句“已确认”直接执行。

当前首页是组织对话入口，以 reply 和可选 candidate 继续讨论或形成草案，只有用户点击确认才保存。还没有将所有页面和自然语言命令整合为一个通用的 typed intent router。[组织对话](../../apps/api/src/organization-chat.ts)、[网页确认](../../apps/web/src/OrganizationChat.tsx)

执行入口已有固定分派：用户批准后冻结员工、任务、依赖、模型、文件合同、权限与预算；运行经理协调依赖满足的任务。模型选择按已批准 assignee/modelId，而不是员工自行挑人或换模型。当前 Todo v6 为 Luna 开发及协调/经理、Sol 独立 QA/复审；Astra 用于用户选择的规划入口，不能把手动修订的 v6 称为 Astra 真实生成。

原生团队注册完整任务，恢复已完成节点后锁定计划；每个员工请求和工具动作按宿主持有的会话、员工、任务及 attempt 核对。备用模型也须已批准。文件交接通过真实文件 SHA 与实际命令退出码校验，员工口头声称完成不能代替验收。[调度](../../services/agent-runtime/product-runtime.mjs)、[宿主授权](../../services/agent-runtime/host.mjs)、[任务归属](../../services/agent-runtime/task-attribution.mjs)、[文件交接](../../services/agent-runtime/handoff.mjs)

## 是否在沙箱

当前 Windows 本机模式有独立员工 Host/会话/上下文，但这些 Host 是 Node Context，未按员工建立操作系统进程或容器。员工协作使用同一项目工作区；每次 Run 有独立目录、固定导入文件与恢复版本。[员工 Host](../../services/agent-runtime/employee-hosts.mjs)、[实际启动入口](../../scripts/local-api.ts)

文件工具验证授权目录、相对路径及链接边界；终端命令须逐次审批并核对工作区版本。Windows 命令以当前本机账号启动 PowerShell，并有超时、输出限制与子进程清理。工作目录和任务文件合同不是操作系统权限隔离；已批准的命令仍拥有该 Windows 用户可用的系统权限。[本机执行](../../apps/desktop/local-executor.cjs)、[工具审批](../../services/agent-runtime/product-tools.mjs)、[本机操作队列](../../apps/api/src/local-execution.ts)

项目另有 Docker 执行器，对代码/文件/命令提供每 Run 容器，关闭网络、使用非 root 用户、只读根文件系统并限制资源。模型调用和编排仍在服务进程，不应说整个 Agent 都在 Docker 内。当前个人中转站 Todo 运行选择 local，未使用此容器；Docker 当前环境可用性没有在本次新增验证。[执行器选择](../../apps/api/src/run-coordinator.ts)、[Docker 实现](../../services/agent-runtime/sandbox.mjs)

本机与容器都是已有执行架构。本阶段按用户原范围优先完成网页主流程，不将上述设计说明或已有容器代码当作真实容器验收，也不擅自改当前授权设备/运行目标。
