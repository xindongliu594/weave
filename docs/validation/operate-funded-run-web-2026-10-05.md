# 两份新增验收项目的网页操作工具

2026-10-05：只准备工具并完成本地工程回归，尚未执行实际 Edge 操作、发送模型请求或创建真实运行。没有修改产品源码、原数据库、员工交付文件或旧验收工具。

[新工具](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/operate-funded-run-web-2026-10-05.mjs) SHA256：`6cec0f82df67546c0a165c7c8720c3495bf586bd34b39170555cf300a5f257f2`。

[最终本地证据](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/operate-funded-run-web-fixture-readonly-final-2026-10-05.json)：47/47 通过；`node --check` 通过。覆盖新费用与全部预留、两项目额度合计、未归属规划费用归属、原项目排除、缺失金额拒绝、审批/员工/任务/权限/attempt 绑定、已批准和已继承任务拒绝重放、两种真实执行器的工作区摘要算法、并发只允许一次 POST。以上是本地 fixture 回归，不能作为真实员工或网页验收证据。

## 用法

从 workspace 根目录运行，每个参数使用唯一的 `--name=value`。真实项目 ID、版本和成功网页确认报告必须来自当前两份新增验收项目；工具不生成或拼写计划。

```powershell
node docs/test-evidence/helpers/operate-funded-run-web-2026-10-05.mjs inspect --scenario=normal --normal-project-id=<真实UUID> --version=<实际版本> --confirmed-evidence=docs/test-evidence/<成功confirm报告>.json
```

如果两项目都已创建，每次必须同时传入 `--normal-project-id` 和 `--recovery-project-id`；只有正常项目已创建时，可以暂不传恢复项目 ID。修改 action 即可进行具体操作：

- `inspect`：查看项目或指定 `--run-id` 的运行。只读 GET 和网页，不提交 POST；避开会进行预留过期维护的 `/costs`。项目 cost-readiness 是实际数据，全阶段未归属预留与总额度仍标未验证。
- `approve` / `start`：两者均点击实际网页“批准并运行”，共用一次项目/版本意图回执。当前产品没有另一个独立 start 步骤。
- `command --run-id=<UUID> --command-id=<待批审批UUID>`：只批准这一待批员工工具请求。要求当前恰好一条 pending、实际归档请求与页面参数完全一致，并绑定该员工、任务、原 verify 合同、attempt、文件摘要。仅允许 `node --test todo.test.mjs`、`node --test acceptance.test.mjs`，或合同允许的这两文件合并命令；不接受路径别名、附加 flags、shell 拼接、额外参数或已完成任务。
- `resume --run-id=<准确父UUID>`：先点击“检查恢复条件”，再点击“恢复未完成任务”；不选择全量重试，不认可结果不明的 native 操作。若存在项目未知费用，须额外显式传入 `--retain-uncertain-costs=true`，继续扣住原预留；没有项目未知费用时不要传 true。

默认网页为 `http://127.0.0.1:4310/`。可使用 `--base-url` 指定无凭据的 loopback 网页原点；默认授权基线为 [approved-intent](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/funded-acceptance-approved-intent-2026-10-05.json)，归属账单为 `.data/funded-acceptance/budget-ledger.json`。可用 `--authorization-evidence` / `--budget-ledger` 指定同一 workspace 的验收 JSON，不能访问任意凭据路径。

## 实际操作门禁与留证

正式动作前及唯一 POST 放行前重读费用。新增已记账费用加所有新增 pending/uncertain 预留不得超过 $10；每项目 cap 不得超过 $5，且两项目 cap 加未归属规划费用/预留不得超过 $10。本场景未归属规划费用和未知预留须额外扣减该项目 cap。旧规划未知 `$0.37821` 不会自动置零或解除；例如 `4.62179` 还必须进一步减去未归属的已结算规划费用。缺失、重复或未归属记录均拒绝放行。

冻结时主代理报告：正常路径两笔未知预留 `$0.37821 + $0.38209`，候选 cap 为 `4.23970`；恢复路径上一轮孤立规划费用 `$0.22511`，修订候选 cap 为 `4.77489`。这不是本工具的实时 GET 验证，尚无正式新 project/run ID；执行时仍须重新核对完整账本，不能将这些金额写成固定许可或用回旧候选上限。

正式动作使用现有产品 GET `/costs` 的预留过期维护；它可能把到期 pending 保留为 uncertain，工具不执行结算、账单查询、预算提高或释放费用。原 v6 版本、cap、cost-readiness、原 usage 及 open receipt 摘要前后必须一致。只读 inspect 不查询此维护接口；不据此声称已核对所有全局 receipt history。

运行列表没有 project/version/parent 字段；工具另读本阶段运行详情，拒绝凭列表概要猜归属。恢复即使导航导致 HTTP 正文丢失，也必须由新 URL、GET 新运行身份、snapshot.approval 和精确 parent ID 共同核对；绝不重复 POST。queued 运行归档暂未创建会单独标 unavailable，不捏造零节点或员工成功。

每次操作生成唯一 `docs/test-evidence/funded-run-web-<scenario-action-time-random>.json` 和 `screenshots/funded-run-web-<...>.png`，记录实际 POST、安全响应摘要、新 run ID、成本/净额、失败和网页截图。运行错误正文仅保存摘要 SHA/长度，不保存供应方原文或 credentials。网页文本和截图仅用于真实页面留证。

`.data/funded-acceptance/web-operation-guards/` 下保留项目/版本 start、父 run resume、具体 approval command 的不可覆盖意图回执；无论超时或失败，都先 inspect 和核对回执，不能自动重发。并发 project lock 只移除本进程自己的锁，永久意图回执不删除。

网页 202 和 GET 身份只证明创建关联；审批回执只证明批准，均不证明模型、测试、复审或经理成功。真实员工完成、断点继承、文件 SHA、固定 KB 引用和全阶段费用仍由 [独立真实验收提取器](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/audit-funded-todo-acceptance-2026-10-05.mjs) 检查。工具本身不运行员工 QA 命令、不写交付物，不能替代真实验收。
