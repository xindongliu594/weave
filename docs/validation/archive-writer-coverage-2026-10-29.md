# 档案 writer 覆盖审查（2026-10-29）

审查基线：HEAD `417b46e5510ab72203d722292e46e1e9b9322b77` 加当前未提交成果。只读生产代码，未部署、未提交、未运行模型或重型测试。本报告是 Task 4 接线审查输入，**不是可信 source 认证或恢复开放证明**。行号按审查时工作树；其他工作正在并行进行，接线前须复核。

2026-10-30 修复追记：A1 已接入同一应用 manager 的完整账单查询 writer，A2 已把新诊断写入移到档案根同级目录；低层 Checkpoint 提前 mkdir 也已移交既有对象入口。本文下面保留原审查时的缺口与行号，最新验证见 [并行收口报告](checkpoint-parallel-2026-10-30.md)。这不改变本报告并非可信来源认证的边界。

## 先处理的确定缺口

### A1：运行收据的账单查询没有覆盖完整 native 生命周期

- 入口：`apps/api/src/cost-router.ts:63–64` 的手动查询，以及 `provider-reconciliation.ts:177` 的后台查询，均进入 `queryProviderForCall`（`:83`）。应用在 `app.ts:124` 无 writer 参数构造后台服务，`:218` 同样挂载无 writer 参数的 cost router。
- 调用链：`queryProviderForCall` → `receiptTransaction` claim（`:85–122`）→ `queryNewApiBilling`（`:144`）→ `settleCall`（`:151`）→ save 的另一个 `receiptTransaction`（`:123–138`）。`cost-control.ts:209` 的 shared `918275` 只随每个事务存在，函数没有 native owner、withWriter 或 retain。
- 后果：claim 提交后、外部查询尚未结束时，run 的 native source 可以成功取得；此前已准入的生产者随后还能提交费用/查询历史。source 若一直持有 exclusive `918275`，这些后续 SQL 会排队，因此这不是“SQL 绕过 exclusive gate”；但它确实不满足计划 Task 2c 明确要求的“账单查询 claim→外部查询→settle/save 完整生命周期”，不能据 native guard 宣称生产者已排空。费用字段仍须在初始化时重新核对。
- 最小修法：向 app 的后台服务和 cost router 注入同一个 manager；先无锁发现收据的不可变 run identity，再在任何 SQL 锁之前取得该 run 的 writer，并在事务内重查 identity，让同一个 owner 跨越 claim、原始外部请求及 settle/save。无 run 的规划/组织收据继续走 SQL shared gate；不枚举同中转站所有 run，不扩大已有费用业务。不能只给 save 套新 writer，也不能在已持 project/receipt 锁时获取 native。
- 所需验收：真实暂停外部查询响应，另一进程 source 获取应失败；释放原响应、settle/save 完成后才可成功。覆盖手动/后台、无 run、已结算快速返回、原始 SQL COMMIT 丢应答与失败锁存，不重复模型或账单业务请求。

### A2：规划诊断直接写 traceRoot 子目录，缺少 root 协议（与 A1 分级）

`app.ts:685` 异常处理中调用 `project-planning.ts:23–25` 的 `recordPlanningOutputDiagnostic`，直接在 `traceRoot/planning-output-diagnostics` mkdir/writeFile，未经过 writer/root 作用域。与 `backup-restore-state.ts:99` 的 traceRoot rename/swap 可以交错。该目录不是 run snapshot、事件、SHA 对象或 canonical，因此**不作为 run source 固定失败的证据**；它是根目录整体备份/交换覆盖缺口。优先把此诊断写到已配置、与 traceRoot/lockRoot 不重叠的独立诊断目录；如保留根内则需同一 root gate 的明确非 run 生产者合同，不随意造 UUID run 锁。需暂停诊断写入对照 root swap/备份验证。

## 覆盖矩阵

记号：N=原生 root shared→按 run 排序的 lifetime shared；M=run maintenance exclusive；R=root exclusive；S=事务 shared `918275`；P=project→run 行锁。未列 S 不代表缺陷：已有 N/P 可按计划保护普通运行 writer；跨项目纯 SQL 批量写入则必须 S。所有 native 获取应在 SQL 锁之前；journal 是 SQL/N 之后的短同步锁。

