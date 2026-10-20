# 恢复来源读取期间的写入隔离：复用调研

日期：2026-10-21。固定库已完成 Windows/JJ 隔离验证，随后加入 runtime 依赖并实现私有锁适配器；生产 writer 尚未接入。生产档案、服务和模型配置没有变化。

## 当前缺口

`trace-store.mjs` 的 append 只在本进程内同步校验、追加和 fsync；数据库 project/run 锁不会自动阻止另一个进程写 JSONL。`run-management`、检查点 publisher、本地工具结果等存在数据库事务外追加。旧进程仍可能在数据库标记停止后补写。恢复首次发布前需要稳定的完整来源，不能用 SQL 终态、空 lease 或单进程 active Map 代替写入隔离。

现有日志归档可复用压缩读取与每次 append 的 `assertJournalWritable` 检查位置，但不能直接解决：当前归档只接受 completed，恢复源允许 failed/interrupted/cancelled；归档还会压缩并删除原 JSONL，而且“存在标记”检查与实际 append 之间没有跨进程互斥。因此不自动封存旧失败现场，也不放宽现有归档条件。

## 已查来源与适用性

| 方案 | 可复用部分 | 当前判断 |
| --- | --- | --- |
| [DSH persistence](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence) | 已安装固定版本的单 session 持久化与 flush | 保留使用；它不持有为伍 SQL、档案和多个回调的统一写入边界 |
| [PostgreSQL advisory lock](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) | 项目已有依赖，audit-outbox 已使用事务锁 | 候选；官方明确由调用方共同遵守。同步文件 append 及事务外回调必须参与；数据库连接丢失也不能允许残留 writer 继续写文件 |
| [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile) | 跨进程 mkdir 锁，同步接口、mtime 更新与异常通知 | 不能直接把过期接管当作严格隔离。作者列明手工移除和不一致 stale/update 的限制；旧 writer 暂停或锁被接管后的写入仍须处理 |
| [fs-native-extensions](https://github.com/holepunchto/fs-native-extensions) | 文件描述符级 tryLock、shared/exclusive、unlock；提供各平台实现 | 优先隔离验证候选。同步 tryLock 适合现有同步 append，争用可明确返回；必须验证 Windows/JJ 原生包、进程退出释放、同进程多描述符和路径替换。文档称锁为 advisory，所有 writer 仍须共同参与 |
| [os-lock](https://github.com/mohd-akram/os-lock) | Unix fcntl / Windows LockFileEx，立即拒绝选项 | 备选；公开接口异步，与现有同步 append 的接线更大；仍需原生构建及平台实测 |
| [lickle-lock](https://github.com/Pingid/lickle-lock) | 操作系统锁、guard 作用域释放 | 备选；还需核对发布/预构建及维护证据，未仅凭 README 选为生产依赖 |
| [Node 内置 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html) | 同步本地事务 | 不为一个档案锁先引入第二套数据记录；保留为比较项，当前不选 |

实际查询 npm 并以 `--ignore-scripts` 安装了 `fs-native-extensions@1.5.1`；完整性为 `sha512-abjiHKkYdcH5M9ikBEJb0MKb/fEpPtZx/yfLHzTptvUAoiFayX0tIe0BTLBU4SAoRyjZLzA0dP1Rn2p0+QRyVg==`，Apache-2.0。隔离 lockfile 固定六个包及各自完整性，Windows/JJ 使用相同 lockfile；没有运行安装生命周期脚本。

隔离实验完成后，按 [接入计划](../superpowers/plans/2026-10-21-archive-writer-fence.md) 将同版本加入 runtime package/lock，只有六个新增依赖记录，原有包记录不变。私有适配器又完成 Windows 17 通过/3 OS fixture 跳过、JJ 同源 20/20、独立审查；[独立验收报告](../validation/archive-writer-fence-primitive-2026-10-21.md) 与下面的库原语实验分开记录。

## 实测与下一步

使用同一个 [独立验证脚本](../../scripts/validation/native-file-lock-pilot.cjs)，在 Windows Node 24.15.0 与 JJ Linux Node 24.19.0 运行。两边均完成七项互斥/释放检查、一次路径替换观测和一次小型计时：

- 两个文件描述符、两个实际进程的共享/独占争用符合预期；关闭描述符、进程正常退出、强制结束本脚本的子进程后可重新取得锁。
- 有限重试期间没有超时抢占旧锁；两个实际子进程累计 60 次读改写，结果为 60。
- **两边都允许重命名锁文件后新建同名文件，新文件可再次取得锁。** 这是明确的局限，因此锁文件不能随运行目录替换或清理；所有参与者须使用同一稳定文件身份。
- 最终 1000 次无争用 open→lock→unlock→close，Windows 均值约 229 微秒，JJ 约 8 微秒。仅说明本次机器、本地文件系统和此小用例的开销，不能用于承诺项目吞吐或跨机器速度比。

输出、原始 SHA256、锁文件版本和命令保存在 [验收记录](../validation/task-recovery-source-codec-2026-10-21.md)。这里没有验证网络文件系统、全部产品 writer 覆盖、运行生命周期排空或真实恢复。

独立审查发现首轮“关闭描述符”用例随后立即退出进程，不能区分两种释放原因。已修正为保持持有者进程存活，确认关闭后由另一进程重新加锁，再让持有者退出；Windows/JJ 重新运行通过，原脚本与初轮记录保留。其他行为与源码未变。

接下来冻结唯一锁文件位置、不可替换要求、锁顺序、所有 writer 接入点与来源读取的持锁范围。锁可用不等于历史已静止；还要处理取得锁前已排队的晚到回调，并保留未知动作。实际接线与竞争验证完成前，Task 2 的在线来源签发和 Task 3 发布仍保持关闭。Task 1 纯格式校验不能冒充恢复成功。

本实验比较现成原语，避免重新实现平台锁；业务授权、源/目标身份和检查点关系仍由为伍负责。
