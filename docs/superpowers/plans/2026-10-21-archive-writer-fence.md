# 恢复前跨进程写入隔离接入计划

目标：让恢复读取期间的源运行保持稳定，覆盖在数据库终态后仍可能执行的异步尾部。保留 DSH 的运行、会话持久化与现有 SQL 状态机，只补它们和为伍文件档案之间的写入边界。

复用选择已在 [调研和两平台试验](../../research/task-recovery-writer-fence-2026-10-21.md) 验证：固定 `fs-native-extensions@1.5.1`，使用操作系统文件锁，不自行实现 stale/TTL 抢锁。先完成私有原语，再接全部生产者，最后对恢复开放；每步单独记录证据。

现有成果基线 `3eaac81`。累计 $3.41、七笔未知预留、权限、沙箱容量及企业 profile 都不变。全程先做零付费工程验证；生产部署另按已批准验收流程进行。

## 全局规则

- 根级 shared/exclusive gate → 按 UUID 排序的 run lifetime 锁 → 原 SQL 锁 → 短同步 journal 锁。不得持 SQL 锁等待 native 锁。
- 普通生产者持 run shared；恢复读取持 source exclusive；维护使用独立的 exclusive 权限。源读取锁不能充当写入权限。
- 锁目录持久、独立于可移动的 traceRoot，不进入备份/清理范围。锁文件不删除、改名、轮换或按年龄回收；产品工具不得写锁目录。操作结束关闭 FD，不按历史 run 永久缓存 FD。
- OS 锁是参与者协议。路径身份检查发现协议外替换时拒绝；不宣称抵挡同一 OS 用户恶意改目录、网络盘或旧版不取锁的进程。
- 同步 append 保留原返回语义，临界区禁止 await。短竞争有界重试，超时明确失败；不返回假事件、不默默丢事件，不在锁失败时重放设备动作。
- acquire 的 AbortSignal 只取消等待。已经拿到的生产者锁直到实际工作排空才释放，不能用 HTTP 超时、SQL terminal 或清空 active Map 冒充排空。
- 本批不签发恢复批准、不初始化子运行、不改变检查点摘要与原权限校验。

## Task 1：私有 native 锁适配器

**范围**：新增 `services/agent-runtime/archive-write-fence.mjs`、对应 `.d.mts`、`archive-write-fence.test.mjs` 和必要的专用测试 child；只在 runtime package.json/lock 加固定依赖。不改 trace-store、API、运行时/SQL writer、配置默认值或产品开关。

先完成这一个可独立验证的原语层，避免还没接完全部调用者就令同步 append 拒绝所有现有运行。它暂不被生产入口调用；因此不代表已提供完整 writer 静止保证。

私有 factory 接收显式的绝对 `traceRoot`、`lockRoot`。两者必须已经存在、是无链接的普通目录，互不嵌套；拒绝路径 alias、symlink/junction 与异常根。固定逻辑根的身份来自真实父目录及固定叶名称，不随 traceRoot 后续合法替换而改变 namespace。第一批只支持本次验证的平台 win32/linux x64；其他平台明确 unavailable。

建议 API（可调整命名，语义固定）：

```text
createArchiveWriteFence({traceRoot,lockRoot})
  .acquireWriter(runIds, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireSource(runId, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireMaintenance(runIds, {signal?,timeoutMs?}) -> Promise<Guard>
  .acquireRootExclusive({signal?,timeoutMs?}) -> Promise<Guard>
  .assertGuard(guard, {mode,runId?}) -> void
  .withJournalAppendSync(guard, runId, syncFn, {timeoutMs?}) -> actual result

Guard.release() // idempotent; no implicit timeout expiry
```

行为约束：

