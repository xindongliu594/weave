# 批量费用写入与数据库尾部验证

状态：实现 `39a1efa`，基线 `def5d27`。限定原生数据库、费用回归、构建及独立审查通过。本轮零付费模型调用、零 JJ 生产变更；累计 $3.41 和七笔历史未知费用保持。

## 修复范围

费用预留过期和后台账单查询过期清扫原来直接执行 UPDATE。使用 pool 时，两次操作不在同一个受保护事务中；恢复读取取得互斥锁后，仍可能遇到绕过它的修改。

现在复用现有 PostgreSQL `918275` 事务锁：清扫自己持有连接，依次 BEGIN、shared 锁、原 UPDATE、COMMIT。错误时等待原 ROLLBACK；回滚也失败就丢弃该连接，保留最初错误，不重做业务操作。`reserveCall` 中的清扫继续使用原本已持锁的事务，不另开连接。金额、历史、查询次数与原筛选条件保持。

## 实际结果

| 检查 | 结果 |
| --- | --- |
| 原生 PostgreSQL 17.10 | 9/9，退出 0，无跳过；独立 writer/source/controller backend、实际 UPDATE 与 COMMIT。 |
| 加强断线及内部事务断言 | 上述 9 项中的受影响 3 项单独重跑，3/3，退出 0；不是另加三项独立功能。 |
| 费用与账单查询业务回归 | PGlite 12/12 + 17/17，退出 0；模型响应为本地测试替身。 |
| 类型与构建 | `npm run build` 退出 0，包含 TypeScript；已有 Vite >500KB 提示保留。 |
| 初始失败 | 限制环境无 TAP 超时 124、原生夹具 JSON 编码错误退出 1，均未冒充 RED。修正夹具后，原实现 1 通过/8 失败；另有原子回滚业务 RED。 |
| 独立审查 | PASS；核对四文件哈希和实际后端证据，未重复已通过套件。 |

原生测试在两个不同项目的假收据上检查：source 先持独占锁时，清扫在 UPDATE 前等待；原 UPDATE 或延迟 COMMIT 尚未结束时，source 等待真实写入事务；注入 SQL 错误后，先前的探测状态更新也正确回滚。原费用 `0.11`、`0.23` 和历史均逐行核对。

两个断线样例尤其说明了恢复为何不能只看调用错误：测试在实际 COMMIT 被阻塞时断开 writer 客户端。调用方看到连接异常；解除阻塞并由 source 取得 SQL 锁后，数据库中的两次原事务均已提交。测试依据持久结果确认，未重放业务操作。证据保存了 backend PID、锁模式、`pg_blocking_pids`、实际 SQL 与最终行。

## 环境与证据

测试使用本轮专属回环数据库 `weiwu_cost_tail_test_6b34551459144b38b25e50dbfe010c99`，最小独占 schema；无生产连接串、应用全量迁移或系统服务。固定 `embedded-postgres@17.10.0-beta.17` 与 Windows x64 同版本仅用于隔离二进制分发，安装禁用脚本；使用官方 initdb/pg_ctl，未使用 wrapper 的强制结束机制。

[证据清单](evidence/cost-maintenance-tail-2026-10-21/manifest.json) 固定四文件源码和 23 份证据哈希。[实施报告](evidence/cost-maintenance-tail-2026-10-21/task-2c.1-report.md) 包含确切命令、所有退出码和边界，[独立审查](evidence/cost-maintenance-tail-2026-10-21/task-2c.1-review.md) 已通过。环境工具副本保留原运行布局要求；私有连接配置与密码不公开。

审查后另行只读核对：残留测试 schema、backend、临时目录均为 0。官方 pg_ctl 正常关闭退出 0；确认数据目录身份、无链接、无 postmaster.pid 后，清理本轮约 49.8MB 测试数据及随机测试凭据配置，实际退出 0。日志及本计划唯一二进制缓存保留；[清理结果](evidence/cost-maintenance-tail-2026-10-21/native-cleanup-result.json) 与清单记录此状态。

## 仍未验证

本批只补费用批量写入的数据库保护，不是完整恢复链路。来源捕获仍须在 native source 后、行锁之前取得 exclusive `918275`，持有到校验和发布完成，并在初始化时重新核对实时预算、未知费用与次数。其他文件/HTTP/设备写入、严格 trace append、归档备份与企业来源批准仍未完成。未部署 JJ，未进行真实员工项目或设备验收。
