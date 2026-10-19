# 隔离真实规划测试工具复核

2026-10-19。范围为 `scripts/validation/orchestration-planning-pilot/{cases.mjs,broker.mjs,worker.mjs,limits.test.mjs,launch-approved.py}` 和 `docs/validation/orchestration-test-plan-2026-10-19.md`；只读追踪了产品组织规划、模型调用、费用收据、配置和 PGlite 支撑代码。以下行号对应收到复核任务时的版本。协调者正在修复，修复后需重新运行同一复现，不能将本报告视作已通过。

结论：目前应先修复异步收尾和证据校验，再进入真实预算确认；本次没有进行付费、网络、生产进程配置读取或生产写入。没有修改范围内源码或 Git 状态，只新增本复核报告及同目录无外部 I/O 的复现脚本。

## 已确认做对的部分

- 案例资料均为虚构，七次、单次 $0.02、阶段 $0.14、累计 $3.41 的限额进入派发前检查，固定案例顺序及新建输出目录阻止正常入口中的重复派发和目录复用。
- worker 环境由允许清单重新构造，设置新的 PGlite、DATA_DIR、TRACE_ROOT 和 OBSIDIAN_VAULT；模型和网关均从空测试数据库写入，网关 credential 为空。真实调用只经 broker 中既有 `completeBudgeted` 和原账本，不向 worker 传递生产连接或密钥。
- 真正规划路径为产品 `/api/organizations/chat`，没有批准或运行项目；检查 projects/departments 仍为空。文档明确合法预览不代表真实员工执行、恢复或生产网页验收，生产执行门禁不因本轮测试而打开。
- 旧未知费用在派发前计入占用；出错后 `stopped` 拒绝后续请求，没有自动补调用路径。

## 重要问题

### P1：worker 退出会在真实请求和收据写入结束前关闭账本连接

位置：`broker.mjs:30`、`broker.mjs:44`、`broker.mjs:51–52`。

`line` 事件的 async 回调不受主流程等待。worker 因路由超时、异常或信号先退出时，主流程直接核对 after 并 `pool.end()`，当前 `completeBudgeted` 仍可能等待供应方。产品 `completeBudgeted` 在返回时通过 `settleCall`/`markCallUncertain` 再取连接写回执；连接池提前结束会打断这段费用收尾，留下不完整测试证据和待过期的预留。

复现结果：内存替身明确记录 `dispatch → pool.end → provider.return`，同时 broker 输出成功。真实 worker 的内层产品规划超时与 broker 外层供应方超时都是三分钟，内层计时较早开始，因此中断是实际可达路径。

建议：显式保存当前处理 promise，停止接收新请求后等待它及其收据处理完成，再做最终核对和 `pool.end()`；回执错误应保留并报告，不重放模型请求。

### P2：信号/超时退出及未完成轮次可能得到成功退出码

位置：`broker.mjs:27`、`broker.mjs:51–53`。

SIGTERM 后 Node 的 exit code 为 null；`exit.code || report.error ? 1 : 0` 将它当作正常零。计时器只设置 `timeout`，没有使退出失败。worker 在产品返回非 2xx 时也只 break 并正常退出，而 broker 未要求七题全部完成。因此脚本完成状态不可靠。

复现结果：`timeout=true`、`exit={code:null,signal:'SIGTERM'}`，进程 `exitCode=0`。

建议：只有 `exit.code===0`、无 signal/timeout/error 且预期七次均有完整结果时才认为轮次完整；规划内容无效可以作为真实测试失败保存，不能混同“驱动完成”。

### P2：最后一次调用后的未知收据和累计占用只保存，不校验

位置：`broker.mjs:42`、`broker.mjs:52`。

新/变化未知收据只在下一次派发前比较。最后一次调用结束后 `report.after=await totals()` 不检查任何边界；这时没有下一次派发，新增未知或累计超限仍会输出成功。

复现结果：完成七次模拟请求，在最终 `/costs` 快照加入一个新 uncertain 收据，报告包含它但 `exitCode=0`。

建议：最终快照显式比较原未知集合及累计上限，将异常作为测试失败记录。不要删除或释放旧未知收据。

### P2：已结算的付费失败丢失本题实际费用和收据关联

位置：`broker.mjs:43–48`；依据产品 `provider.ts:127–150`、`cost-control.ts:247–260`。

产品会先登记可信 usage，再因输出截断、过滤或格式错误抛错。这种情况下 `completeBudgeted` 不返回 result，broker 条目没有 usageId、Token、实际 cost，只剩 reservation 和顶层错误。原账本费用并没有丢失，但本题测试证据不满足文档“失败也计入、记录每题费用及收据”。

