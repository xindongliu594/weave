# 活跃 owner 的租约过期调查与本地修复

调查对象为 Normal v12 Run `566c813d-6fc9-409a-b945-ec9d5afea4fe`。本轮未访问真实 API、原数据库或凭据，未调用真实模型、停服、加载新源码或修改员工文件。主任务确认 API PID43528 与 launcher PID10676 的创建时间和命令仍与18:18加载一致；该进程观察由主任务提供，本调查没有重新采集 live 状态。

已确认的错误机制：同一 `tick()` 的忙标记同时抑制调度和心跳；即使心跳排在 recovery 前，只要之后同步执行或单连接池等待超过30秒，`recover()` 仍能接管该 coordinator 自己的 active Run。旧 `run-coordinator.ts` SHA `2a4e0c6e91e8ca59779ab61600e8e9f8ef978db9d1da8359f912fb00dd5cfb13`：74行 busy 判断、76行心跳、79行 recovery；53行先做费用 maintenance，54行选择过期 Run，56行 claim，65行写固定“服务租约过期”终态。旧 `run-state.ts` SHA `f75c650f74b2617af85cbd0200758500fa245bdee62a87f4787f91e164ac3e4d` 的18–23行只检查数据库状态/租约，没有自身 active 排除。新隔离回归在实际源码成功心跳后的 maintenance 屏障注入过期，嵌套 tick 被 busy 拦下；修复前实际写成 interrupted，初次失败证据见 `.repro-before.txt`。这是实际 coordinator/state + fresh PGlite/FIFO1 的重现，不是重写算法的模拟。

完整 raw 保存在 `docs/test-evidence/go-normal-v12-lease-interrupted-2026-10-06T11-11-46-796Z-fdac107a`，archive 与 archive-after 字节一致，SHA `aee0d4ab736dcb63e463d532b70782756fd2d57a1545e23d7fef79e7af366a2f`，31,604,398字节、2867事件。QAaccepted 为seq2720/11:04:00.632Z，内部 acceptedAt11:03:59.053Z；seq2840/11:05:35.749Z 申请review MODEL，seq2848/11:05:40.962Z 首次 LEASE_LOST，没有该请求的wire；seq2856/11:05:46.132Z recovery 写 interrupted；seq2867/11:05:52.114Z 旧 runtime 最后写 cancelled。公共 DB-backed 状态仍 interrupted，晚到原始 trace 保留。26个host request、25个wire及usage；这个差值不用于推定未知费用为零，原未知预留 `.096526` 和历史均保留。

具体同步饥饿来源有强证据，但没有原 heartbeat SQL时戳/CPU profile，不能声称精确测到了当时每次锁等待。旧 `trace-store.mjs` SHA `0cf0d4c7a84e689d7d4bd181e6642d99a6611e4ba1a09def7de4cd016d2196ba` 的36–53行：每个 append 先完整 `readRun`，重复 sourceKey 也在全量读取/JSON.parse 后才判重。`trace.mjs` 的18–21行 sessionCreated 同步遍历 `snapshotEvents()`。同一 QA session 在seq2828重新created前已有82个同version3 sourceKey，sourceSeq0…81；下一个首次新source事件seq2829晚了30.427秒。隔离复制原export的31.5MiB journal benchmark（`go-normal-v12-trace-append-comparison-2026-10-06.json`）完整读取376.47ms，40轻量append15.526秒、median391.922ms。82次旧记录重放判重需要约30.87秒，吻合真实空档；这是根据源码、原事件及同机隔离计时作出的因果推断。主任务独立负责 append cursor 修复；本项没有修改 trace-store/full read/export/recovery 的完整性语义。

其它回收入口已核对：`cost-control.ts:13–16` 和 `cost-router.ts:22` 的 expireReservations 仅将模型测试 interrupted、pending费用 uncertain，没有修改project_runs的lease或owner。reserveCall 的90–118行在同一事务内做maintenance/project/policy/run检查，可能占用或等待连接，但 lease 拒绝本身正确。`local-api.ts:10–12` 明确 pool max1；没有更改这个串行边界。原独立自动提交心跳的 `now()` 不会继承已提交并释放连接的旧事务时钟；fresh PGlite 回归验证了 BEGIN内now固定、COMMIT后独立now新鲜。local-execution 的60、80行仍严格检查owner、run/cancel、lease、deadline；started-operation的soft device心跳规则不会放宽真实租约。

本地最小修复仅生产源码 `run-coordinator.ts` 和 `run-state.ts`：

- coordinator 30–42行独立 singleflight 心跳不再受tick busy抑制，使用 `clock_timestamp()+原30秒`，仍只更新同owner、running Run。丢失owner的取消不阻塞共享心跳完成；close等待已有心跳结束。
- 52–60行 beforeRequest 对仍活跃的本worker等待一次新鲜心跳，然后进入原 reserveCall全部事务/授权/版本/取消/费用门禁。原signal可立即退出排队等待；没有新增模型重试、reservation或外部调用。
- heartbeat回执同时携带本次ids和held；若新Run在旧心跳排队时加入active，仅对未覆盖者补一次包含它的心跳。已覆盖但foreign/lost者直接拒绝。新并发fixture证明恰好两次心跳、一个reservation，不误报LEASE_LOST。
- recovery的自身active排除在原 project→run 行锁内再次判断（coordinator83行与run-state18–20行可选同步exclude），不接管仍属当前owner且active的Run。死/foreign owner、未active自身旧Run仍使用原claim/reconciliation/原子终态；硬expired授权与执行门禁没有放宽。

原 `run-state.test.ts` 准备步骤过时，先前批准默认占位任务而被现有 PLAN_NOT_READY挡下，原失败日志保留。本次23–29行正常PUT明确单人requirements任务后按version2批准，不调用模型、不绕过生产门禁。PGlite socket 的 PL/pgSQL RAISE 测试出现 unexpected commandComplete/后续空rows；它也在新fixture独立复现，不能据此宣称live根因。按主任务授权，PGlite分支在实际connected client的第二个project UPDATE前注入指定Error，仍实际执行 BEGIN/前序run和approval写入/ROLLBACK并逐表核对；PostgreSQL分支保留原trigger。仅限域 helper `run-transaction-fixture.ts`，没有生产实现改动。

最终 `related-final.txt` 的实际隔离 runner 退出0：新增9、原状态3、设备准入7、operation heartbeat4、竞争7，共30/30通过。命令显式排除了只能由独立PostgreSQL多连接验证的原 `late worker waiting` 检查，本轮不声称验证了它；原锁顺序和该测试本身保留。最终 tsc session58718退出0、无输出；PowerShell Tee-Object不创建零输出文件，故随后将该实际空输出写为 `.tsc-final-v3.txt`，执行结果记入 `.sourceSHA.json`。

源码 SHA以同前缀 `.sourceSHA.json` 为准。初次repro、旧准备步骤失败、PGlite协议失败和fixture类型检查错误全部保留；通过只引用上述最终日志。真实服务尚未加载本修复，v12失败记录不晋升或改写；未来 controlled restart/完整真实正常验收仍由主任务执行。
