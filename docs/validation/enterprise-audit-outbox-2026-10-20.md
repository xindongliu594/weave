# 企业审计投影：DB 基础切片

本报告只覆盖 D2 Task 2 的 DB projector 和安全原生 PostgreSQL 测试入口。失败请求采集、HTTP 接线、后台调度、网页查询、外发观测、保留及恢复仍未完成；没有在 JJ 开启新服务。

## 复用与实现

复用 Task 1 的不可变审计、既有 outbox 和 PostgreSQL 事务。每批最多 100 行，在同一短事务里核对完整 canonical 来源和 outbox 关联，插入本地投影并设置 published_at；该标记只代表本地 DB 提交。没有第二个活动 JSONL 写入者，也不执行工具或发送网络观测。

固定 advisory lock 918278 在取 outbox 行之前获得；行选择使用 SKIP LOCKED。投影上限 100000，满时保留原证据并让待处理行退避，不擅自删除旧投影。错误只记固定代码，退避为 1/2/4/8/16/30 秒，按当前持久 attempts 原子计算。丢失 COMMIT 应答时只更新仍 pending 的元数据，不重放业务、不推翻已发布结果。

本地投影保存经 schema 校验的身份、部门和版本归属，后续只能由授权查询展示；它不是可直接外发的 OTLP payload。

## 实际验收

| 检查 | 结果 |
| --- | --- |
| 独立源码与运行器安全审查 | PASS；纯保护测试独立 4/4 |
| 父任务运行器保护复验 | 4/4，拒绝不合法 URL/文件在连接前结束，回环探针零连接 |
| 原生 PostgreSQL 17.10 | **16/16、0 failed、0 skipped，20.38 秒** |
| 类型检查及构建 | `npm run build` 退出 0；Vite 7.30 秒，保留既有大 chunk 提示 |

原生套件实际覆盖：完整字段关联/摘要、旧身份兼容、微秒时间戳、失败前后重入、丢失提交应答、重试竞争、活动/损坏/缺失 JSONL、容量满、两个发布者、被独立连接锁住的 outbox 行、最后一个容量槽竞争，以及三次独立 worker 进程启动的去重。没有使用 PGlite 代替这四项原生并发/进程测试。

独立临时集群 ID：`4fc8a25f-8dc4-4be9-8a72-f4f94c6acead`。额外原生连接探针 PID 为 46280、42648，实际阻塞关系为后者等待前者；随后释放。测试仅使用随机 `weiwu_observation_test_` 数据库和拥有校验的随机 schema。结束核对 `stopped=true`、`dataRemoved=true`，临时口令文件删除；保留小型结果和输出。

可分享证据：`docs/validation/evidence/enterprise-audit-outbox-2026-10-20/`。原始集群日志保留在 `.superpowers/sdd/2026-10-20-real-postgres-validation/cluster-4fc8a25f-8dc4-4be9-8a72-f4f94c6acead/`。共用 runner 只允许 outbox 原生 fixture；Task 1 全套 audit-events 仍为直接 PGlite，不能因这个 runner 存在就改称原生验证通过。

## 发现并修复

- 原投影用 JavaScript ISO 显示时间落库，会截掉 PostgreSQL 微秒，造成已发布事件的重复关联失败。固定 `.123456Z` 的回归实际 RED→GREEN；关联列改为 SQL 直接复制原时间，显示摘要不充当精确关联依据。
- 丢失提交应答后可能已有另一个 worker 更新重试次数。退避不再使用旧行快照，而在 SQL 中按持久 attempts 计算；竞争回归 RED→GREEN。

## 继续条件

合法保留/清理仍须协调 Task 1 的 published/投影关联规则，不能删投影却留下表示完整投影的旧标记。备份恢复须保留目标历史并重建/重置本地发布事实，不能重放历史业务或旧设备操作。现有旧 TRUNCATE 恢复不据此获准。

后续实现 request-observation/失败事务和真实 A2/C1 边界后，才可标记 Task 2/3 对应接线完成。本阶段付费模型、生产数据库连接、JJ 变更均为零，十项企业基础能力总目标继续进行。