复现结果：模拟结算 `receipt-1`、费用 $0.005 后抛 `MODEL_OUTPUT_TRUNCATED`，最终请求条目的 usageId 为 undefined。

建议：派发时固定可定位的 requestId，在失败收尾只读关联原 model_reservations/usage，保留结算或未知状态与实际金额。关联不到时明确标注未知，不能重试来填证据。

## 验证证据

- `node --test scripts/validation/orchestration-planning-pilot/limits.test.mjs`：2/2 通过。
- `node --test .superpowers/sdd/orchestration-test-2026-10-19/pilot-review-repro.mjs`：4/4 以对应安全断言失败；这就是待修复版本的 RED 证据。该脚本读取实际 broker 源码，以内存对象替代 fetch、spawn、fs 写入、动态生产导入及定时器，没有连接或启动真实服务。
- 协调者另报告 JJ 完整 dry-run 已七次请求、零真实模型调用、零项目/部门写入；本复核未独立运行该 JJ 测试，不以转述代替复核证据。

## 保留的限制与不评价事项

- `/usage` 和 `/costs` 是两次独立读取；它们不是同一数据库快照，累计检查与 `completeBudgeted` 预留也不是同一原子事务。本工具只在无并发生产变动的测试前提下支持累计边界核对，不能声称新增了全局原子累计预算锁。现有每日预算仍由原收据路径负责。
- `report.before` 是启动时快照；当前代码没有固定此前六笔未知的身份清单。正式启动前应按本轮批准基线复核，不能把新增未知自动当作旧未知。
- 新建目录阻止正常启动入口复用输出，未把“操作人主动删除/改名目录或改命令再运行”视作本次产品安全边界；没有引入新的通用授权或插件引擎。
- worker 是最小环境的同用户进程，不是操作系统权限沙箱；本轮只调用固定产品规划路径，不运行模型产出的代码，未把它宣传成恶意进程无法读取宿主文件的隔离。
- 未评价真实模型方案质量、七种模板实际执行/重启恢复、生产门禁放行条件、供应方最终账单真实性；这些均不由无付费复核证明。

## 修复后的限定复核（2026-10-19）

本节更新前述四项问题的当前状态。只读取修改后的 broker、复制出的 lifecycle 测试及已保存的 RED/GREEN 日志；依照协调者要求没有重复运行测试、访问网络、调用真实模型或读取生产进程配置。

| 原问题 | 结论 | 代码与证据 |
| --- | --- | --- |
| P1：未等待当前请求就关闭账本连接 | **ADDRESSED** | `broker.mjs:61–66` 跟踪 activeHandlers，worker 退出后停止接受请求并等待已有处理完成；`pool.end()` 位于最终核对及报告保存之后（75行）。原次序断言现已通过。 |
| P2：信号、超时及不完整轮次误报成功 | **ADDRESSED** | `broker.mjs:73–76` 要求 code===0、无 signal/timeout、请求数为7且每次有 returnedAt，异常进入 report.error 并产生非零退出码。原 timeout 断言现已通过；未完成轮次由源码条件直接覆盖。 |
| P2：最终未知收据和费用缺少校验 | **ADDRESSED** | `broker.mjs:69–71` 将最终 holds 与原快照作完整比较，并检查累计占用及本轮实际费用/保留预留。最终新 unknown 的原断言现已通过。 |
| P2：付费失败缺少原账本关联 | **ADDRESSED** | `broker.mjs:43–44` 为每次请求生成 requestId 并写入既有调用 context；`finally` 的52–56行按该ID只读连接原预留和usage，保存收据、状态、Token及实际cost，pending/uncertain继续失败且不重放。先结算后截断的原断言现已通过。 |

核对的 `pilot-lifecycle-red.log` 为4项预期断言失败；`pilot-lifecycle-green.log` 为相同4项全部通过。`scripts/validation/orchestration-planning-pilot/lifecycle.test.mjs` 与 ignored 目录复现文件的 SHA256 均为 `e154c1734a3157787f990ccd9b06f3d3911b8042ea20ff1251814116d04c13f7`。测试只补充 requestId 与 fake pool.query 的依赖替身，原四项断言保持不变。

本地 `docs/validation/evidence/orchestration-jj-tests-2026-10-19/planning-results.json` 包含七个HTTP 200、零候选预览，与 dry-run 固定回复相符。协调者报告第二次完整 JJ dry-run 退出0、七次请求、零真实调用及零项目/部门写入；本限定复核未访问JJ，也未在当前本地证据中看到该次完整 broker退出汇总，故不将后者写成独立核验结果。

限定结论：前述四项阻塞已处理，可继续准备具体真实规划授权。此前的非原子累计检查/无并发假设、启动时复核原六笔未知、尚无真实规划与执行验收等限制仍保留；本结论本身不授予付费或生产配置读取权限。
