# 恢复后经理验收与真实测试展示修复

状态：本地实现、回归、构建及真实捕获档案离线核对通过；生产部署和浏览器验证另由主任务完成，本文不代替部署验收。

## 实际问题

最终恢复运行 `19acad23-c885-40cc-9fa7-df7d7ec127bf` 已完成，只执行 T3，保留 T1/T2。恢复上下文每次将 `historyRunId` 写为直接父运行，但 T1 的实际交接凭据来自祖先 `15c79ce8-58cc-48df-93e6-11b8f54d21f3`。网页原先只允许直接父运行或该 history 字段，因而将完整经理验收退回“运行原始回复”。测试卡只读取当前运行操作，也遗漏了父运行 `7da3c44b-d8fa-4b0e-9c15-e9130ed0772a` 的实际 QA 回执。

## 最小修复

- 增加只读 `GET /api/runs/:id/lineage-evidence`，沿封存的 `recovery.sourceRunId` 查询，不使用标题、员工摘要或任意客户端来源参数。
- 最多 16 层祖先，累计读取档案最多 64 MiB。当前与祖先必须档案完整、同项目、同方案版本、同批准任务合同；缺失、损坏、循环或超限明确返回 unavailable。
- 每一跳都核对恢复 completed 的同一 attempt、对应宿主交接凭据与 accepted 文件 SHA/大小，最后找到原来源档案的唯一 `handoff/accepted` 及已完成任务状态。经理结果仍需全 DAG 原有输入/输出及生产者版本检查。
- 历史测试另核对原来源的 command-observed、queued/finished 序号，run、task、attempt、agent、session、call、approval、operation 身份，以及真实数据库操作 completed/started/ok、命令、退出码、完整输出字节与哈希。操作的 expectedWorkspaceRevision、命令观察与交接 workspaceRevision 必须为相同 SHA256。取消、迟到、缺失、错误身份、错误工作区版本或输出截断不生成测试卡。文件交接通过与命令证据缺失分别报告。
- 仅返回凭据和必要操作输出，不发送原始模型上下文。网页仅在运行或状态改变、手动刷新时读取一次；不接入每两秒审批轮询。
- 显示“恢复沿用的已核验交接”和“恢复沿用的真实测试结果”，列出原来源运行、任务尝试与观察序号，明确恢复后未重跑。原始协调回复仍保留，既有恢复确认框不变。

## 已运行检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| API / 证据边界 / UI / 原恢复交互 | 44/44，零失败、零跳过 | [完整本地输出](run-lineage-regression-v2-2026-10-09.txt) |
| 全仓类型检查 | exit 0 | [类型检查](run-lineage-types-v2-2026-10-09.txt) |
| 网页构建 | exit 0；567.12 kB 大块提示保留 | [构建输出](run-lineage-build-v2-2026-10-09.txt) |
| 真实三代档案离线核对 | verified，经理结果 accepted-manager | [不含上下文正文的核对结果](run-lineage-actual-replay-2026-10-09.json) |

真实档案核对得到：T1 原交接 #497，T2 原交接 #2248；QA 操作 `ac15d4f2-d455-45ae-85de-44b8c19cde0d`、观察 #2099、10/10 测试通过；T3 经理原交接 #260。没有生成新交付文件、没有重跑员工、没有调用模型，也未修改原始运行记录。输出哈希与来源导出哈希在上述 JSON 中保留；经理原文和测试正文没有复制到公开报告。

固定响应只用于隔离的 API/UI 回归。真实核对读取此前真实运行的捕获档案与操作回执，不将本地回归视为真实模型验收。

独立审阅发现初版遗漏真实操作的工作区版本绑定，并用真实捕获数据的内存副本复现。修复后独立复查确认：原样数据仍 verified；缺失版本和错误版本均返回 partial / COMMAND_UNAVAILABLE，隐藏 QA 通过卡。前后结果保存在 [独立边界核对](run-lineage-independent-workspace-review-2026-10-09.json)，初版冻结清单和检查输出保留。该校验沿用历史原始凭据，并不声称重新执行测试或提供密码学防篡改。

冻结源码：[10 文件 SHA 清单](run-lineage-sourceSHA-2026-10-09.json)。构建 JS 为 `index--tuIbT-R.js`，CSS 为 `index-CzCbk_YO.css`。

## 生产表类型差异修正

JJ4 发布后的首次真实 GET 返回 partial，T1/T2 都为 COMMAND_UNAVAILABLE。定位为本接口 SQL 将操作 ID 数组强制转为 uuid[]，而现有迁移将 local_operations.id 存为 text；操作查询发生类型错误。初版隔离测试把该列建成 uuid，未能暴露此差异。

已将隔离测试改为与生产一致的 text 列，先确认相同 partial 失败，再将 SQL 数组类型改为 text[]。没有更改证据规则、来源链或工作区版本限制。精准 API 回归 5/5 通过，含跨运行、工作区版本错误/缺失、档案损坏及上限反例。SQL 字符串一处变动没有重复运行已通过的网页构建与全套回归。

- [修复前完整输出](run-lineage-sql-schema-red-2026-10-09.txt)
- [修复后完整输出](run-lineage-sql-schema-green-2026-10-09.txt)
- [两文件热修复冻结清单](run-lineage-sql-hotfix-sourceSHA-2026-10-09.json)

原 JJ4 冻结清单与发布证据保留。热修复的生产部署、一次重启及真实 GET 由主任务独立核验，本段不将隔离测试算作生产通过。

## 边界与限制

该接口展示历史已核验结果，不替代当前执行，不申请或复用旧审批。超过读取上限或证据残缺时保留原始运行回复并显示核对原因，不猜测通过。后续人工修改文件不被当作旧测试重新验证；测试卡始终标明其对应的验收版本与来源运行。
