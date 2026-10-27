# 新增 Todo 实际验收证据提取：准备阶段

用户已批准另建两份真实项目，每份最高 $5，新增合计最高 $10，包含 Astra 需求规划、Luna 开发和经理、Sol 独立 QA 与复审。原 v6 的 $0.48、历史账本及未知费用继续保留。授权基线见 [approved-intent](../test-evidence/funded-acceptance-approved-intent-2026-10-05.json)。本文件只记录只读工具准备，不宣称两条真实主流程通过。

| 项目 | 当前证据与状态 |
| --- | --- |
| 首次正常路径规划 | **失败/受阻**：实际网页请求 HTTP 502 `GATEWAY_TIMEOUT`，该次新增已登记 usage 为 0，未知预留 $0.37821；没有证据说明供应方未调用或未扣费。见 [send 证据](../test-evidence/funded-normal-send-2026-10-05T10-42-57-801Z-fb24616f.json)，观测时间 `2026-10-05T10:44:30.429Z`。 |
| 两份新项目、正常完成、员工交付 | **未验证**：截至上述证据，未创建正式项目；尚未收到可核对的真实项目和运行 ID。 |
| 本阶段受控中断与重启恢复 | **未验证**：不能拿旧运行的恢复结果替代本阶段父子运行。 |
| 原 v6 未变化 | **待采集**：授权文件保存基线；本代理未调用原环境 API。最终工具会独立比较原项目 cap/version、已登记账本及预留 ID/status/amount；这些 GET 不提供预留完整 history。 |
| 提取器工程回归 | **通过**：最终 45/45 内存回归和两份 `.mjs` 语法检查；0 API、0 模型调用、0 原 DB 打开、0 员工文件写入。见 [最终回归 JSON](../test-evidence/funded-todo-acceptance-extractor-fixture-final-2026-10-05.json)。本地合成记录不算真实模型验收。 |

实现为 [audit-funded-todo-acceptance-2026-10-05.mjs](../test-evidence/helpers/audit-funded-todo-acceptance-2026-10-05.mjs)。只允许 loopback HTTP `/api`，使用 GET `/projects`、`/usage`、`/models`、指定项目 `/cost-readiness`，以及指定运行的完整 `/export`、运行状态、交付文件和引用回读。禁止跳转，JSON 上限 50 MiB、单文件上限 5 MiB、每个 GET 超时 15 秒。只写一个新的仓库证据 JSON，拒绝覆盖及路径逃逸。不打开数据库、读取凭据、恢复、结算、执行命令或调用模型。**排除 `/costs`，因为其 GET 会清理过期预留。**

主提取的核对范围：

- 完整需求与当前保存方案的四份任务合同一致，开发 → 独立 QA → 复审 → 经理 DAG 不丢失；QA/复审员工须与开发不同。
- 每次员工调用分别关联固定路由、实际 wire、HTTP 结果、返回用量收据及相同账本 ID，核对模型、员工、任务、token、金额和批准输出上限；不同调用不能合并成一条收据。
- 实际终端命令、退出码、Node 测试计数、local operation 完成与宿主封存的 workspace revision 一致；复审存在实际 pass verdict，经理节点完成并生成验收报告。
- 下载最终文件，计算 SHA/大小；关联员工 `artifact_write` 的完整内容 SHA、工具结果、实际模型 dispatch，再核对上游 producer 输入和最后一次宿主验收输出版本。工具不补写文件、不代员工运行测试。
- 恢复父子保持完整合同、角色、政策、路由、知识及权限，实际 `recovery/restored` 文件须等于父运行下载 SHA，恢复之前不得 dispatch。已完成开发节点新模型调用、命令与重复验收必须都是 **实际核对的 0**。
- 子运行继承父运行调用计数、任务已花费用和保留额；不能重置次数或把旧支出重新变成可用额度。原审批缺省历史仅在已证明第一次正式项目审批时解释，不把未知历史补成 0。
- 固定 `document-versions-v2`、共享与 QA 私有授权、实际 search/read/citation 和 citation GET 版本/SHA/来源指纹保持一致。每次引用保留 run/seq/employee/task，文档 ID 相同不合并不同版本、标题、行号或来源。
- 每项目不超过 $5；根据授权时全量 `baselineUsageIds` 计算所有新增已登记费用，包含尚未归属项目的失败规划，再加新项目及显式捕获的未归属规划预留，不超过 $10。

