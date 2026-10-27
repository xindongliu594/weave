# 多员工本机操作的隔离竞争实测

2026-10-05，新增 [测试](../../tests/multi-agent-operation-concurrency.test.ts) 最终 **7/7 通过，覆盖 9 类场景**，类型检查通过。主代理另行完成 DSH 读取证明修复后，当前工作树类型检查再次通过；本报告不把该独立修复算入这 7 个测试。[实际输出及被测模块 SHA](multi-agent-operation-concurrency-2026-10-05.txt)

本轮只新增该测试、报告及日志，未修改产品源码、原数据、凭据、额度或员工交付；未重启主服务、调用模型或操作真实项目。使用现有隔离 runner 创建独立临时 PGlite，临时目录前缀 multi-agent-operation-，结束后安全删除该测试目录。

## 实际竞争结果

| 场景 | 实际请求与结果 |
| --- | --- |
| 同一操作重复领取、重复开始 | 16 并发 poll 只出现同一操作及一个 token。随后 16 并发 start 为 1 个 200、15 个 LOCAL_START_DENIED/409；成功者实际执行 LocalExecutor，临时文件只写 1 次，SHA 为 547690228c00dbdbab101fe6be7171c57db61feedbb55027b698c42e27e03af7。 |
| 丢失领取响应后再取 | 未开始任务再次 poll 得到相同 ID/token；已经开始后 poll 只返回 orphan，不重新派发执行任务。 |
| 两员工同设备、同文件 | 两项实际 enqueue。12 并发 poll 只领取第一项；开始后另 12 poll 均看到同一 orphan，第二项保持 queued。第一文件完成后，第二员工缺少当前 SHA 的写入被 FILE_VERSION_CONFLICT 拒绝，原内容保留；新操作携带最新 SHA 后可写入。 |
| 同内容回执重传 | 16 并发相同 result 均 200，只保留一个 completed/result，不产生 late_result。内容及 SHA 来自实际临时文件执行。 |
| 不同回执争抢 | 两个合法但元数据不同的 result 并发提交，1 个 200、1 个 409；后续冲突回执仍 409，首个结果保持。 |
| 开始前运行 lease 过期 | 12 并发 start 全为 409，started=false；旧 owner 新 enqueue 被 LOCAL_LEASE_DENIED 拒绝，操作数量不增加。active poll 返回 cancel 并取消旧操作。 |
| 开始后运行 lease 过期 | 8 并发迟到 result 可得到传输层 200，但只写 cancelled/late_result，result=null。service.wait 拒绝，notExecuted=false，文件及迟到证据保留，不重派。 |
| 开始后 worker 被替换 | 更换测试运行的 lease_owner，8 个旧 owner 回执同样仅作 late_result 审计，不能成为完成结果或被 wait 采用。 |
| 操作自身 deadline 过期 | 8 个迟到回执同样取消并保留审计；操作行始终只有一条，后续 poll 不自动重放。 |
| 旧 operation token 用于新 operation | 取已真实完成操作的旧 token，对新操作竞争提交：8 次 start 为 409，8 次 result 为 403。新结果/迟到结果均未被旧回执写入；新有效 token 随后正常完成。 |

表中的“丢失响应再取”合在第一个测试，因此 7 个 Node 测试包含 9 类独立竞争检查，并非十项测试通过数量。每个案例末尾均实查：模型 sentinel 请求 0、usage 行 0、model_reservations 行 0，所有测试项目 cap 保持 $1。该测试额度属于临时 fixture，没有修改原项目 $0.48 上限。

## 测试方法与结论边界

多个客户端通过 Promise.all 并发请求真实 [localDeviceRouter](../../apps/api/src/local-execution.ts)。队列使用实际 LocalOperationService.enqueue，文件使用实际 [LocalExecutor](../../apps/desktop/local-executor.cjs)；未用固定模型响应或纯函数镜像替代竞争。测试直连本机操作路由，未挂全局幂等中间件，因此结果反映操作层自身的领取、开始和回执保护。

本边界内未发现需要改产品源码的失败。允许重新取相同的未开始 claim 不等于允许重复执行；迟到回执 HTTP 200 不等于完成被接受，必须同时核对 status/result/late_result 和 wait 结果。

PGlite 只有一个 PostgreSQL backend，现有 runner 将产品连接池限制为 1。这里验证了多个同时到达的 HTTP 客户端经数据库串行处理后的行为，**未验证独立 PostgreSQL 多连接的真实行锁等待、死锁或提交交错**。也未验证两个独立 OS 设备进程、跨设备重叠目录、命令开始后断电/进程强杀、外部编辑器在原子替换窗口改文件、浏览器重复点击，以及真实多员工模型调度；这些不能据本次测试称为已通过。

本次测试产生的是隔离测试文件，不能代替真实 Todo 项目的 QA、经理验收或中断恢复完成证据。真实主流程的剩余验收仍由主代理继续。
