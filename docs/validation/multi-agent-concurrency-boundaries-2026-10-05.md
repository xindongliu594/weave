# 多员工并发和冲突边界

2026-10-05，依据当前源码及隔离竞争实测。本说明解释已有机制及限制，不代表真实多员工项目全部验收通过。当前个人中转站项目方案 v6 的 `maxConcurrentAgents` 是 1，开发、独立测试、复审、经理存在依赖；本项目还没有完成真实高并发模型压力验收。

| 情况 | 当前机制 | 发生冲突后的处理 |
| --- | --- | --- |
| 多员工读取同一文件/知识 | 固定任务输入文件 SHA、知识文档版本与员工授权；当前同运行文件工具用共同 mutex，文件读取也保守排队 | 知识编辑不改变已批准运行的固定引用；文件版本变化拒绝沿用旧输入 |
| 两个任务写同一文件，或一读一写 | 批准合同要求明确先后依赖；无依赖且有交叉输出/输入会被拒绝 | 方案先排定顺序，或分到不同输出文件。不是让多个员工同时覆盖同一路径 |
| 基于旧文件写回 | `artifact_write.expectedSha256`，创建文件也检查文件是否已经存在；同一运行的产品文件/命令工具经 HandoffGate mutex | 旧 SHA 不匹配返回版本冲突，员工重新读取并合并，重新测试；不能自动覆盖 |
| 多个 API 更新同一项目/审批/操作 | 事务、项目/运行/操作行锁、方案 version 校验，领取凭证及租约 | 旧方案返回 409；未开始的重复领取复用同一 token，但只能开始一次。过期 worker 迟到回执可按 200 留审计，不能成为当前完成结果 |
| 重复恢复 | 同项目事务与父运行检查；已有子运行时返回它的 ID | 避免创建第二次后续运行，沿用历史费用和次数，不清零 |
| 并行模型费用 | 共享运行/任务预算；发送前同步预留并持久化收据 | 预留失败不发送；结果未知保留占用并核对 |
| 重启时外部结果不明 | 保存操作 ID、状态与结果，恢复入口显示未知项 | 核对后才决定继续，不能仅靠重试当作幂等 |

员工工具表中没有 SQL 执行或直接数据库连接。知识读取经宿主按授权和固定版本查询，数据库写入由 API 承担；数据库同时 SELECT 不是通常意义的冲突。读写一个一致的视图时采用事务快照，例如新恢复检查采用 `REPEATABLE READ READ ONLY`。当前产品不是允许员工自由修改内部业务表后靠模型协调。

当前 Windows 本机启动器 [local-api.ts](../../scripts/local-api.ts) 明确把 PGlite 的 pg.Pool 设为 max=1。因此本机数据库请求在同一个连接上排队，事务不会由另一条连接插入；竞争实测的单后端设置与本机运行方式一致。将来切换多连接 PostgreSQL 时仍需另测行锁交错、死锁和提交竞争，不能沿用本机测试结论。

源码： [任务合同冲突检查](../../packages/contracts/task-contracts.mjs)、[HandoffGate 与输入版本](../../services/agent-runtime/handoff.mjs)、[产品工具权限与锁入口](../../services/agent-runtime/product-tools.mjs)、[文件旧版本校验](../../services/agent-runtime/sandbox.mjs)、[项目方案与批准](../../apps/api/src/app.ts)、[运行领取](../../apps/api/src/run-coordinator.ts)、[本机操作领取/租约/批准](../../apps/api/src/local-execution.ts)、[恢复事务](../../apps/api/src/run-management.ts)。

限制：HandoffGate 是同一运行 Host 内的锁，不协调任意外部编辑器或多个擅自打开的 Host。当前本机终端在用户批准后执行真实命令；尚不是完整 OS 沙箱。任意脚本可以绕过 artifact_write 的旧 SHA 协议；文件范围和版本会在工具/交付检查中发现变化，但不等于系统级阻止所有越界写入。接入 Windows ACL 或容器并经过实测之前，不能宣称已经完全隔离。

已完成两组隔离实测：[真实 DSH 员工 Host/文件工具与证明](product-concurrency-2026-10-05.md) 4/4 集成及 10/10 上下文回归；[HTTP 本机队列/领取/回执/租约](multi-agent-operation-concurrency-2026-10-05.md) 7/7，覆盖 9 类竞争。确认旧 SHA 不覆盖、显式重新读取后可继续、旧 attempt 拒绝、两个员工同设备写入排队、重复启动只成功一次、过期 lease/旧 token 不能完成任务。单后端 PGlite 没有验证独立 PostgreSQL 多连接交错；任意多个 OS 设备及外部编辑器竞争仍未验证。相关既有回归位于 [task-contracts.test.ts](../../tests/task-contracts.test.ts)、[handoff.test.mjs](../../services/agent-runtime/handoff.test.mjs)、[product-flow.test.ts](../../tests/product-flow.test.ts)。这些均不替代真实项目执行和重启验收。

Codex 开发子 agent 与产品员工是两套协作。开发子 agent 共享本工作区，目前按文件分工，并由主 agent 统一审查、类型检查和构建；这类分工是工作纪律，不能当成强制文件锁。若下一阶段需要多人独立修改同一模块，可用独立 Git worktree，最后显式合并并验证；当前用户未提交的修改和历史数据继续保留。
