# DSH 团队运行验证

验证日期：2026-09-19。锁定 DSH `0.1.5-rc.1`、AgentTeams `0.1.20`。

## 如何复现

```sh
npm run runtime:inspect
npm run runtime:test
```

依赖位于 `services/agent-runtime`，首次安装需在该目录运行 `npm ci`。

测试使用真实 DSH Agent loop、spawn 子 Agent、JSONL 会话持久化、工具执行流水线，以及社区 AgentTeams 的团队状态、调度器和消息系统。仅 LLM Adapter 为确定性的测试实现，不访问网络、不读取 API Key、不产生模型费用。临时目录在测试结束后清理。

## 已验证

- 独立 Cordis composition 能加载社区插件及其 14 个团队工具，不加载官方 experimental-agent-team，也不读取用户全局 DSH profile。
- 通过正式 `agent_teams_create` 工具提交完整 roster/DAG，显式设置 `approval: required`；创建后成员未启动、任务未认领、模型调用为零。
- 程序化批准走 DSH 工具执行流水线；`tools/pre-execute` 拒绝时，团队仍处于 staged 状态。
- 批准后，由插件调度器启动第一位员工。前置任务未完成时，第二位员工尚未启动。
- 两位员工分别使用配置的模型路由，经真实 Agent loop 调用 claim/update/message 工具。任务需从 claimed 进入 in_progress 再 completed。
- 后续员工的模型上下文包含前置任务结果；两项任务完成后插件报告 deliverable。
- 成员的模型工具列表不包含创建团队或批准工具；直接以成员身份调用创建团队也被插件的成员身份检查拒绝。
- 关闭后重新创建 Host 并恢复 captain session，可以读取相同团队和已完成任务。
- 关闭 Host 时，正在等待的模型请求收到 AbortSignal，清理完成后才返回。

## 发现与实现边界

持久成员必须挂载会话持久化后端。仅检查插件 import 或工具注册成功，不能证明成员可启动。Host 因此要求显式提供独立的绝对 sessionRoot，并在 Agent loop 之前挂载 JSONL 后端。

`host.mjs` 现在由产品 RuntimeAdapter 复用。目前只挂载团队工具，没有挂载文件读写、终端或网络工具；因此正式 Run 只接受纯文本方案，这仍不是代码交付或文件权限验证。

此次关闭测试证明 Host teardown 可以取消请求，不等同于已实现产品的暂停/恢复。冷启动测试验证已完成历史读取，不覆盖执行中断后的任务恢复。测试模型按预设逻辑回复，不能证明真实模型会正确执行团队协议。

## 接下来的产品接入

1. 使用用户配置的具体中转站和模型验收工具调用、取消与用量格式。
2. 在启用文件或终端工具之前落实员工工具授权、执行限额和交付物范围。
3. 增加进程重启后的运行恢复、并发限流和幂等启动恢复。
4. 验证代码类任务的文件交付、测试证据和失败修复路径。

不直接写入 `.agent-teams` 来伪造运行，不复制插件调度器，也不调用未公开导出的内部函数。
