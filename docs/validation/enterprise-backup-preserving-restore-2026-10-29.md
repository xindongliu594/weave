# 完整企业备份与保留恢复：阶段证据

日期：2026-10-29。开发基线 `b5249aa`，Task1 提交 `439fb25`。当前已完成格式合同和完整一致导出服务（Task1–2）；保留恢复、恢复隔离和网页入口尚未完成，没有接管原业务备份。

## 已实现

- 从正式迁移的空 PGlite 0.5.8 提取固定 **44 张业务/身份/审计/操作表**的列、主键、唯一键、外键及约束/触发器指纹；固定数据独立存放并深冻结。实际导出前必须与当前数据库比对，未知表/列或不同约束拒绝，不能任意枚举后导入。
- v2 AES-256-GCM/scrypt，复用 Node 现有原语，无新依赖；KDF 参数固定，头绑定 AAD。旧 v1 实现未变，也未放松身份/审计拒绝保护。
- bigint、numeric、vector 和 JSONB 采用文本编码；保留 JSONB 内大数精度、SQL NULL/JSON null 差异及时间戳微秒。未知列、重复主键/唯一键、缺父引用、环和不符 manifest 拒绝。
- 50 MiB 解压完整 JSON /70 MiB envelope、每表及整体行数、文件数和 native bundle 展开上限；错误密码、头/内容篡改、认证有效的压缩炸弹仍受限。
- 复用原 native manifest 校验和 code/metadata/compressed 摘要；只保存固定包，不加载或执行工具。会话存储和设备/claim 临时凭据不在 portable 合同中，历史审计标识继续保留。
- 可移植路径拒绝遍历、ADS、设备名、大小写/Unicode 归一化碰撞、未配对代理字符及文件/目录前缀冲突；Task2 另有实际 Windows 硬链接、junction、断链及读集合变化检查。

## Task2：完整一致导出

- 复用原根独占与 vault lock，抽出相同的“已知验证失败正常释放、未知结果保留安全屏障”封装；v1 直接复用，不放宽身份/审计保护。按 918274→918275 的现有 SQL 顺序取得锁，再启动 repeatable-read；全部受控表 SHARE NOWAIT 锁在首次数据快照之前取得。管理员在锁内重验。
- 固定列显式 SELECT，JSONB/numeric/bigint/vector SQL 文本输出，时间戳保留六位小数。不通过 JS number 改写金额或 JSON 大数。所有 44 表逐表核对行数；测试对原表完整行及文件/key 做前后摘要断言。
- trace 保留非 UUID 受管理路径；检查点 CAS 与后来的文件版本分别保存。只保存已登记的 vault 笔记及固定 native bundle；未同步的笔记明确拒绝，导出不索引或修改知识库。带密封凭据却缺原主密钥时拒绝。
- 复用原 archive 链接检查、checkpoint codec、canonical 和任务原提交证明。原提交校验只提取共用的历史完整性部分；执行路径仍额外要求原数据库 claim_token。源导出同时校验原 claim，包中排除该临时列。immutable result 内旧 claim 标识是历史摘要输入，不能认证恢复后的空 claim 列或失效设备。
- 原始金额、unknown 操作及父子关联、知识两代版本、成员与撤权用户、不可变审计、文件版本和 private 插件包均在真实临时数据库/文件夹中核对。工具/设备效果是已有测试夹具，不是员工真实模型交付证据。

现存 task recovery 初始化 codec 尚无生产 writer/固定载体绑定，因此未伪造 sourceHistoryDigest 或初始化记录来声称已验证；这类历史可保存，执行资格不能由备份签发。Task4 仍须以隔离/重新准入覆盖它。本阶段的物理及 SQL 引用完整性不代表允许执行。

JSONB 采用数据库文本是保真选择，不以 JSON.parse/stringify 重写数据库数值。后续导出/导入必须按固定 codec 执行 SQL ::text/明确类型参数化 cast，并用真实数据库往返核对；当前加密单测不证明完整导入已完成。

## 实际验证