| 入口及实际写入 | native / SQL / 锁序 | 原 COMMIT/ROLLBACK 与文件尾部 | 审查结论与锚点 |
| --- | --- | --- | --- |
| app 启动根登记、协调器注入 | 唯一 manager，注册根；不构造每次 append 私有 manager | 根登记先于路由/运行 | 已见：`app.ts:116–124`；原始离线未登记根兼容不计生产保障 |
| app 批准并创建 run，request/outbox 状态 | 新 run N→S→P→插入 | 等待原 COMMIT/ROLLBACK；COMMIT 已派发或回滚不明抛出并锁存 | 已见：`app.ts:500–617`。只固定新目标，不充当旧 source 独占认证 |
| retry 新 child 和快返已存在 child | 新目标 N→S→P→old/child SQL | 明确 commitDispatched；不明不释放 proposed target | 已见：`run-management.ts:127–214`。读旧来源与可用的现行重试不等于后续可信 Task 2 |
| 人工审批 UPDATE | N→project→run→approval | 原 SQL 完成后投影 audit outbox；未知提交/回滚失败抛出 | 已见：`run-management.ts:52–89`；当前不直接 append，coordinator 轮询决定 |
| tick 认领、权限失效终止 | 无锁找 candidate→N owner→918274→P | 等待原 COMMIT/ROLLBACK，owner 移交 launch 后才退出 tick | 已见：`run-coordinator.ts:175–218`；这里没有 S，N/P 已覆盖 |
| launch 与执行终态 | 同一 owner 覆盖准备、runtime、finishRun、原 writerDrained | active 保留至真实排空；失败保留 drain-failed；不以 SQL terminal 释放 | 已见：`run-coordinator.ts:224–293`，`product-runtime.mjs:82–84,100–124` |
| heartbeat/cancel 尾部 | 先 retain 原 owner；heartbeat 单 run autocommit；cancel N→P | producer.run 等原 pool.query；finish 由原 tail 完成触发 | 已见：`run-coordinator.ts:52–65,295–315`。heartbeat 无 project 行锁但有 N，不作为绕过 |
| expired-run recover、defer、finish | N→S→P；低层 assertWriter | 原事务 await COMMIT/ROLLBACK；finish trace 在同作用域内同步完成 | 已见：`run-state.ts:8–18,21–67`，coordinator `:136–158` |
| runtime usage、预留、响应与异常回填 | 原 runtime owner；recordUsage assertWriter；费用事务 S→P→policy→receipt | adapter/Host 原始排空被 runtime.writerDrained 等待 | 已见：coordinator `:38,71–98`；cost `:117,209–214`。单笔人工结算是纯 SQL S→P，不另要求 N |
| 批量费用过期、查询过期、同中转站批量 SQL | 纯 SQL S；实际 UPDATE 在同一连接同一事务 | costMaintenanceTransaction 等原 COMMIT/ROLLBACK；失败丢连接 | 已见：cost `:18–37`；reconciliation `:113–115,158–163`。复用 S，不逐 run native |
| 外部账单查询完整链 | 各事务有 S/P，整链无 N | 外部请求由函数 await，但 native source 不等待该函数 | **确定缺口 A1**，不能以清扫原生 PostgreSQL 证据覆盖它 |
| LocalOperationService enqueue/wait/cancel | N→S→P→operation/device | 原 localTransaction/operationTransaction 等原事务；已确认未执行与未知结果区分 | 已见：`local-execution.ts:69–107,199–249`；enqueue append 标记物理不明 |
| 设备 poll/start/result（含迟到结果） | 无锁发现 run→N→S→P→operation→device | 更新与原 COMMIT 同作用域；异常 rollback 不明锁存 | 已见：`local-execution.ts:430–510`；跨 run 设备元数据走 deviceTransaction S |
| LocalRunExecutor prepare/execute/mirror | perform N；物理操作嵌套 N；wait 使用原操作取消证明 | pending 原承诺集合、close 原清理和 allSettled；真实失败保留 failure | 已见：`local-execution.ts:257–285,335–408,417–425`；原始 mirror 不自带 native，但产品调用有外层 |
| task attempt/scope/input_origins/sandbox_identity | LocalRunExecutor taskTransaction N→S→P→operation/device | bind/scope SQL helper只由已持锁调用者传 client | 已见：`task-execution.ts:58–74,94–128`；local `:289–325,366`。helper 自身不是独立 HTTP writer |
| checkpoint 准备、对象和同步 publisher | taskTransaction N→S→P；对象低层断言；publisher 在 COMMIT 后仍处 N | await 原 COMMIT 后同步 publish；不提前返回未调用 closure | 已见：local `:306–307,323–325`；`task-checkpoint-state.ts:35–80` |
| canonical 初始化/合并/补记/拒绝收尾 | 外层 N 跨多个事务；每事务 S→P→operation/device；对象/append/mirror 同 owner | Persistence 记录物理/SQL 不明；对象 fsync、提交、事件、缓存都在 N 内 | 已见：`task-canonical.ts:79–108,139–216`；materialize `:226–231` assertWriter |
| accepted-stop 的选择、dispatch、reconcile、finalize | 外层 writer N；produce 嵌套；SQL S→P→task/operation | abort 只丢连接并继续等待原 query；未知/物理失败 produce 锁存 | 已见：`task-accepted-stop.ts:70–153,287`；维护 HTTP 进入同 lifecycle（task-stop-maintenance 末尾） |
| trace create/open/append | 登记根 bindJournal 要求同活 owner；短 journal exclusive | 创建、快照、初始事件、验证、去重、seq、write/fsync、cursor 全同步 | 已见：`trace-store.mjs:54–101`；scope `:151–164`。句柄不能跨已结束 owner 复活 |
| SHA 对象与 journal 压缩 | 对象 writer 断言；压缩 M 断言 | storeArchiveObjects 的原同步写/fsync；压缩同步 durable/删除 | 已见：`archive-objects.mjs:40–69`，`journal-archive.mjs:33–43` |
| standalone 离线追踪验证 | 同 app manager N；完整验证/Host close/终态 | 原 close 共享承诺；外层 withWriter 等其实际结束，失败锁存 | 已见：`verification.mjs:27–37,69–109`；明确测试模型，不冒充真实业务模型 |
| storage 维护清理/压缩/沙箱回收及收据 | M→918274/918275/918276 exclusive→表锁；无 SQL 内 native 等待 | 一个外层 M 跨全部 SQL、原物理 Promise、partial 收据；不明锁存 | 已见：`storage-governance.ts:45–70`；lifecycle `applyMaintenance/reconcileMaintenance` 断言 |
| portable/enterprise backup、restore、控制恢复 | R→vault lock→SQL gates/table locks；control helper assertRoot | underBackupRoot 跨阶段、原 SQL、目录 swap/补偿；unknown 保留 root 失败 | 已见：`backup-root-scope.ts:8–15`；backup `:49–58,101`；enterprise export `:50–51,86`、restore `:110–120` |
| restore control manifest、completion、active、stage/rename | R；控制目录不冒充 run writer | 同步 atomicJson/durable+目录 fsync；reconcilePending 包在 R 中 | 已见：`backup-restore-state.ts:64–111,124–143`；恢复控制文件有断言 |
| 规划诊断根内文件 | 无 native，SQL 不适用 | 同步文件写，但可能与 root swap 交错 | **确定 root 覆盖缺口 A2**，不是 run source 证据 |