本地回归脚本为 [fixture helper](../test-evidence/helpers/audit-funded-todo-acceptance-fixture-2026-10-05.mjs)。负例覆盖无收据、403、费用/员工错归属、无真实测试计数、缺本机结果、文件漂移、独有合同缺失、原生开发重跑、错误恢复 SHA、继承预算/次数丢失、仅布尔摘要冒充服务重启、KB 未授权/版本/来源错误、未知规划费用补 0 及非法 API 地址。首次 [35 项回归](../test-evidence/funded-todo-acceptance-extractor-fixture-2026-10-05.json) 与最终证据均保留。

收到真实 ID、运行停止且所有已知调用/操作可核对后，使用以下参数；示例中的大写占位符须替换为真实 UUID：

```powershell
node docs/test-evidence/helpers/audit-funded-todo-acceptance-2026-10-05.mjs --api=http://127.0.0.1:4310/api --normal=NORMAL_PROJECT_UUID:NORMAL_RUN_UUID --recovery=RECOVERY_PROJECT_UUID:PARENT_RUN_UUID:CHILD_RUN_UUID --authorization-evidence=docs/test-evidence/funded-acceptance-approved-intent-2026-10-05.json --unassigned-planning-evidence=docs/test-evidence/ACTUAL_OPERATOR_PLANNING_COSTS.json --restart-evidence=docs/test-evidence/ACTUAL_RESTART_AUDIT.json --output=docs/test-evidence/NEW_FUNDED_AUDIT.json
```

`--unassigned-planning-evidence` 由主代理提供一份真实操作员捕获，结构为 `{checkedAt, authorizationEvidenceSha256, complete:true, receipts:[{id,amount,status,projectId:null}]}`。`authorizationEvidenceSha256` 是授权 JSON 的原始字节 SHA256；status 只能是 `pending/uncertain/settled/released`，该列表须明确涵盖本阶段所有未归属规划收据。helper 只读取该证据，不为获得它调用 `/costs`。存在 pending/uncertain 时保持 **受阻**；缺列表、ID、金额、时间或完整性声明为 **未验证/失败**。现有首次 502 证据仅有聚合 held，不能被伪装成完整收据核对。已结算时保留原收据身份，已用费用仍计入 `/usage`；不会通过清零 original amount 擦除历史。

`--restart-evidence` 必须对应本阶段 parent/run identity，记录实际已验证进程身份的 stop、随后 launch 和实际 native exit，及安全停止、就绪、snapshot/events/budget-history/file/no-automatic-model-restart 等明确检查。复用其他运行 ID 的报告、缺原生退出记录或仅有父子档案都无法通过。工具本身不停止或重启服务。

结果为逐项 `passed/failed/blocked/unverified`，退出码分别为全通过 `0`、失败 `1`、受阻/未验证 `2`。任何缺失结果不补 0；采集窗口账本变化时不宣称完成，应在停止执行后重新使用新证据文件采集。

定价金额来自产品账本及现有缓存计价规则，不是供应方独立账单；公开 API 不提供不可变的规划 wire 原文，也不提供未归属规划预留，后者须保留上面的操作员证据边界。CLI 证据证明执行及对应版本的结果，测试语义/覆盖、真实网页交互、完整备份恢复仍须另有实际证据。SHA 与日志关联无法对任意人为篡改档案作密码学证明。完整 MVP 是否通过由这些独立证据合并判断，不能由本提取器的本地 fixture 或单个预检替代。

最终 helper SHA256：`2f2bd665fd98e18d6aaffb09a817e682c31d56311c5cc6281c6237b71dba7dcb`。本阶段真实 ID 与最终验收报告等待主代理提供；已知费用未知的相同规划路径未重复付费尝试。
