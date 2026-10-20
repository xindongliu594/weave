# 备份恢复的企业目标保护

2026-10-20；本轮是旧破坏性 restore 的保护修复，不是企业数据保留导入或 task 备份验收。没有连接 JJ/生产数据库，没有调用付费模型，没有修改原预算或七笔未知预留。

旧在线恢复在 `TRUNCATE ... CASCADE` 后导入备份，可能删除目标部门关联的身份和审计历史；UPDATE/DELETE 的 append-only trigger 不能保护 TRUNCATE。当前修复在原 restore 事务内、任何清空和文件替换前，先锁定身份、会话、bootstrap、审计、outbox 和 projection 表，确认目标无企业历史。锁繁忙返回 `BACKUP_DESTINATION_BUSY`；已有历史或已变更 bootstrap 返回 `BACKUP_DESTINATION_PROTECTED`。使用 NOWAIT 避免等待身份签发形成死锁，取得的表锁保留至事务结束，封住检查与清空的竞态。普通空白 legacy 目标仍可恢复。

实际隔离 HTTP 验证：新增 3/3（空目标可恢复、仅 activated bootstrap 拒绝、有目标身份/成员/审计/outbox/projection 时拒绝且原数据/文件/密钥保持），原扩展备份 6/6 回归。首次 RED 是后两项原实现错误返回 200；没有把最初 loopback EACCES 记为产品失败证据。

另复用已缓存固定 PostgreSQL17.10，在工作区临时集群 `d417e47e-4efb-4fcc-a2b7-271a285ecfae` 核对真实并发：两个 backend PID 16280/14820，`pg_blocking_pids` 确认身份 INSERT 等待 restore 表锁；提交后新身份可见，下一次恢复被拒绝；已有身份写入事务时保护立即返回 BUSY。临时库 `stopped=true,dataRemoved=true`，密码文件和数据目录均已独立核对不存在。这是 guard 的并发证据，不代表完整 restore 的跨进程原子性、企业 preserving import 或真实物理沙箱通过。

窄范围独立代码审查 PASS；TypeScript 检查与 Vite 构建退出 0（9.24 秒，保留既有大于 500 kB 的 chunk 提示）。[测试、原生 PG 结果与审查证据](evidence/backup-enterprise-destination-protection-2026-10-20/)已归档，未包含临时数据库密码或原业务凭据。任务备份的只读证据承载、身份/审计保留导入、恢复后投影重建仍按 B2/D2/F1 计划完成；当前企业目标恢复被明确阻止，不会以这份报告代替实际验收。
