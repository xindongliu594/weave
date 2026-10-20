# 已验收任务停止：服务端状态与普通准入

在原 task_attempt_workspaces 增量加入 nullable accepted_stop，不建新队列。本批仅实现严格状态 codec 和普通执行保护，**不生成停止资格、不调用设备停止，也不开放 profile**。设备基础为 50826ad，后续产品调用链单独验收。

codec 限制 32 KiB，嵌套字段精确校验；原完整 key、proof 与 identity 以不同 domain 摘要绑定。规范 ISO 日期按实际时间值校验顺序，状态只接受允许的字段。所有未决停止阻断本 run 的普通任务绑定、scope、派发/领取/启动；已确认停止只封存原 key，其他获准任务及新 attempt 继续原权限检查，无豁免参数。

原设备回执仍走认证、去重及 late_result 记录，停止状态不能清除 SQL 操作未知。pending merge 被阻断，已 committed 原回执只读重取保留。

| 实际证据 | 结果 |
| --- | --- |
| 绑定/首代/错行 marker | 5 个具名 RED，旧实现缺少拒绝；修复后通过 |
| 原表迁移 | 实际缺列 RED；ALTER 后旧行 NULL、原历史保留 |
| 日期边界 | 扩展年份的字典序误判 RED；改为时间值后通过 |
| 最终隔离集成 | state 10、HTTP 3、bridge 11、canonical 17：41/41，无跳过 |
| 原 scope 回归 | 25/25，无跳过；旧手工表 fixture 只加 nullable 列 |
| 类型检查 | tsc --noEmit exit 0 |
| 独立代码审查 | PASS；7 个源文件 SHA 与证据一致 |

命令、原始 RED/GREEN、SHA 和审查见 [evidence](evidence/accepted-task-stop-sql-2026-10-20/)。新 marker 是合成守卫夹具；HTTP 的成功 prepare/result/merge 走真实队列、claim/start/result/CAS。PGlite 证据不替代原生 PostgreSQL 并发或真实 OpenShell 验收。

仍待完成：历史 accepted/v2 CP/原操作证明、生命周期 CAS/provider 接线、三个员工实际释放容量的产品链，以及恢复/维护/备份和 Task6。无新增付费调用、预算调整、JJ 写入、安装或原历史改写；七笔未知预留保留。