| 命令 | 结果 | 证明范围 |
| --- | --- | --- |
| `node --import tsx --test --test-concurrency=1 tests/enterprise-backup-schema.test.ts` | **8/8，0 跳过** | 纯格式、加密、无损编码及负向资源/路径验证；包含 50 MiB 等号边界 |
| `node scripts/test-integration.mjs tests/enterprise-backup-catalog.test.ts` | **1/1，0 跳过** | 正式迁移、两个拥有的 schema 命名相等；新增未知表/列均拒绝 |
| `node --import tsx --test tests/backup-size.test.ts tests/backup-checkpoints.test.ts` | **8/8，0 跳过** | 原 v1 31 MiB 往返、超限保护和检查点相关回归 |
| `npm run build` | **退出 0** | 当前类型检查和 Vite 构建；保留既有大于 500 kB chunk 提示 |

合计 17 个用例通过，不把开发中重复执行累计为新增案例。没有真实模型、浏览器、生产数据库或原生 PostgreSQL 多连接验证。

Task2 最终定向验证（包含重跑 Task1/v1 规则，按文件不重复计数）：

| 范围 | 实际结果 |
| --- | --- |
| enterprise export /task export /catalog /v1 enterprise protection /extensions backup | 9+8+1+7+7 = **32 通过，0 跳过**，独立命令退出 0 |
| schema /实际文件读集合 /v1 size /v1 checkpoints | **18 通过，0 跳过**，退出 0 |
| 原任务提交和本次发现的停止任务断言（精确筛选） | **12 通过，0 跳过**，退出 0 |
| 合计 | **62 个定向用例通过**；不是全仓通过率 |
| 类型检查及构建 | `npm run build`，实际输出单列于 Task2 evidence |

Task2 证据见 [evidence/enterprise-backup-export-2026-10-29](evidence/enterprise-backup-export-2026-10-29/)。源码/日志摘要按 UTF-8 LF 记录，备份业务字节不归一化。

扩大回归时整份 `task-accepted-stop-delivery.test.ts` 超过 runner 的 180 秒上限，退出 124；不能标整份通过。已对其中四个失败案例取得独立错误证据并修正夹具断言：同步 throw 使用 async 断言适配；未知 COMMIT 后的同一 writer 必须继续阻断，不能把 warm retry 当作独立重启。修正后上述 12 例实际通过，原始设备效果保持 0。整份长套件尚待单独完成，不能以这 12 例替代；未调整产品恢复/执行门禁或延长全局超时来掩盖失败。

先留存缺模块的红测试，再实现；中间发现并修复 name[] 驱动类型、固定 KDF 的 TypeScript 重载，以及非相邻文件前缀冲突 `a / a-b / a/b`。原始红/绿和中间失败保存在 `.private/enterprise-backup-20261029/`。核心输出和源码摘要见 [evidence/enterprise-backup-schema-2026-10-29](evidence/enterprise-backup-schema-2026-10-29/)。

仓库文本证据按 UTF-8 LF 计算摘要以适配 Git 行尾归一化，原始日志与实际验证输入摘要另外保留；备份内容和业务交付 SHA 继续按原字节计算。此阶段亦补正 P0 manifest 的行尾口径，历史原始记录未覆盖。

路径规则参考 [Microsoft 官方文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)，实际产品测试单列，不拿官方文档代替运行证据。数据库/Skill/沙箱复用依据仍见已批准的[调研](../research/reuse-and-ai-delivery-estimate-2026-10-29.md)。

## 尚未完成

- Task3 全新目标的完整保留导入及物理/SQL receipt 接线。
- Task4 恢复后全入口隔离及重新核对权限，不能因恢复历史重新启用凭据或任务。
- Task5 真实进程中断和原生 PostgreSQL 等待/提交/回滚证明。
- Task6 网页/API 主流程及 JJ 验收部署。

固定指纹在 PGlite 的证明不能替代原生 PostgreSQL 兼容证明；未通过的引擎/版本不能静默当作兼容。阶段代码尚未接用户入口，不表示“企业备份已可用”。
