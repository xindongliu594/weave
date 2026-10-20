# 已验收任务停止：产品调用链验收

当前状态：本批本地产品调用链通过，最终独立复审、匹配产品验证与构建已完成。此报告不认证 Task5、Task6 或企业能力整体完成；任务 profile 仍关闭。

## 本批修改

延续设备停止基础 `50826ad` 和 SQL 准入保护 `2b9ad11`，在现有 LocalRunExecutor、RunCoordinator 和应用的延迟维护 provider 之间接通私有停止调用链。新任务首次准备前，只有已完成、已通过宿主验收、持久 v2 检查点和原 SQL 提交链均完整的原任务，才能取得一次新的停止派发资格。

原操作 claim、完整任务/员工/会话/设备绑定、原始结果与合并摘要、固定输入和输出对象都分别验真。A 的旧部分工作版本与 B 后来提交的完整项目版本分开验证。最后等待点后的相关档案与对象复核仍复用原格式和摘要算法，不把无关进度更新视为权限变更。

停止沿原维护队列、SQL CAS 和设备 journal；prepared/dispatching 的 COMMIT 应答不明不授予第二次派发。可信 provider 的执行器、设备/授权/指纹及方法引用固定。已有停止意图在冷 bind 前仅查询原 sandboxId；即使业务取消或 lease 转移，也可补记已发生的匹配停止事实，随后普通执行仍须通过原权限检查。缺维护 provider 的 task 路径明确阻断；旧 profile 与旧构造类型保持兼容。

本批没有公开停止/核对路由，没有改变费用和审批，也没有自动删除文件、提高两槽/128 scope/磁盘上限，或开放恢复 profile。

## 证据与验证状态

[有界产品证据](evidence/accepted-task-stop-product-2026-10-20/README.md) 分别记录旧第三槽容量 RED、实际产品工程链、明确退出状态、源码 SHA 和进程异常；[API证据](evidence/accepted-task-stop-api-2026-10-20/README.md) 保存实际故障注入、相关回归和独立复审。实际 ProductDshRuntime、Host、Handoff、HTTP claim/start/result、SQL canonical CAS、设备 executor/journal/容量门禁及文件/Node 测试运行；模型选择、CLI、网关/mTLS、UID/cgroup 是工程夹具。没有用这些夹具冒充真实模型或物理 OpenShell 验收。

| 检查 | 当前结果 |
| --- | --- |
| 修前真实第三 prepare | 两员工验收后，经理第三 prepare 命中原两槽限制；零 accepted-stop，证据保留 |
| `cd98427b` 历史三场景 | 正常、A旧部分版本/B新完整版本、停止应答丢失后冷核对分别通过；每场景起止 16 文件 SHA 相同，退出0 |
| `79ba4d74` 最终三场景 | 各1项通过、0失败/跳过、退出0；进程耗时70.036/93.121/27.254秒，16份源码起止一致 |
| scope 相关回归 | 独立直接执行25/25、0跳过、退出0；没有额外外层 PGlite/socket |
| 最终相关同步证明修复 | 9项实际行为RED后，完整delivery39/39、0跳过、退出0；独立综合复审PASS |
| 其他相关回归 | checkpoint20、bridge11、readers9、HTTP3均通过；详见原逐文件报告，未将其后的scope崩溃算成通过 |
| 类型检查与构建 | 最终源码执行`npm run build`退出0（先tsc后Vite，Vite16.44秒）；有大于500kB的既有bundle提示 |

开发 A、独立 QA B 和经理 C 在产品用例中各有不同 key/attempt/sandbox，均实际准备工作区、读写文件、运行 Node 测试并由宿主验收。SQL 没有预填成功 scope/merge/accepted/checkpoint。已有正常历史例有19笔真实 fixture SQL 操作；交错和应答丢失用例分别24、6笔，详见摘要。

最终工程运行ID（隔离测试，不是JJ生产运行）：

| 场景 | Run ID | 完整摘要 |
| --- | --- | --- |
| 正常 | `7dc9023a-976c-4ab3-9d1e-814c80c5dc6d` | [normal](evidence/accepted-task-stop-product-2026-10-20/final-79ba4d74/normal-summary.json) |
| A/B交错版本 | `8b23b754-a963-4d39-8aaa-bbdc39cc27b9` | [interleave](evidence/accepted-task-stop-product-2026-10-20/final-79ba4d74/interleave-summary.json) |
| 应答丢失/冷核对 | `b20a83cf-48d2-45f2-b26e-68b33ff89989` | [loss](evidence/accepted-task-stop-product-2026-10-20/final-79ba4d74/loss-summary.json) |

从项目根目录可使用原隔离 runner 逐场景复现功能；每条命令独立启动数据库，避免同时运行多个重测试。证据中的私有 wrapper 另外记录进程退出、起止 SHA 和有界超时，不改变测试/产品行为。

```powershell
node scripts/test-integration.mjs tests/task-accepted-stop-delivery.test.ts
node --import tsx --test --test-concurrency=1 tests/task-execution-scope.test.ts
node scripts/test-integration.mjs '--test-name-pattern=three distinct product tasks' tests/task-accepted-stop-product-flow.test.ts
node scripts/test-integration.mjs '--test-name-pattern=historical partial' tests/task-accepted-stop-product-flow.test.ts
node scripts/test-integration.mjs '--test-name-pattern=lost accepted stop' tests/task-accepted-stop-product-flow.test.ts
npm run build
```

## 已保留的失败与未完成项

- 旧聚合 API 回归的 scope 文件出现两条 `Fatal process out of memory: Zone`；该整批没有记为通过。后续单独 scope25通过，不据此推断先前内存错误原因。
- 旧产品整文件在185.193秒发生进程级失败，原 wrapper 未保留具体 worker exit/signal，原因未明。另有仅109字节 TAP header、没有最终退出的中断尝试，也没有记为通过。后续独立场景功能通过不等于同进程长期稳定性通过。
- 最后经理 C 的已验收沙箱仍可能占用运行名额；跨项目最终停止、网页待核对提示/入口和连续三项目容量验证是下一冻结批次：[最终收尾计划](../superpowers/plans/2026-10-20-task-stop-finalization.md)。确认停止只释放 running slot，文件、scope 和磁盘预留继续保留。
- Task5 的恢复来源、精确任务维护、只读备份承载，以及 Task6 原生 PostgreSQL/物理 JJ/OpenShell/真实模型与浏览器，均仍需实际验收。全十项企业基础能力按总计划继续。

本批新增付费模型调用0、安装0、JJ生产写入/部署0；原累计$3.41、旧权限、账本和七笔未知费用预留保留。先前只读 JJ 健康检查正常，不能当成本批已部署的证据。
