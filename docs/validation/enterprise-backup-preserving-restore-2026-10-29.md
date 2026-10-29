# 完整企业备份与保留恢复：阶段证据

日期：2026-10-29。开发基线 `b5249aa`。总体功能仍未完成，当前仅完成计划 Task1 的格式、受控数据库合同与纯加密/验证部分；没有新恢复路由，没有接管原业务备份。

## 已实现

- 从正式迁移的空 PGlite 0.5.8 提取固定 **44 张业务/身份/审计/操作表**的列、主键、唯一键、外键及约束/触发器指纹；固定数据独立存放并深冻结。实际导出前必须与当前数据库比对，未知表/列或不同约束拒绝，不能任意枚举后导入。
- v2 AES-256-GCM/scrypt，复用 Node 现有原语，无新依赖；KDF 参数固定，头绑定 AAD。旧 v1 实现未变，也未放松身份/审计拒绝保护。
- bigint、numeric、vector 和 JSONB 采用文本编码；保留 JSONB 内大数精度、SQL NULL/JSON null 差异及时间戳微秒。未知列、重复主键/唯一键、缺父引用、环和不符 manifest 拒绝。
- 50 MiB 解压完整 JSON /70 MiB envelope、每表及整体行数、文件数和 native bundle 展开上限；错误密码、头/内容篡改、认证有效的压缩炸弹仍受限。
- 复用原 native manifest 校验和 code/metadata/compressed 摘要；只保存固定包，不加载或执行工具。会话存储和设备/claim 临时凭据不在 portable 合同中，历史审计标识继续保留。
- 可移植路径拒绝遍历、ADS、设备名、大小写/Unicode 归一化碰撞、未配对代理字符及文件/目录前缀冲突；真实 filesystem 链接归属检查仍由后续 IO 阶段负责。

JSONB 采用数据库文本是保真选择，不以 JSON.parse/stringify 重写数据库数值。后续导出/导入必须按固定 codec 执行 SQL ::text/明确类型参数化 cast，并用真实数据库往返核对；当前加密单测不证明完整导入已完成。

## 实际验证

| 命令 | 结果 | 证明范围 |
| --- | --- | --- |
| `node --import tsx --test --test-concurrency=1 tests/enterprise-backup-schema.test.ts` | **8/8，0 跳过** | 纯格式、加密、无损编码及负向资源/路径验证；包含 50 MiB 等号边界 |
| `node scripts/test-integration.mjs tests/enterprise-backup-catalog.test.ts` | **1/1，0 跳过** | 正式迁移、两个拥有的 schema 命名相等；新增未知表/列均拒绝 |
| `node --import tsx --test tests/backup-size.test.ts tests/backup-checkpoints.test.ts` | **8/8，0 跳过** | 原 v1 31 MiB 往返、超限保护和检查点相关回归 |
| `npm run build` | **退出 0** | 当前类型检查和 Vite 构建；保留既有大于 500 kB chunk 提示 |

合计 17 个用例通过，不把开发中重复执行累计为新增案例。没有真实模型、浏览器、生产数据库或原生 PostgreSQL 多连接验证。

先留存缺模块的红测试，再实现；中间发现并修复 name[] 驱动类型、固定 KDF 的 TypeScript 重载，以及非相邻文件前缀冲突 `a / a-b / a/b`。原始红/绿和中间失败保存在 `.private/enterprise-backup-20261029/`。核心输出和源码摘要见 [evidence/enterprise-backup-schema-2026-10-29](evidence/enterprise-backup-schema-2026-10-29/)。

仓库文本证据按 UTF-8 LF 计算摘要以适配 Git 行尾归一化，原始日志与实际验证输入摘要另外保留；备份内容和业务交付 SHA 继续按原字节计算。此阶段亦补正 P0 manifest 的行尾口径，历史原始记录未覆盖。

路径规则参考 [Microsoft 官方文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)，实际产品测试单列，不拿官方文档代替运行证据。数据库/Skill/沙箱复用依据仍见已批准的[调研](../research/reuse-and-ai-delivery-estimate-2026-10-29.md)。

## 尚未完成

- Task2 全表一致导出、事务/文件锁和完整 carrier 闭包。
- Task3 全新目标的完整保留导入及物理/SQL receipt 接线。
- Task4 恢复后全入口隔离及重新核对权限，不能因恢复历史重新启用凭据或任务。
- Task5 真实进程中断和原生 PostgreSQL 等待/提交/回滚证明。
- Task6 网页/API 主流程及 JJ 验收部署。

固定指纹在 PGlite 的证明不能替代原生 PostgreSQL 兼容证明；未通过的引擎/版本不能静默当作兼容。阶段代码尚未接用户入口，不表示“企业备份已可用”。
