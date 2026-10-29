# Weave 加固 P0：剩余回归修复

日期：2026-10-29。基线 `91050f1`；总体目标继续执行，本报告仅覆盖首批回归，不表示企业功能全部完成。

## 改动与根因

| 项目 | 实际原因及处理 | 保护 |
| --- | --- | --- |
| 员工历史 | 现代部门/员工修改会写审计，旧业务备份应拒绝；归档资源按现授权合同隐藏为 404。拆分历史恢复与备份拒绝断言 | 完整配置、角色版本、唯一经理、CAS 和旧项目快照不变保留；不删除审计 |
| 执行策略 | 归档资源隐藏、无效知识在保存时拒绝、旧备份不支持现代审计，旧断言滞后 | 拒绝后版本/账本/运行/请求数不变；旧格式正向使用合法历史数据 |
| 身份存储测试入口 | 直接 PGlite 12 例原本通过；socket 触发器事务拒绝后错配后续响应。标准隔离入口精确选择已有直接 SQL adapter | 原测试/生产实现不变，其他文件仍走 socket；不是跳过失败用例 |
| 扩展备份 | setup 调现代知识发布产生审计，导致旧格式导出拒绝，随后五项测试级联失败 | 历史 SQL 夹具保留原六项往返；现代真实审计另验证导出/导入拒绝且数据和文件不变 |

独立审查还发现并修复两项测试缺口：执行策略旧格式夹具补入非空历史 run、有效档案与非零 usage，验证缺部门字段的兼容迁移；Windows 同一身份测试文件大小写路径一致选择直接 adapter，异目录与相似文件名不匹配。

生产业务、身份、权限、预算、来源和备份保护实现均未改变；可执行改动在隔离测试入口，其他改动为测试、计划和进度文档。完整企业备份仍是后续功能，不能把这些通过当成已支持企业历史往返。

## 本批最终验证

| 命令/范围 | 结果 | 边界 |
| --- | --- | --- |
| `node scripts/test-integration.mjs tests/identity-store.test.ts tests/employee-history.test.ts tests/extensions-backup.test.ts tests/backup-enterprise-protection.test.ts` | **30 通过、0 失败、0 跳过** | 真实临时 PGlite SQL/文件与本机 HTTP；验证直接身份分支后普通 socket 不串扰 |
| `node scripts/test-integration.mjs tests/execution-policy.test.ts` | **8 通过、0 失败、2 跳过** | 两项必须独立 PostgreSQL backend 的锁竞争未执行，不计通过 |
| `node --import tsx --test tests/policy.test.ts tests/test-integration-runner.test.mjs` | **14 通过、0 失败、0 跳过** | 原策略 10 例、新入口选择 4 例 |
| `npm run build` | **退出 0** | TypeScript 全项目检查、Vite 构建；既有大于 500 kB chunk 提示保留 |
| 独立审查 | 每项规格/质量通过；两项 P2 经修复后定向复核关闭 | 审查不替代执行；原生并发与总体企业验收未完成 |

以上核心命令共 **52 个通过用例、2 个明确跳过**，不把先前重复运行和相邻检查累加。首次失败与中间失败均保留，不从历史日志删除。

正常环境构建前，受限环境 TypeScript 超过 12 分钟仍未返回；核对本轮 PID/父进程/启动时间/命令后受控停止，未停止其他 Node 或服务。首次正常构建发现新测试对窄 TraceSnapshot 类型的元数据访问错误；改为比较显式历史 fixture 后，类型检查与网页构建通过。这两次均不计成功。

## 证据位置

公开核心输出和摘要见 [evidence/hardening-p0-2026-10-29](evidence/hardening-p0-2026-10-29/)。原始红/绿、中间失败、环境拒绝及受控构建中断日志在本机 `.private/hardening-p0-20261029/`；包含临时路径的原始日志不自动公开。

独立实施/审查报告保存在本批隔离 ledger：`.superpowers/sdd/2026-10-29-hardening-p0-regressions/`。报告记录具体命令和日志来源；不是新的生产数据。

本批没有使用 Computer Use、访问生产数据库、调用真实模型、提高额度或部署 JJ。没有宣称全量 191 份 TypeScript / 86 份 runtime 文件全部通过。

## 后续工作

继续 [完整企业备份与保留恢复计划](../superpowers/plans/2026-10-29-enterprise-backup-preserving-restore.md)：先实现严格 v2 格式和一致导出，再接全新隔离目标保留导入、恢复后执行隔离、崩溃一致性和网页入口。复用已有加密、根写入锁、物理 manifest/SQL receipt 及启动核对；不放松 v1 拒绝保护。
