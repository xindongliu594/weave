# 产品 Host、文件版本与读证据的隔离验证

2026-10-05。新增 [product-concurrency.test.mjs](../../services/agent-runtime/product-concurrency.test.mjs) 使用真实 DSH 员工 Host、AgentTeams 任务/attempt 与实际 Windows LocalExecutor，在自建临时目录执行。模型适配器只等待取消，不返回模型内容、调用中转站或生成真实员工交付。原项目数据、预算及四个员工文件不写入。

新增集成测试 **4/4**，连同请求上下文回归 **10/10** 共 **14/14** 通过，见[最终输出](product-concurrency-final-2026-10-05.txt)。这些是工程证据，不能替代 Todo 的真实独立 QA、经理验收或受控中断恢复完成。

| 场景 | 实际结果 |
| --- | --- |
| 同一当前任务完整读两次 | 本机读取实际内容、SHA、工作区 manifest/revision 和 localWorkspace；源端生成两条哈希证明。仅移除完全相同的旧组，保留最新真实 call ID、全文和保护索引，原消息不修改。 |
| 两个员工读取同一固定文件 | 使用两个不同 DSH Host 和两个并行批准任务，读取相同 SHA；证明的 employee/task/attempt 范围不同，不跨员工合并。当前同一运行文件 mutex 仍将实际读取串行化，峰值执行数 1。 |
| 知识权限 | 员工甲实际读取 v2 切片；员工乙同工具但无该文档授权，读取被拒绝。 |
| 同一任务内两个重叠旧版本写入 | 两个调用同时到达真实工具边界，携带同一已读 SHA，只有一个成功；另一条 FILE_VERSION_CONFLICT，最终文件保留成功内容，峰值实际执行数 1。不能把这条测试称为“两个独立员工可以同时写同一文件”：此类无序合同在批准前已被拒绝。 |
| 冲突后继续 | 重新读取新 SHA 后，显式合并的写入成功；提交当前 attempt 后宿主 seal 对应实际合并文件 SHA，原冲突阻断清除。旧 attempt 和任务完成后的写入仍拒绝。 |
| 失败分类 | 旧 SHA 写入属于已知未执行；档案记录 FILE_VERSION_CONFLICT，没有产生 outcome_unknown。员工看到 HANDOFF_BLOCKED 和重新读取提示，档案保留具体错误 code。 |
| 不安全的双员工合同 | 无依赖双写同路径，以及无依赖写/读同路径，均被 INVALID_HANDOFF_CONTRACT 拒绝；不创建 worker、不调用模型。 |
| 证明被篡改或无证明 | 正文/目录变化、错误 attempt、跨员工证据不去重；冷 Host 即使读取原档案，也不重建进程内证明，保守保留完整旧组。 |

首轮集成实测发现，实际本机读取带有 `localWorkspace` 字段，而签名模块只允许容器读取的字段，因此完整本机读取也得不到证明。修复 [request-context.mjs](../../services/agent-runtime/request-context.mjs)：接受执行器定义的有界非空目录字段，将它纳入完整结果哈希；未知额外字段和无效元数据仍拒绝。这是对真实工具结果的兼容修复，没有放宽文件/知识授权或丢弃必须证据。

[首轮输出](product-concurrency-initial-2026-10-05.txt)保留了该问题，以及新增测试把宿主包装错误误当直接错误码的断言错误；[中间输出](product-concurrency-fixed-2026-10-05.txt)保留新增测试遗漏 claimed→in_progress 状态转换的错误。后两项只修正测试，按真实协议核对包装错误、档案 code 和状态迁移后通过。

本报告只证明当前同一产品 Host 的 mutex、实际执行器 SHA 协议和员工证据范围。任意外部编辑器、多 Host/多 OS 进程、跨设备目录、文件替换窗口、断电及完整 OS 沙箱仍未验证。[API 队列/领取/租约竞争实测](multi-agent-operation-concurrency-2026-10-05.md)另有 7/7 通过；它使用单后端 PGlite，不能证明独立 PostgreSQL 多连接的行锁交错。
