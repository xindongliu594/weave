# 恢复 evidence 迁移与固定备份目录验证

日期：2026-11-01。范围为 additive nullable `project_runs.task_evidence`、固定备份列/实际目录指纹与恢复 carrier 的明确拒绝。数据库测试按 root 分配的单执行槽运行，完成后归还；没有模型、费用、部署或 profile 开放动作。

## 变更与兼容边界

- `product-schema.ts` 只增加 `ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS task_evidence jsonb`，不设默认值、不回填、不复制 operation 或创建来源认证。
- `enterprise-backup-tables.ts` 将新列登记为 `['jsonb',false]`。现有 `readEnterpriseTables` 因而真实投影该列，SQL NULL 与 JSON `null` 仍分开保存，不静默遗漏新证据。
- `backup-checkpoints.ts` 显式拒绝 SQL 非 NULL 的 task evidence，以及 task profile 的 recovery/resume ancestry。恢复 carrier 的 source/import 合同尚未冻结；格式合法的 marker 不因此取得恢复或导入资格。普通 legacy forensic 保留原路径。
- 无旧 schema adapter：旧备份缺少新列或携带旧 schema SHA 时被严格 parser 拒绝，不补 NULL、不制造认证；测试确认传入旧包内容不变。没有删除、改写或转换用户原始备份。后续完整 carrier/旧格式转换单独实施。

`ENTERPRISE_BACKUP_SCHEMA_ID` 常量仍为 `weiwu-enterprise-2026-10-29-v1`；本次改变其严格目录与 `manifest.schemaSha256`，因此不得将同一个 schemaId 字符串当作跨列修订兼容证明：

| 字段 | 之前 | 本次实际目录 |
| --- | --- | --- |
| project_runs databaseFingerprint | `fc9d6a6be59b5ab1f3fd89259b87473f14565e91766ef52ce7fa7699b8babea4` | `b17a7de4dd8964b36a662d0faba3e0c28fa5dd90c8d56b7f9775565aa4ed1718` |
| enterprise schemaSha256 | `b93ac2713534f935ede925e74a2f7700729b7f647e4b12c7badceacba1c87331` | `13ca1ceb2a54c546e204c18246d93e674598034c5bb864fe030ada114ae972bc` |

新 databaseFingerprint 来自正式迁移后的 `inspectEnterpriseTable(pool,'project_runs')` 与原 `enterpriseCatalogFingerprint(table,current_schema())`，不是手猜；先观察旧固定值不匹配的真实失败，再使用输出替换。

## 验证

1. root 已先运行初始化测试中的 migration 用例，观察缺列 `0 != 1` 的 RED。本子任务另外观察固定列缺失 `undefined != ['jsonb',false]` 的 RED，以及 carrier 未拒绝时 `Missing expected exception` 的 RED。实现后两个无数据库测试通过。

```powershell
node --import tsx --test --test-name-pattern='fixed backup metadata|task recovery carrier' tests/task-recovery-schema.test.ts
```

最终 exit 0，2/2 通过。

2. 隔离工程验收：

```powershell
node scripts/test-integration.mjs tests/task-recovery-schema.test.ts
```

首次沙箱运行因连接临时 PGlite localhost 的 EACCES 未进入迁移；自动审批后仅在沙箱外跑同一个新建测试数据库。首轮有效 SQL 运行输出真实目录 fingerprint 后，在旧固定 fingerprint 的断言失败（exit 1，2 通过/1 失败）。更新实际指纹后最终 exit 0，3/3 通过、无跳过。

该用例验证：模拟旧 schema 行升级后 head/snapshot/status 等字段逐值保留；新列 nullable 且无 default；新行默认为 SQL NULL；重复正式迁移保留已有 evidence 原值；不新增 source/child operation、usage 或 model reservation；生产 `readEnterpriseTables` 投影保留新列的 NULL/非 NULL；全部固定目录通过 `assertEnterpriseCatalog`。其中旧 canonical 是仅用于迁移保留的合成值，不宣称运行来源已认证。

3. 原备份格式纯测试：

```powershell
node --import tsx --test tests/enterprise-backup-schema.test.ts
```

exit 0，8/8 通过。覆盖加密/大数/SQL NULL 与 JSON null、严格 schema/manifest、外键、路径与条目/大小限制。定向三个源码的 `git diff --check` exit 0。

## 源码 SHA256

| 文件 | SHA256 |
| --- | --- |
| `apps/api/src/product-schema.ts` | `13c0056532b4e9f10e28a845f6023056fc716ddfa923405eb39896d77b9875bb` |
| `apps/api/src/enterprise-backup-tables.ts` | `57332248891fcb21bfd66b09fda19266bf1a6ce905627bbd564f24306af1fa09` |
| `apps/api/src/backup-checkpoints.ts` | `af2579d746e19316db3342bf32f0df88419e83aed10f5529fca3d42a559a0e8b` |
| `tests/task-recovery-schema.test.ts` | `cd3761be6e80b633abb93722cb59900086de591b89da52e1a961a66b239b3d3e` |

这些是 PGlite 正式迁移/实际目录和纯备份格式证据。独立 PostgreSQL 目录/连接行为、备份实际导入、完整恢复 carrier、网页和真实模型恢复未由本子任务验证。
