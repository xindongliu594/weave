# 无模型 API 的固定文件交接测试

从仓库根目录执行：

```sh
npm ci --prefix services/agent-runtime
npm run test:handoff
```

需要 Node.js 满足仓库版本要求。首次安装依赖需要 npm 网络；测试运行不调用模型 API、不需要 API Key、Docker 或数据库。这里验证真实 DSH Host、AgentTeams、产品文件工具权限层、独立会话、消息和任务交接。文件执行器使用临时目录测试替身；它不验证生产 Docker 隔离。

每次执行在 `.data/handoff-fixtures/<本次时间与随机标识>/` 保存：

- `summary.json`：本轮范围与结果，单独列出已知缺口。
- 各场景的 `result.json`：实际任务状态、尝试次数、计算结果和产物哈希。
- 各场景的 `trace.json`：真实 Host 的会话、工具调用和消息记录。
- 各场景的 `artifacts/`：实际读取、写出和执行的固定文件。

## 资料与预期

`request.md` 是需求；`inputs/orders.json` 是两行订单；`expected/report.json` 固定预期为 2 行、4095 分。错误模块故意遗漏数量，实际执行得到 1798 分。

`plan.json` 明确 library → application → inspect → repair → verify 五个任务。同一 producer 员工完成 library 和 repair，同一 checker 员工完成 inspect 和 verify。三个员工使用相同模型名、独立会话。这里的 `inputs`、`outputs` 是测试契约说明，**当前产品没有接入这些字段**，不能直接把本文件当成网页导入方案。

| 场景 | 检查什么 | 通过含义 |
|---|---|---|
| happy | 4095、依赖等待、结果转交、同模型独立会话、员工自己的历史保留 | 固定输入的调度和文件流程符合断言 |
| repair | 1798 被真实执行的检查识别，修复模块后重新执行得到 4095 | 预先批准的诊断/修复/复验链可运行 |
| failed-upstream | 上游明确失败，下游保持 pending | 任务状态依赖生效 |
| missing-file | 上游标完成但未写文件，下游仍启动并读文件失败 | **诊断确认产品缺口，不能解释为文件依赖保护通过** |
| 版本检查 | 文件变化后旧 SHA256 不匹配、文件缺失、非法路径 | 测试 oracle 能识别，未接入生产调度 |
| 声明检查 | 依赖环、漏声明上游、无先后关系的相同文件写入 | 测试 oracle 能识别，未接入生产文件契约 |

测试不伪造完成结果：期望值与实际 Node 执行结果比较；传给下游的交接标识在上游运行时随机生成；会话隔离通过仅向 producer 返回的工具标识检查；每项任务的尝试次数须为 1。测试适配器负责发起预设动作，不能证明真实模型会自主选择这些动作。

inspect 的目标是生成诊断记录，检测到计算错误仍完成“诊断任务”；它不是最终验收通过。repair 和 verify 已预先列在批准任务图内。本测试未接入 AgentTeams 原生质量任务类型、运行中新增任务或自动重规划。

执行文件仅允许仓库中逐字匹配的固定源码；终端运行由测试专用检查工具完成，未开放通用宿主命令。禁止把这里的文件执行器用于正式项目。

完整依赖设计与本次发现见 [说明](../../../docs/offline-handoff-testing.md)。
