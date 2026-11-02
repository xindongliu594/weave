# 企业备份原生 PostgreSQL 验证

基线 `417b46e`，保留上一批本地停止任务测试修复。依据既有企业备份计划 Task5，补齐原生 PostgreSQL 证据；不将 PGlite 的单后端功能结果替代并发验证。

## 已有实现和复用选择

- 复用旧测试缓存中的 `@embedded-postgres/windows-x64@17.10.0-beta.17`，实际执行版本为 PostgreSQL 17.10。复用原有 initdb/pg_ctl 的随机目录、所有权标记、回环端口、随机密码、停机后检查及清理流程。
- 本机没有可用 Docker、已安装 WSL 发行版或 MSVC/nmake。pgvector 官方 Windows 路径是源码编译：[固定 v0.8.7 文档](https://github.com/pgvector/pgvector/blob/v0.8.7/README.md#windows)。本次只为隔离验收选择[社区 PG17 Windows 编译包](https://github.com/andreiramani/pgvector_pgsql_windows/releases/tag/0.8.7)，不是官方二进制或生产运行依赖。
- 下载 ZIP 与发布页 SHA256 一致：`acd9d678200e856623f0b7416f6f5d132ef8606a2273ff37f0fdf8a7f2c5d7d2`；DLL 为 AMD64，SHA256 `bb2dc3ebe638e5c15fc278cf145f8c7c325414cb731b42acb460413507cb05cb`。检查解压路径和大小，仅复制 DLL、SQL 和 control 至原 PostgreSQL 的独立副本；原缓存不改。
- GitHub API 因公共出口限流失败；转用公开固定发布页读取相同下载地址与 SHA256，没有读取 GitHub 凭据或重复同一 API 路径。

## 执行顺序和边界

1. 先证明实际 `CREATE EXTENSION vector`、版本 0.8.7 和向量距离结果，再证明两个连接拥有不同后端 PID。
2. 运行现有 `backup-restore-native.test.ts` 六项：四阶段进程终止/恢复，以及原事务分别 COMMIT/ROLLBACK 前第二后端实际处于 Lock 等待。
3. 在另一新数据库运行现有 `enterprise-backup-native.test.ts` 七项：真实 v2 导出/导入的四阶段终止与重启，以及已提交后的 marker/generation/交付文件损坏保护。
4. 原样保留失败日志；若原生环境暴露产品差异，先定位、写复现再修复，不能替换 vector 类型、跳过完整迁移或放宽 schema/恢复门禁。
5. 完成后停止精确拥有的临时实例、检查 stopped 状态再清理其 data 子目录。测试失败保留私有证据；随机密码文件结束时删除，公共报告只存无凭据结果。

原有测试入口和文件均沿用，没有新增备份引擎、服务安装、模型调用或 JJ 部署。测试流程脚本、二进制和合成数据位于忽略目录 `.private/enterprise-native-20261029/`，公共证据只保留小型日志和哈希。

## 当前结果

首轮运行 `6c20e3d7-22f5-4d94-84f5-1dacb0ca2f09`：实际 PostgreSQL 17.10、pgvector 0.8.7，两个后端 PID 为 636 / 37600。原物理恢复六项通过；企业 v2 七项在导出前被 `BACKUP_SCHEMA_UNSUPPORTED` 拒绝，本轮退出 1，临时实例已停止。

实际逐字段对照发现，44 张表的唯一差异均是 NOT NULL 的系统目录表示：PGlite 0.5.8 使用 PostgreSQL 18.3，在 `pg_constraint` 中列出 `n`；PostgreSQL 17 把表列 NOT NULL 仅放在 `pg_attribute.attnotnull`。列、其他约束、触发器均相同。官方说明：[PG17](https://www.postgresql.org/docs/17/catalog-pg-constraint.html)、[PG18](https://www.postgresql.org/docs/18/catalog-pg-constraint.html)。专用目录诊断运行 `83b85c9e-b772-43eb-8607-cedb2d762928` 同样拒绝，原始快照和摘要保留。

修复选择：保留固定 schema ID 和已发出包的指纹，只有 PG18 之前把真实 `attnotnull` 投影为同一 NOT NULL 表示。列必填、FK、CHECK、触发器和未知表/列仍逐项校验；不忽略约束、不接受请求提供的结构、不修改正式迁移。增强原有 catalog 回归以验证丢失 NOT NULL/FK、增加 CHECK/触发器/列/表仍被拒绝，在原生与 PGlite 两边运行。

## 最终结果

修复后的原生运行 `49f0fbfc-37ef-4055-a1f6-09b769c55cbf` 成功退出 0，两个后端 PID 为 44540 / 16632。各文件最后一次有效结果：

| 环境/文件 | 通过 | 失败/跳过 | 实际覆盖 |
| --- | ---: | --- | --- |
| 原生 `backup-restore-native.test.ts` | 6 | 0/0 | 四阶段崩溃，以及真实独立后端分别等到 COMMIT/ROLLBACK |
| 原生 `enterprise-backup-native.test.ts` | 7 | 0/0 | 完整 v2 四阶段恢复、三类损坏保留屏障、源 A 不变、目标隔离 |
| 原生 `enterprise-backup-catalog.test.ts` | 1 | 0/0 | 正式迁移和自定义 schema 均接受，六类结构漂移拒绝 |
| PGlite catalog/export/restore | 23 | 0/0 | 指纹兼容、原导出及新目标保留导入回归 |
| 格式/crypto 纯测试 | 8 | 0/0 | 原格式、大小与无损 codec |
| 测试脚本清理故障注入自检 | 5 | 0/0 | 停机失败或状态不明必须非零，保留 data；已停机正常清理 |

`npm run build` 退出 0，包含 TypeScript 和 Vite；原大包提示仍在。原生合计 **14 项** 是三个文件的最终结果，最初整轮仍退出 1，不能改写为整轮成功。PGlite 与原生按不同环境记录，不宣称额外的独立业务案例，也不与前批 79/67 等重叠数字相加。

正常四阶段真实 v2 恢复操作：

| 阶段 | operationId | 重启结果 |
| --- | --- | --- |
| prepared | `f9fa2460-5385-49bc-a2e0-91d87c82ffd6` | rolled-back |
| old-moved | `2433ddcf-d305-4fc4-92bb-9d8e60b96001` | rolled-back |
| installed | `1de50e95-3457-4e12-b174-4a2161b9f3eb` | rolled-back |
| committed | `4a8216de-4161-412b-9747-c7475373a49e` | committed + quarantined |

独立只读审查未发现产品兼容补丁问题，发现测试 runner 在停机状态未确认时仍可能退出 0。实际清理代码的故障注入先观察到 `stop-failed` 的退出码 0/1 断言失败，再补最小错误/非零处理，五项自检通过。修复后又用真实目录回归核对正常停机和清理，退出 0、stopped/dataRemoved 均为 true；该重复案例不重复计入原生 14 项。

原生成功运行 data 自动清理；三份失败/诊断运行在保存原始日志及目录快照后，逐一核对所有权、真实路径、密码文件已删除、精确 pg_ctl status=3，再删除其 data。原失败日志、44 表目录快照、运行记录和可复用二进制保留。没有未停止的本批临时实例。

证据清单：`docs/validation/evidence/enterprise-backup-native-2026-10-29/manifest.json`。包含命令/退出码、运行 ID、阶段 operationId/inputDigest、双引擎原始目录对照、红绿日志、源码/运行时哈希、清理自检及数据清理回执。没有 API Key、随机数据库密码或真实业务资料。

本轮新增修改仍在本地，未额外推送或部署。真实公司 IdP、JJ 部署环境完整往返、其他 PostgreSQL 主版本/操作系统和全仓库回归仍未验证；企业 task profile 门禁保留。此结果关闭“原生 PG 十三项未执行”的缺口，不等于完整企业落地或整个项目验收完成。
