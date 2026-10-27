# 新验收项目：受控停止工具准备

仅新增 [stop-funded-run-web-2026-10-05.mjs](../test-evidence/helpers/stop-funded-run-web-2026-10-05.mjs)。冻结的 `operate-funded-run-web-2026-10-05.mjs` 未修改，SHA256 仍为 `6cec0f82df67546c0a165c7c8720c3495bf586bd34b39170555cf300a5f257f2`。

目标为已真实确认的恢复项目 `3e101c24-87e6-43ea-80f9-a2c4b0b410f4`、部门 `f16bb7ee-6868-417d-a9c6-9229d7fa7339`。确认来源为 [funded-recovery-confirm-2026-10-05T12-30-00-700Z-6093fcc2.json](../test-evidence/funded-recovery-confirm-2026-10-05T12-30-00-700Z-6093fcc2.json)。本次没有访问运行中的 API、打开原数据库、执行员工测试、写员工文件、停止服务或请求真实模型。

执行时必须给出准确的原父运行、QA 当前待批请求和已批准方案版本：

```powershell
node docs/test-evidence/helpers/stop-funded-run-web-2026-10-05.mjs --run-id=<父运行UUID> --command-id=<当前QA待批UUID> --version=<方案版本>
```

如果另一份正常验收项目也已经创建，必须另加 `--normal-project-id=<正常项目UUID>`。工具不会自动选择新项目、运行或待批请求。当前没有填入真实运行 ID，也没有执行以上操作。

停止前，工具通过产品 API 和实际员工文件 HTTP 下载共同确认：

- 原始人工批准运行属于准确项目、部门、版本，完整档案序号连续、完整性通过，四节点合同保留。
- 开发节点真实 `completed`，相同 attempt 有宿主 `handoff/accepted`、真实命令观察、完整且通过的 Node 测试摘要以及匹配的本机执行回执。三个开发产物的下载 SHA 与封存 SHA 一致。之后 QA 新增文件不要求与开发当时整个工作区 revision 相同。
- QA 尚未完成，正等待唯一的 `terminal_test` 请求。精确命令属于 QA 合同并由独立员工发出，审批参数和当前工作区 revision 一致。
- 所有已派发模型 wire 以 `usageId` 对应真实已结算用量，不拿 requestId 代替费用身份。目标项目无待定费用；环境中没有 pending 模型保留额或 querying 对账。旧项目未知预留允许存在且保留。
- 待批 QA 操作没有 `runtime/operation-start`、本机队列或本机记录。历史已完成操作允许存在；活跃、失败、结果不明、迟到含混回执均拒绝。
- 新阶段已结算费用加全部新未知预留不超过 $10；每项目上限不超过 $5，并扣除本场景未归属规划费用/未知保留额。原 v6 的版本、上限和未知收据保持不变。

实际 Edge 页必须显示准确 Run ID 和待批参数。工具只允许一次 `{}` 的 `/runs/<id>/cancel` POST；其他网页 mutation 均阻止。提交前重新检查全部边界，落盘一次性意图防止重放，再点击真实“停止运行”。**产品 GET `/costs` 自带过期维护，因此这项实际停止操作不描述为纯只读审计。** 不调用对账、结算、启动、恢复或审批 mutation。

停止后等待真实取消及审批取消，保存唯一命名的完整 before/after API 观察、档案、DAG、调用、费用历史、本机状态、下载文件 SHA、事件增量和两张截图。必须证明原快照、开发封存、完成节点、所有文件、已结算用量、原未知收据历史保持一致，没有新模型或本机操作；网页显示“已取消”且停止按钮消失。HTTP 返回丢失时只从准确原父 GET 核实结果，不再次提交。不完整或不一致的证据标失败，不能声称安全中断成功。

当前工程证据为 [funded-stop-web-guard-fixture-2026-10-05T12-57-01-253Z-d79444a3.json](../test-evidence/funded-stop-web-guard-fixture-2026-10-05T12-57-01-253Z-d79444a3.json)：35/35 PASS，`node --check` 通过。覆盖旧项目/子运行、缺失档案/开发封存/真实测试、SHA 变化、QA 已完成、多个审批、命令注入、过期 revision、pending/unknown/querying 费用、未结算 wire、未知/已开始本机操作、取消后的账本/文件/历史变化以及一次性 POST。初次 fixture 由于测试对象把审批行和历史事件共享引用而失败；已修正 fixture 引用，初始失败文件保留，不改变真实守卫规则。

工具 SHA256：`46b9bc88738e73f600db9862e83127c0079934e3f756019fafeb346ff496f6fe`。这些是纯本地守卫测试，**实际受控中断、服务重启后恢复、开发不重跑和 QA/经理完成仍未验证**；停止成功也不代表其余验收链通过。
