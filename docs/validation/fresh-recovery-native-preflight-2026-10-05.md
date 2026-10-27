# 原 v6：新建恢复主机的零费用请求预检（2026-10-05）

结论：**当前 compact 恢复首包能 prepare，但不能据此批准一次盲目的付费恢复。** 原生 claim 后的余量很小；本次审计驱动四文件读取后，完整证据的下一请求即使此前费用为零也被预算拒绝。没有真实模型调用、员工测试或经理验收。

可追溯材料：[新 helper](../test-evidence/helpers/preflight-fresh-recovery-native-2026-10-05.mjs)、[本次完整 JSON](../test-evidence/fresh-recovery-native-preflight-compact-fresh-with-readonly-results-2026-10-05.json)。旧失败和旧 capture 保留；本次没有重执行旧 mutation helper。

## 原账本与恢复输入

- 原项目：`dde78f91-2a99-4a63-a9fa-5cb7bab2b8f0`，批准 v6，cap **$0.48**。
- 原停止运行：`5114bb4f-7ac4-413d-a80f-aceeace8bdec`，档案 integrity=ok。公开 GET 前后 recorded **$0.3664174**、unknown holds **$0.0278694**、net **$0.0857132**，pending=0、uncertain=2；`/usage` 完整结果也相同。
- 同版本原历史 20 次加本运行真实 1 次，共 **21/37**，余 16 次。QA 原 $0.068018/3 次加本运行已结算 $0.015542/1 次，得 **$0.08356/4 次**；未把准备请求当新调用。两个 unknown 全局占用保留。对应同版本旧 wire 没有 taskId，未凭猜测分摊到 QA。
- 使用实际 `completedTasks/checkpointTasks/resumeHandoff/buildCheckpointContext`，开发 completed 检查点与原验收版本恢复；四文件 SHA 实际读取并核对。临时主机实际调用 `stageApprovedTeam → bindTaskMapping → restoreCheckpoints → approve`，并使用带宿主断言的 `teamTaskPlan(hostContext:true)`。批准、native team 和 session 都只写入 workspace `.data` 新随机隔离目录。
- 使用原 Luna/Sol 模型 ID、费率和合同；Sol **1400 输出上限**不变。所有 route 的传输地址替换为 audit.invalid，Key 为空；没有读取凭据或执行 device grant。

## 实际捕获结果

预留仍用当前生产算法：`((UTF-8 JSON({messages,tools}) 字节 + 1024) × inputRate + 1400 × outputRate) / 1e6`。Sol inputRate=2、outputRate=10；没有缩短正文、工具 schema、输出或费率。

| 原生阶段 | 受保护最低 envelope | 最低预留 | 相对原净额 | prepare |
| --- | ---: | ---: | ---: | --- |
| 真正入场后的新 QA 首包 | 29,474 B | $0.074996 | 余 $0.0107172 | 允许；只 prepare，未 dispatch |
| 审计指定 native claim 的真实回执之后 | 32,358 B | $0.080764 | 余 $0.0049492 | 允许，但此前没有实际付费 |
| 审计指定四文件读取的真实结果之后 | 53,430 B | $0.122908 | 缺 $0.0371948 | 拒绝：BUDGET_CONTEXT_LIMIT |

第一包 system JSON 为 8,281 B，native user snapshot 为 14,769 B；department section 为 13,723 B。工具仍为实际获授权的 10 项，当前 wire schema JSON 6,399 B；没有按旧归档 6,089 B 人工替换。compact claim 的真实 task_details 为 **2,445 B**，已经减少旧重复需求。四文件内容共 18,596 原始字节，按实际 JSON 工具渲染进入 native 会话；没有用文件名或摘要替代正文。

第三包精简前 envelope 64,809 B/$0.145666；当前生产保护规则移除可删旧组后仍最低 53,430 B。四文件读结果没有可合并的重复证据，source-attested duplicate groups=0；不能把它们按重复组删去。

第二阶段只容纳此前累计费用 **≤$0.0049492**。若首轮再产生原上一轮已观察的 $0.015542，下一阶段至少差 **$0.0105928**；这是历史费用敏感性，不是预测新模型一定收费该数。第三阶段即使前两轮完全免费也失败，所以“首包允许”不足以证明这条四文件路径可继续。

## 证据与安全检查

adapter `stream` 被审计边界替换为 `prepareRequest` 后等待 abort，**没有调用其原传输**。后两步 tool-call 决策由审计固定生成：只用于观察 native claim 及获授权 filesystem 的真实渲染，不是模型回答，也没有伪造 usage、settlement、员工交付或测试成功。

三个阶段的当前需求、完整合同和任务范围、recovery 与实际四 SHA 均精确相等；第一/第二阶段的原生持久化 session、trace、prepare body 保存相同 department 文本。第三阶段有持久化 session/trace 一致证明，但没有可发送 body。预算反馈保持原占用与调用数，因为本实验没有实际花费；不能把不变反馈冒充真实多轮结算。

本次实际断言通过：模型/外网 fetch=0、receipt=0、reserve=0、counter change=0、预算回调=0；唯一共享 budget 状态始终相同；开发没有再次进入模型请求；原 snapshot.json/events.jsonl 的原始 SHA、两个费用相关旧档案的 SHA、四文件 SHA、公开费用/usage 结果前后相同。没有直连或打开原数据库；公开 GET 内部正常读取产品数据库不属于本脚本直连。

主要当前源码 SHA（19 个文件的完整记录见 JSON，阶段内全部一致）：

- host.mjs：`c3663e14969f1daaafa32d8bffaf2d7f102acf2c8eb9998cb5c7fba098816fe3`
- employee-hosts.mjs：`4465d26a2dcb1afb0a1d6af371c9e8aa1e033c0088f65ac3b405861be097ce84`
- openai-compatible.mjs：`296bb0aa8c8a33a7aac8b4955d32371cd310836e2b1e9a02b8412ff6370d4876`
- request-context.mjs：`6c92e017b13c5a13d2445a287bb13229edf1f0d1126a754b46baf9a59e56b476`
- handoff.mjs：`3ac6a06abc854b6073b2ed236a6c58564716e9cc823e5c13fd08c51d067a2787`

## 判断与限制

应继续做零费用的产品限定优化/预检，或如实停止该受阻路径；**不建议只凭首包过门禁就再花原余额测试恢复**。本次四文件路径已具体受阻，但不能据一条审计选定的工具序列宣称所有可能 QA 策略都不可行。完整 QA→复审→经理仍未证明有安全预算路径。

本地 filesystem wrapper 保留完整文件与 LocalRunExecutor 可见字段，但没有启动实际 device/DB 队列；scratch cwd/localWorkspace 长度与生产可能不同。单次 prepare 不是未来 reservation ticket，也不替代产品恢复 API 的授权、daily budget、原子锁和供应方账单检查；它验证的是当前源码下原生入场输入的可行性。

运行命令（再次执行须换 phase，避免覆盖现有证据）：

```powershell
node docs/test-evidence/helpers/preflight-fresh-recovery-native-2026-10-05.mjs --phase=compact-fresh-with-readonly-results --dry-run-reads
```

本次命令 exit=0，语法检查 exit=0。没有将本地工具 dry-run 标成真实模型、独立 QA 或经理完成。
