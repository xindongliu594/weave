# 恢复来源事实层的复用核对

本次沿用已安装代码，不增加依赖或另一套恢复引擎。

| 需求 | 可复用实现 | 为伍须补的连接 |
| --- | --- | --- |
| 排空源写入、拒绝新 writer | 已接线的 archive-write-fence、原生 fs-native-extensions、writer 生命周期 | 将原有 source 模式接入同一 Manager；真正的管理器身份及回调期断言 |
| 完整档案前缀 | trace-store/readRun、readJournal、原始 snapshot 文件 | 唯一首个 created、SQL 脱敏快照对应、完整前缀和原始字节摘要，不裁切后续验收 |
| 固定完整 SQL 历史 | 当前 project_runs / task_attempt_workspaces / local_operations、恢复记录格式 | 明确投影，保留 NULL/微秒、全部操作及新授权和 runtime effect 列；原提交、权限与未知操作仍另验 |

上游 [fs-native-extensions](https://github.com/holepunchto/fs-native-extensions) 提供底层锁能力，具体调用仍以已安装版本和现有适配器为准。[PostgreSQL 17 锁文档](https://www.postgresql.org/docs/17/explicit-locking.html) 说明 SQL 锁的范围与互斥关系；SQL 行锁本身不能排空文件 writer。没有升级包，也没有把上游新 API 当成已安装能力。

当前原生 source guard 的 factory/WeakMap 身份可以复用；恢复专用的 Manager 入口仅有读能力。档案函数必须核对真实 Manager 身份，不能仅调用传入对象上的同名方法，否则伪造 traceRoot 或借用真实闭包方法会绕过固定根的假设。

Oct21 的 SQL 预检已不足以定义当前完整投影。当前迁移还包含授权人、授权 epoch/类型/部门范围、source_bounds，以及 runtime 的 executor_kind、effect_intent、effect_state、effect_version、parent_operation_id、evidence_records。本次纯投影全部纳入。后续准入必须同时使用 task/local unresolved 与 requireResolvedEffectsIn，不能把 runtime unknown 当作普通已结束操作。

本批没有真实 SQL collector：历史函数只计算严格、完整且有边界的事实摘要，档案函数只在真实只读 scope 中读取文件。二者都不认证原操作、不授予恢复权。完整来源还需同一窗口内的 SQL 锁、原 scope/claim/result/merge、历史 CP/输入、保留已完成员工验收及当前权限核对；随后才可做 child 初始化。
