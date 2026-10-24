# 阶段提交验证证据

日期：2026-10-24。以下均为本机隔离测试；没有付费模型、生产数据库或 JJ 部署。

| 文件 | 命令或场景 | 实际结果 |
| --- | --- | --- |
| [build-initial-type-errors.txt](build-initial-type-errors.txt) | 首次 `npm run build` | 两处新测试导入缺少声明；随后只修导入方式 |
| [build-final.txt](build-final.txt) | `npm run build` | 退出 0；TypeScript 和 Vite 通过；既有 500 kB 包体提示保留 |
| [interfaces-initial-with-retry-failure.txt](interfaces-initial-with-retry-failure.txt) | 隔离 runner：app-startup-recovery、backup-restore-state、backup-writer、run-current-authority | 前三套分别 4/4、11/11、5/5；最后一套 10 通过、1 失败，真实暴露重试成功缓存绕过原批准人撤权 |
| [authority-and-routes-final.txt](authority-and-routes-final.txt) | 修复后隔离 runner：run-current-authority、api-enterprise-boundary | 11/11 + 1/1，通过且无跳过；重试同时覆盖旧缓存、新请求与准入后事务前撤权 |
| [runtime-final.txt](runtime-final.txt) | `node --test`：observation-summary、trace-observation、archive-root-scope、archive-maintenance-scope、tool-effect-runtime、runtime-tool-inventory | 48/48，通过且无跳过 |
| [backup-native.txt](backup-native.txt) | 新建 PostgreSQL 17.10 独立实例：`node --import tsx --test tests/backup-restore-native.test.ts` | 6/6，通过且无跳过；四处真实 kill/restart，两个独立后端提交/回滚屏障 |

隔离接口 runner 命令前缀是 `node scripts/test-integration.mjs`，每个文件获得新的 PGlite + pgvector 数据库。此类测试不提供独立后端数据库锁竞争证据。runtime 使用实际已安装 DSH 与本地工具，模型适配器为无付费协议夹具。

原生测试显式要求 `BACKUP_RESTORE_POSTGRES_URL` 指向 loopback、`weiwu_test` 用户和随机命名的一次性测试库；无地址时明确跳过，不会读取生产数据库配置。本次运行原始实例结果为 PostgreSQL 17.10、两个不同 backend PID、行锁确实阻塞、退出 0、`stopped=true`、`dataRemoved=true`；不发布地址、密码或进程标识。

输出仅做路径脱敏与移除拥有者临时目录列表，保留失败、通过、数量和耗时。原始输出与首次失败均保留本机私有阶段目录。重复运行不累加为独立用例总量。此检查点不包含全仓全环境验收、真实模型质量、真实 IdP 浏览器或物理 OpenShell 隔离证明。
