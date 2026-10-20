# 档案写入锁适配器：工程验收

日期：2026-10-21；基线 `3eaac81`。本批实现私有锁适配器，并在 Windows、JJ Linux 使用实际文件与子进程验证。**生产 writer 尚未接入，不能据此宣称项目恢复已经完成。**

## 复用与实现

沿用 [已完成的现成库比较](../research/task-recovery-writer-fence-2026-10-21.md)，runtime 固定加入 `fs-native-extensions@1.5.1` 和六包锁定记录；原依赖记录无变化，安装生命周期脚本禁用。

新 `archive-write-fence.mjs` 负责：

- 根目录、运行、日志三级锁顺序；多个正常写入者可共存，来源读取要求运行独占。
- 私有且不可伪造的 guard，检查模式、运行、工厂归属与活状态；关闭的 guard 不重新激活。
- 实际目录与 FD 身份检查；拒绝链接、硬链接、非普通锁文件以及持有期间已观测到的路径替换。
- 整组获取共用一个最多 2 秒的 deadline，超时/取消反序释放部分获取；已经取得的锁不会因等待预算或 AbortSignal 自动过期。
- 同步日志临界区、异常清理、嵌套保护；拒绝同一日志重入和异步回调，不替换 DSH 持久化或 SQL 状态机。

目录参数显式传入。部署仍须保证所有参与者使用同一映射、业务工具不能改锁目录；没有建立跨机器或恶意同用户文件操作的保护。函数暂未被 `trace-store`、API 或 runtime 生产入口调用。

## 测试证据

| 检查 | 最终结果 |
| --- | --- |
| Windows 新适配器 | 20 项：17 通过，0 失败，3 项 OS 夹具限制跳过；exit 0 |
| JJ Linux 同源文件测试 | 20/20 通过，0 跳过；exit 0，约 1.8 秒 |
| 既有 trace cursor / journal 回归 | 17/17 通过；exit 0 |
| 项目类型检查与 Vite 构建 | exit 0，保留现有 >500 kB 提示 |
| 新 `.d.mts` 单独严格类型检查 | exit 0；runtime 目录不在原根 tsconfig include 范围内 |
| 独立并发/质量审查 | PASS，支持范围内无 P0–P2；核对源码与现有日志，未冒充再次实测 |

Windows 的跳过分别是持锁 namespace 目录改名、持锁 lockRoot 改名和文件 symlink 创建。前两项在释放锁后可改名，表明是 Windows 活句柄限制；不把它们当作 guard 拒绝的证据。相同源文件在 JJ 完成了这三项。Windows 的实际 lifetime 文件替换、traceRoot 替换、合法根目录交换、硬链接和 junction 用例都已通过。

验证包含两个真实进程的 writer/source 互斥、root exclusive 阻挡 writer、多 run 部分获取回滚、owner 退出释放、超时不执行 journal 回调，以及两个进程在临界区产生完整连续 60 项计数。日志内容是合成数据，没有伪造模型输出或读取生产运行。

开发中保留了初始缺实现 RED、测试子进程退出监听错误、受限环境 EPERM，以及普通 Windows fixture 失败。随后补出并修复了嵌套不同 run 的 journal 过早释放、稀疏 UUID 数组和空参数三个反例。没有把这些中间失败删掉或算作最终通过。

原命令、输出、实现报告、JJ 运行前源哈希核对和最终哈希见 [证据清单](evidence/archive-writer-fence-primitive-2026-10-21/manifest.json)。JJ 文件位于 `/home/jj/.local/share/weiwu/validation/native-lock-2026-10-21/adapter`；没有发布到生产版本。

## 后续

按 [接入计划](../superpowers/plans/2026-10-21-archive-writer-fence.md) 继续接实际生产者生命周期、SQL 回执/审批、对象、维护与备份。只有全部 writer 共同参与并完成竞争验证，才允许把独占 guard 用于恢复来源核对；取得锁本身不证明历史、费用、外部动作或验收关系正确。

本批为伍模型调用 0，JJ 生产变更 0；累计 $3.41、七笔未知费用及企业 profile 保持原状态。