## 低层防御建议，不列为已证明的生产绕过

`step-checkpoints.mjs:144` 在 `storeArchiveObjects` 的低层 scope 断言之前 mkdir `checkpoint-objects`。`commitStepCheckpoint` 的实际产品调用经 Handoff→Product runtime→coordinator owner，当前未找到该调用链脱离 owner 的生产路径；因此仅建议将 mkdir 交还共用对象存储入口，或在首个物理写前加共用断言。类似 `mirrorFiles`、`restoreStepWorkspace`、`prepareImportedWorkspace` 都是原始文件 helper，其现有 coordinator/LocalRunExecutor 产品调用受保护；不能只凭它们没有 manager 参数宣称产品绕过。

## 已有证据与仍待证据

- 已读取 [trace cutover 验收](archive-trace-cutover-2026-10-29.md)：其中保存两进程 seq/sourceKey、source 与 journal 竞争，以及 API/执行器/维护回归。它已声明不代表全仓覆盖；本轮未重跑，未把旧哈希测试当作当前树的新通过结果。
- 已读取 [SQL 尾部验收](cost-maintenance-tail-2026-10-21.md) 和 `tests/cost-maintenance-native.test.ts`：真实 PostgreSQL 9 项覆盖跨项目清扫、原 UPDATE/COMMIT/ROLLBACK、COMMIT 客户端断线后由 source barrier 等真实数据库结果。其入口仅 expiry/stale-query，**不覆盖 A1 的外部查询生命周期**。
- 当前测试文件还包含 run-admission/local-operation/task-canonical/accepted-stop/backup/storage writer、runtime drain、physical failure 等定向检查；本轮只读取关键断言，无新增通过统计。
- 恢复 Task 2 尚须实现/核验：native source→exclusive `918275`→project/source-child 行锁；READ COMMITTED 锁后投影；完整 scope/accepted_stop/所有 operation（含 null、失败、未决）、完整事件前缀与 snapshot 摘要；原子子运行发布前保持保护，并重新核对费用、权限、backend/capability。现有只读 recovery-check、已存在 retry 路由、旧 ledger 均不能替代它。

审查边界：覆盖 brief 点名的 app/coordinator/run-management/run-state/local-execution/cost/control/maintenance/backup/task 生产调用链及其直接文件 helper。检索额外核对了 usage/project 规划关联写入：app 的规划 preview 持同 project 行锁、product 的迁移关联写入持 S，未作为 run history 未保护缺口。没有穷尽知识库、插件安装、用户授权业务表、外部工具内部任意文件写或部署脚本；这些须按可信投影与工具授权边界另核对，尤其不得让工具写 traceRoot/lockRoot。未触及成员工作台、观测导出、七维评测；未做浏览器、JJ、OpenShell 或真实模型验收。关闭旧 writer、统一根映射与升级部署仍是上线条件。
