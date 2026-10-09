# PGlite socket 关闭竞态修复

2026-10-08，本地 Windows Node 24.19.0 验证。JJ Linux 复测由 Root 单独执行；本报告不宣称 Linux 已复测通过。

锁定依赖 `@electric-sql/pglite-socket@0.2.11` 的源码 `src/index.ts:710` 在 `stop()` 中调用 `handler.detach(true)` 但不等待；`src/index.ts:263` 将 socket close 延迟到 `setImmediate`。`handleClose()`（521）先发 close 事件移除 server 的 handler，再启动异步 detach；detach（284）仍会检查数据库事务并执行 ROLLBACK。因此监听关闭并不代表数据库使用者已经全部清理。

新增 `scripts/local-database-socket.mjs` 仅在本机启动器创建的实例上登记实际连接，跟踪数据处理、合并重复 detach，并等待已从 upstream Set 移除的处理器完成事务清理。没有全局修改 prototype、编辑依赖文件、固定等待时长或忽略清理失败。清理错误由 stop 抛出 AggregateError，调用方不能继续关闭数据库或声明检查成功。使用锁定依赖的普通 JavaScript 成员，这些成员属于 upstream TypeScript private；升级依赖时必须重审，形状不符直接失败。

`scripts/local.mjs` 使用新工厂，保留 API 子进程 → socket → 数据库的关闭顺序。local:check 的最终通过提示移到全部关闭成功之后。

验证：

- 修复前：真实 pg 连接开放事务，关闭客户端后用实际 ROLLBACK 的受控门闩证明 socket.stop 提前完成；回归失败 `stop must await cleanup of an already disconnected handler`（true !== false）。门闩只控制测试中的实际清理时序。
- 修复后：两项真实 socket 回归通过，验证等待事务清理、已提交数据在磁盘重开后保留、未提交写入回滚，以及清理失败明确传播且数据库保持打开。没有真实模型调用。
- socket + 既有 launcher/static-web：21/21 PASS，0 SKIP，exit 0。类型检查 exit 0。
- 完整 local:check：exit 0。固定 loopback 模型，本机命令实际执行；一条审批、四条 native operations；API 两次重启及授权停用保留。最终 launcher-stopped/launcher-exit 0 且启动锁清除。输出：[local-check 日志](pglite-socket-close-local-check-2026-10-08.txt)。
- 独立检查目录 `.data/local-check/6396a084-b7d6-4b27-937e-66d84e5eb19a`，运行 ID `ec717d3b-4251-4681-821c-a0c53911eeb2`；仅本轮新建测试数据。未访问或修改原业务数据库、员工文件、凭据、历史费用。

首次验证源码 SHA256（保留历史）：

| 文件 | SHA256 |
|---|---|
| scripts/local.mjs | 970365e6a6aadd63333ecf906facf3655693dbe2ff716073c81e887e03c42319 |
| scripts/local-database-socket.mjs | 382270b9155f8228a84bb45751c65079318ff0a761e508743a25d6e26db4bd01 |
| tests/local-database-socket.test.ts | 83f3ff491edbafdc134f942697a841c433b51c9dbb27c36945d9ff0f427106cb |

## 最终补充修订

关闭失败时记录 `launcher-shutdown-failed` 与脱敏错误类别，保留本次启动锁，不写正常 `launcher-stopped`，重新抛出原错误；`resolveStopped()` 仍在 finally 执行。下次启动只有在该锁的 PID 已经不存在时才恢复。测试子进程增加独立 25 秒上限，finally 清除计时器、必要时 SIGKILL 并等待退出；成功路径不额外等待。关闭 helper 未改变。

最终重新验证 21/21 PASS、0 SKIP、exit 0，类型检查 exit 0：[测试输出](pglite-socket-close-final-tests-2026-10-08.txt)。完整 local:check 再次 exit 0：[最终输出](pglite-socket-close-local-check-final-2026-10-08.txt)。新独立目录 `.data/local-check/0abfa46f-9f5d-45ec-99a8-256d2c516a03`，运行 `f0a9b3c4-beaa-4bb4-8405-5d8ef2f21c15`；一审批、四条 native operations，保留授权停用，最终 launcher-stopped/launcher-exit 0 且锁清除，paidModelCalled false。

最终冻结：

| 文件 | SHA256 |
|---|---|
| scripts/local.mjs | 955635d69f0eeb8f9fe2fea9313ffc05686e7dbb1b687ffa17ef369733660de8 |
| scripts/local-database-socket.mjs | 382270b9155f8228a84bb45751c65079318ff0a761e508743a25d6e26db4bd01 |
| tests/local-database-socket.test.ts | b8998575ab808ead75ae2bc691a189b4863ae90c6205e6930e8230631a15a05b |