1. Guard 用模块私有身份存储并绑定 factory/root、模式、run 集合、活状态和实际 FD；冻结外部句柄。手写对象、别的 factory 的 guard、已释放 guard、source guard 用来 journal 写入都拒绝。所有错误有固定 code，不能返回成功标记或自动降级无锁。
2. namespace 固定为 `lockRoot/sha256(规范逻辑traceRoot)`，内部 root gate 和每 run lifetime/journal 文件。mkdir/open 必须拒绝链接、非普通文件和 nlink≠1；新文件 `wx`，已有文件非截断打开。FD 与路径 dev/ino 对应，目录祖先身份固定；捕获后的改名/替换在 guard 检查和 journal 入口拒绝。不把文件内容/PID/时间当锁。
3. root shared 在 run 锁之前；run IDs 必须是小写 UUID、非空无重复、最多 128，内部按字节排序获取。获取任意部分失败/abort/timeout，反序关闭已取 FD；不留下活锁。重复申请同 run shared 可以并存，不能共享别的调用链的生命周期。此底层不做 ALS 自动借用；Task 2 接线时实现作用域借用。
4. async acquire 使用 tryLock + 有界 timer，timeout 是 0–2000ms 的安全整数；默认 writer 2000ms，source/maintenance/root-exclusive 0。整个 root+全部 run 获取共用一个 monotonic deadline，不按每个 FD 重置。已有持有者不因等待超时被抢占。signal 已 aborted 时零获取；等待中 abort 清理本次部分锁。取得后的 signal 不提前释放。
5. guard 在取得 root gate 后绑定当前 traceRoot 物理身份，后续 assert 检查不变；root-exclusive 允许调用者在持有期间合法交换 traceRoot，因此仅固定真实父目录及锁目录。release 始终关闭自己持有的原 FD，包括路径检查已失败的情形。后续新 acquire 可以绑定交换后的新根，旧 guard 不能复活。
6. journal 只允许覆盖 run 的 writer/maintenance guard；它再取得独占 journal 文件，monotonic 最多 2000ms，每次短 tryLock；临界区回调必须是同步函数，拒绝 async/Promise/thenable，禁止重入同一 journal 临界区。回调异常仍释放 journal FD；外层 lifetime guard 仍有效。外层 guard 不能在 journal 临界区中提前 release。
7. 不导出裸 fd、不提供 `verified` 布尔、不修改目录内容来“修复”不合法锁、不删除锁文件。仅核对 traceRoot 的路径/目录身份，不读取或修改运行档案内容，不访问 SQL 或模型；测试只使用独立合成目录。

验收：

- [x] 先保存 RED，新增原语实现后验证品牌、错误模式/身份、过期 guard、非法路径、有限等待和异常清理。
- [x] 两个真实进程：writer 阻止 source；多个 writer 共存；root exclusive 阻止 writer；持有者退出后可获取；多 run 部分失败不泄漏前面已取得的锁。
- [x] journal 两进程计数/顺序操作、短争用成功、超时不调用回调；抛错不泄漏，async/thenable/重入拒绝。
- [x] 真实路径替换后旧 guard 拒绝；合法 root-exclusive 交换后新 guard 有效。链接/硬链接测试按平台权限分开报告，不能把权限 EPERM 记作安全行为通过。
- [x] 新测试、现有 trace cursor/journal 回归、类型检查/构建通过，独立审查后记录源哈希；只声明私有原语完成。

2026-10-21：Windows 17 通过/3 明确 OS fixture 跳过，JJ Linux 同四文件哈希 20/20 通过；既有回归 17/17、项目构建和新增声明的独立类型检查通过。独立并发审查无 P0–P2。[验收记录](../../validation/archive-writer-fence-primitive-2026-10-21.md) 保留中间失败与最终哈希。Task 2–4 未完成，生产入口不调用本模块。

## Task 2：运行和 SQL writer 接线

先补 ALS 的同链借用与 producer 子任务计数，不重新开发调度器。`tick` 先定位候选、拿 guard、再事务重查；`launch` 的 guard 覆盖准备、Host、模型请求的实际 done、usage/finish/trace 及 heartbeat/cancel 尾部。暴露实际 `writerDrained` Promise，不能把现有 drain 超时当成功排空。

覆盖 `run-state`、`LocalOperationService` 的 poll/start/result/wait catch、executor 的 checkpoint publisher/close、canonical 多事务补记、accepted-stop 外层、审批 SQL UPDATE→append、创建/重试 run 与 standalone verification。入口持锁，低层断言；不能只给 append 上锁后声明全部源已静止。closed handle 拒绝迟到回调，不重新申请新 writer 复活。

把 append 校验、去重、seq、写入、fsync 和 cursor 更新放在原语的同步临界区。正常短竞争重试同一尚未写入的事件；写入结果不明沿原完整性错误保留，不盲重放。补充真实两进程连续 seq/sourceKey 与 terminal 后延迟尾部测试。

## Task 3：对象、维护与备份接线

对象存储/检查点写入绑定同一作用域；维护在原多事务外持 run exclusive；backup 在 SQL 锁之前持 root exclusive，跨目录交换和回滚，不导入/移动锁目录。未接入的 CLI 全目录恢复/迁移仅可在停服窗口使用。

验证两进程下对象复制、归档、备份目录交换与 writer 的冲突；旧 handle 不复活、新 guard 绑定新物理根。保留原 enterprise destination/未知操作门禁。

## Task 4：覆盖审查及交付给恢复来源核对

逐入口核对所有源表 UPDATE/INSERT、档案 create/append、对象/mirror/rename，保留双进程和原生 PostgreSQL 证据。所有 writer 接完且独立审查通过后，才把真实独占 guard 交给恢复来源 Task 2；随后仍须核对完整 SQL/档案/权限/已验收节点，才能初始化子运行。

首次部署需停止旧 writer、统一升级、再启动，不能混用新旧进程。Windows/JJ 原生原语试验不能代替这条完整产品链验收；本计划完成也不自动开放企业 profile。
