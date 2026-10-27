# 新恢复验收候选：预算与上下文只读审查

结论：现候选具有完整四节点合同和有限预算，但不能据静态校验保证整链完成。员工模型尚待真实 Astra 修订；执行前应通过网页落实新的项目策略、费用边界和知识授权。本审查没有修改候选、产品源码、原数据、员工文件或冻结的 run helper，没有 API、模型或服务操作。

[只读证据及源码 SHA](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-recovery-candidate-policy-review-2026-10-05.json) 固定候选 `.data/funded-acceptance/recovery/browser-draft.json` SHA `c21f6e0047bff341c134a8c768875dcdee3e3478abcccbc64b1f538c5d645e11`，preview `4bfb3d90-8df4-421d-a835-b385595fd4c3`；读取前后相同，尚未保存。实际候选三位员工均为 Astra，policy cap `$5`、context `64000`、调用 `100`、每任务默认 `40`，validation estimate `$3.06`。

| 节点 | 任务预算 | 实际调用上限 | 单次输出上限 |
| --- | ---: | ---: | ---: |
| dev | $1.30 | 14 | 4600 |
| qa_verify | $1.10 | 12 | 3000 |
| qa_review | $0.55 | 7 | 2000 |
| manager_accept | $0.55 | 7 | 2000 |

任务预算合计 `$3.50`、任务调用合计 `40`。policy 的每任务 `40` 只是未显式设置任务上限时的默认值，不能覆盖上述 `12/7`；项目 `100` 也不能给某任务额外调用。实际预留同时受项目、任务、历史消费和已有占用约束，不会从开发的未花额度自动转给 QA。[预算实现](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/budget.mjs:10)

已有闭合原生预检记录相同模型 ID 的 Luna 单价 `0.1/0.5`、Sol `2/10`（USD/百万 Token）。如果当前配置仍一致，并沿用本候选累计 Token 估算，将角色改为开发/经理 Luna、两项 QA Sol 后，算术估算分别 `$0.0100 / $0.1700 / $0.0760 / $0.0032`，合计 `$0.2592`、含20%为 `$0.31104`。这仅说明原 Astra 估算不适用于修订后的角色，并非替 AI 修订预算，也不证明真实多轮成本或任务调用数；必须由真实规划生成新候选并核对当前模型配置。[已有原生预检](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/fresh-recovery-native-preflight-compact-fresh-with-readonly-results-2026-10-05.json)

## 64KB 风险及需要设置的字段

当前 compact task description 已去掉重复 taskPrompt，最新原生 department 快照在 admission 后刷新并持久化；工具 schema 仅列已授权能力。发送前仍保护完整当前合同、恢复与预算、最新 assistant/tool 组、带 SHA 的文件和固定 KB 引用。只允许删除同一员工/任务/attempt 中经宿主证实完全相同的成功只读组；不同文件版本、不同引用和独有测试结果不会被当作重复删去。[精简映射](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/handoff.mjs:142)、[请求保护](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/openai-compatible.mjs:44)、[受证实只读去重](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/request-context.mjs:68)

实际字节门禁为 `min(policy.contextBytes, route.contextBytes ?? policy.contextBytes)`，限制 `JSON(messages)`，费用预留另按完整 `JSON({messages,tools}) + 1024` 计算。资金充足时，保护组超出字节上限仍返回 `CONTEXT_LIMIT`；超出可负担金额返回 `BUDGET_CONTEXT_LIMIT`。旧 v6 四文件原生预检最低 envelope 为 `53430B/$0.122908`，此前失败是金额门禁；其完整 envelope `64809B` 包含 tools，不能直接当作 messages 超过64KB的证据。它也不是本候选的实际 native packet。[门禁源码](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/openai-compatible.mjs:267)、[两类独立门禁](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/limits.mjs:46)

建议仅对这两个尚未执行的新项目，将“策略上下文上限（字节）”设为 `192000` 再批准，为完整文件、独立测试及固定引用留出字节余量。该设置不会扩大金额、单次输出或调用上限，仍由原预算拟合和原子预留把关；192KB也不是整链成功保证。当前首页组建设置没有此字段；保存团队后在项目“编辑方案 → 项目执行策略”修改 policy，保留真实 AI 任务与合同，保存新版本后批准。[网页策略字段](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/ProjectPolicy.tsx:18)、[编辑入口](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/App.tsx:293)

执行前还须核对实际模型 route 的字节限制；若明确设为64000，单独提高项目策略无效。本次没有查询 API，模型实际限制未验证。模型配置网页只提供“上下文容量（Token，可选）”，会保留原 `contextBytes`；Token 字段不能改这个字节门禁，不应填造容量来启动摘要。已有摘要功能仍可能消耗原预算和调用次数。[模型配置表单](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/apps/web/src/App.tsx:250)

## 批准前的其余门槛

- 实际项目 cap 必须扣除本路径未归属规划费用/预留。主代理已报告恢复路径孤立规划 `$0.22511`，故后续候选 cap 应≤`$4.77489`，当前读取候选 `$5` 还不能直接执行。两项目 cap 加孤立费用/未知预留，以及新增已花费加全部新增预留，均须≤`$10`；不清零原未知费用。
- 保留四节点、原文件 inputs/outputs、两个真实 node 测试命令、各任务独立预算与输出上限；`100/40` 可保持，是否扩大任务自身调用数应由真实修订说明理由，不能仅改策略数字。
- 当前 policy 知识空间列表为空，员工没有 knowledge tools/space grants；QA 合同却要求固定共享与私有资料引用。通过网页建立少量资料、项目允许空间/文档及员工授权；检索员工需要实际 `knowledge_search`/`knowledge_read` 能力。QA 私有原文仅给 QA，经理可核对其真实引用回执，不能借此越权读原文。固定 document/version/SHA 后再批准，在批准后更新最新版本才能验证恢复仍引用旧版本。
- 使用实际本机设备/目录授权，核对在线及命令权限；测试命令逐条按具体审批批准。依赖链串行，`maxConcurrentAgents=2` 不表示四节点可同时执行；经理协调仍可能使用额外全局调用。
- `deadlineSeconds=3600` 可保留，但实际审批等待和执行耗时仍须观察。受控停服在开发真实完成、文件 SHA 封存及无在途外部操作后实施；恢复必须核对同版本 DAG、历史费用/调用和固定引用，开发新增调用必须为0。

未验证项：修订后真实候选的 native 入场 packet、未来员工文件与工具结果大小、当前模型限制与账本、完整开发→独立QA→复审→经理的真实费用和完成结果。当前应先完成真实修订及网页策略/授权配置，再对具体已批准 packet 做零费用预检；不要将条件算术估算或单请求可发送标成完整 MVP 验收通过。
