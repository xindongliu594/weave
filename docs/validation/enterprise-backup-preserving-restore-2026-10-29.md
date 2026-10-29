# 完整企业备份与保留恢复：阶段证据

日期：2026-10-29。开发基线 `b5249aa`，Task1 提交 `439fb25`、Task2 提交 `11aacf9`。当前已完成格式合同、一致导出及全新隔离目标的保留导入服务（Task1–3）；恢复后的执行隔离、重新激活和网页入口尚未完成，没有接管原业务备份。

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
- 复用原 archive 链接检查、checkpoint codec、canonical 和任务原提交证明。执行路径仍额外要求原数据库 claim_token；归档路径使用共用历史完整性校验，包中排除该临时列。Task3 的恢复后再次导出测试纠正了 Task2 额外要求 live claim 的做法，避免有效历史永远无法再次备份。immutable result 内旧 claim 标识继续作为原摘要输入，不认证恢复后的空 claim 列或失效设备。
- 原始金额、unknown 操作及父子关联、知识两代版本、成员与撤权用户、不可变审计、文件版本和 private 插件包均在真实临时数据库/文件夹中核对。工具/设备效果是已有测试夹具，不是员工真实模型交付证据。

现存 task recovery 初始化 codec 尚无生产 writer/固定载体绑定，因此未伪造 sourceHistoryDigest 或初始化记录来声称已验证；这类历史可保存，执行资格不能由备份签发。Task4 仍须以隔离/重新准入覆盖它。本阶段的物理及 SQL 引用完整性不代表允许执行。

JSONB 采用数据库文本是保真选择，不以 JSON.parse/stringify 重写数据库数值。导出/导入使用 SQL ::text/明确类型参数化 cast，当前已在 PGlite 两个拥有的 schema 中核对真实往返；纯加密单测和单后端往返不证明原生 PostgreSQL 并发兼容。

## Task3：隔离保留导入

- 复用同一个根/vault 锁、物理 manifest、SQL anchor/receipt、安装、确认与回滚机制；没有禁用触发器，没有 TRUNCATE，没有 importer 的 ON CONFLICT 忽略。仅在严格空目标中显式移除正式迁移的两条默认记录，再按固定 FK 顺序插入。
- 先导入没有 FK 的 department_versions，再导入 departments，让原触发器遇到准确历史主键，不用目标 now() 破坏原时间戳。审计 requested_by_audit_id 和操作 parent_operation_id 按行拓扑排序；提交前逐表重算行数与摘要，不一致就拒绝提交。
- 目标一旦已有业务、用户、身份激活、改过的默认设置、缓存、恢复代数/标记或交付/key/vault/plugin 文件，即只读拒绝。只有原 ensureVault 生成的**字节完全一致**说明和空 .obsidian 视为启动预置；改过说明或额外笔记仍拒绝。物理 before-image 在 SQL 导入前再次核对，避免预检后出现的新文件被覆盖。
- A/B 使用不同 schema 和目录。原 ID、成员和禁用状态、人工决定与审计父链、runtime 操作父链及 unknown 证据、费用小数、任务 canonical/检查点、源知识版本及删除状态均保留。B 维持自己的 database_id，原 SID 存储不复制，device token_hash 新填随机不可用值，claim_token 保持空。
- 实际调用原 vault 模块的两个独立 Node 进程，验证合成密文可以用恢复后的主密钥解开；没有读取真实 API Key。私有 native 包字节/hash 还原，只复制包，未加载执行。
- 缺 CAS 或活动笔记时，在发布恢复操作之前拒绝并清理未发布 stage；有效恢复能再次导出；同一目标重复导入拒绝，不重复插入审计/回执。每次核对原 A 全部 portable 行、trace 与 key 保持不变。
- 新的目标本机 enterprise_restore_admission 与行、receipt 在同一事务写入 quarantined。**这只是目标状态记录；Task4 全入口拦截未完成前，不能挂载或发布恢复接口，也不能宣称已获得恢复执行资格。**

额外修复：已撤回资料的原笔记可能已移到回收站，不再要求其旧路径存在；完整 SQL 版本/删除记录继续保留。在线包只带活动登记笔记，不包含整个 Obsidian 回收站/自定义配置。特殊合法 `__proto__` 文件名使用无原型字典保存，并实际核对其 trace 字节、vault 字节及物理 before/after manifest 条目；不静默漏打包。此特殊笔记是协议边界夹具，不是推荐的生产知识库摆放方式或员工工作证据。

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

Task3 最终定向检查为 **86 个不同案例，0 失败/跳过**：保留导入12、旧企业保护7、原物理恢复状态11、导出9、任务载体8、catalog1、v1 扩展7、纯格式/文件/旧 size/checkpoint19、原提交和相关停止断言12。随后只加细恢复组的成员、审批/审计和 runtime 自引用资料，再跑这12例仍通过；不把重跑叠加成98例。最终类型检查及构建日志单列。证据见 [evidence/enterprise-backup-restore-2026-10-29](evidence/enterprise-backup-restore-2026-10-29/)。

全部 A/B 目录与 schema 由测试创建并清理；这些是实际数据库/文件/进程证据，设备效果仍是夹具，不是 OpenShell 真隔离或付费模型验收。本批真实模型0、浏览器0、JJ操作0，七笔原未知费用和运行环境没有读取或更改。

扩大回归时整份 `task-accepted-stop-delivery.test.ts` 超过 runner 的 180 秒上限，退出 124；不能标整份通过。已对其中四个失败案例取得独立错误证据并修正夹具断言：同步 throw 使用 async 断言适配；未知 COMMIT 后的同一 writer 必须继续阻断，不能把 warm retry 当作独立重启。修正后上述 12 例实际通过，原始设备效果保持 0。整份长套件尚待单独完成，不能以这 12 例替代；未调整产品恢复/执行门禁或延长全局超时来掩盖失败。

先留存缺模块的红测试，再实现；中间发现并修复 name[] 驱动类型、固定 KDF 的 TypeScript 重载，以及非相邻文件前缀冲突 `a / a-b / a/b`。原始红/绿和中间失败保存在 `.private/enterprise-backup-20261029/`。核心输出和源码摘要见 [evidence/enterprise-backup-schema-2026-10-29](evidence/enterprise-backup-schema-2026-10-29/)。

仓库文本证据按 UTF-8 LF 计算摘要以适配 Git 行尾归一化，原始日志与实际验证输入摘要另外保留；备份内容和业务交付 SHA 继续按原字节计算。此阶段亦补正 P0 manifest 的行尾口径，历史原始记录未覆盖。

路径规则参考 [Microsoft 官方文件命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)，实际产品测试单列，不拿官方文档代替运行证据。数据库/Skill/沙箱复用依据仍见已批准的[调研](../research/reuse-and-ai-delivery-estimate-2026-10-29.md)。

## 后续实现与本轮验证更新

上面的 Task1–3 统计保留为历史批次证据。其后已在工作树接入 Task4 隔离与重新授权、Task5 独立进程故障用例，以及 Task6 企业备份 API 和设置页；不能继续把这些代码描述为“尚未实现”。这也不代表整套验收和发布已经完成。

本轮在 Windows 本机修复恢复状态读取入口：`active.json` 被截断、超过上限或被目录替代时，原来会泄漏 `SyntaxError` 或返回普通 422，现在统一返回 409 `BACKUP_RESTORE_RECONCILIATION_REQUIRED`。复用原物理 manifest、SQL 回执和写入屏障，没有新增恢复引擎或依赖。三例均先观察到预期失败，再修复通过。

实际断言不仅检查错误码，也检查新恢复 stage 被拒绝、写入屏障保留、原文件/待恢复文件/密钥/知识文件/manifest/损坏指针原样保留，且没有写入完成标志或 SQL 成功回执。测试中的密钥和资料全部为虚构数据。

| 本轮命令/范围 | 结果 |
| --- | --- |
| 原物理恢复状态（含新增三例及四阶段进程重启） | 14 通过 |
| 企业备份 HTTP API | 10 通过 |
| 隔离、重新登录与执行准入 | 25 通过 |
| 资源入口与版本重新授权 | 6 通过 |
| 全新目标保留导入 | 13 通过 |
| 旧 v1 企业数据保护 | 7 通过 |
| 网页纯状态与 SSR | 4 通过 |
| 合计 | **79 通过，0 失败，0 跳过**，不是全仓通过率 |
| `npm run build` | **退出 0**，包含 TypeScript；保留既有 Vite >500 kB chunk 提示 |

命令、红/绿输出及源码摘要见 [本轮证据](evidence/enterprise-backup-recovery-guard-2026-10-29/manifest.json)。首次受限测试无法连接自建本机端口，不计产品红测试；改用正常本机权限后取得真实断言失败。首次绿测试有一处夹具顺序错误：未决恢复故意保留写入锁，不能再次申请同一锁后期待进入内部检查；调整检查顺序并断言锁仍受阻后，相关套件全部通过。受限构建无输出持续 171 秒后停止，正常本机权限重跑构建通过。

用户已取消全量迁移，后续继续本机开发；原项目与历史数据保留。本轮没有 Git 暂存/提交/推送、JJ 部署或付费模型调用。

## 网页、重新登录与最终审查补验

在上述 79 项批次之后继续完成本机开发；以下统计按本轮最终各测试文件计数，不能与之前重跑的文件直接相加。

- **网页实际操作通过**：从设置页下载 v2 → 切换独立空目标 → 上传并预览 44 表/2 文件/1 笔未知费用 → 输入确认词并导入 → 显示隔离和物理核对通过。本机 owner 的激活按钮不可用。首次导入编号 `c875fc2d-9443-4376-9286-ff1a2ca0ea0b`；修复排版后的独立目标编号 `4d1a3e89-5ffe-4414-99f4-835a6b1989b5`。两次临时服务退出时均实际核对来源未变化并清理自己的临时目录。
- **修复实际网页问题**：401px 窗口下，原全局 flex banner 将状态、编号和说明挤成窄列。改为块状状态区和独立操作按钮区；实际复查状态区 `clientWidth=scrollWidth=251`，正文各宽约 219px。保存修改前后截图，没有用组件测试代替浏览器证据。
- **本地受信 TLS/OIDC 协议通过**：复用现有 `oidc-provider` 测试服务及 `openid-client`，实际完成管理员登录、HTTP 导出、隔离导入、旧 Cookie 拒绝、重新登录和 CSRF 校验后激活。即使保留同一个合成签名秘密，旧会话也没有权限；实际 `createApp` 重启拒绝本机模式降级，错误 bootstrap subject 不能接管。激活幂等且只追加一次审计，未知费用保持 uncertain。这里不是公司真实 IdP，也不是浏览器完成 OIDC 全流程。
- **独立代码审查发现并关闭 1 项 Important**：原 `waiting` 经理消息可以随备份进入目标，解除隔离后后台可能自动发送付费请求。导出和导入现在都检查 `waiting/replying`，返回 `BACKUP_SOURCE_BUSY`，提示等待结束或在来源对话页取消等待。不会自动修改或取消来源消息；终态历史照常保存。导入检查发生在 staging 前，不能用旧包绕过。过时的“接口尚未挂载”注释也已修正；独立只读复核确认这项代码问题已关闭。

| 本轮最终文件范围 | 通过项数 |
| --- | ---: |
| 排队经理消息的导出/导入与保留证明 | 7 |
| 一致导出、全新目标保留导入、网页 HTTP API | 9 + 13 + 10 |
| 本地 TLS/OIDC 恢复、身份初始化屏障 | 7 + 4 |
| 网页状态/SSR、身份前端会话 | 4 + 13 |
| 合计 | **67** |

最终各文件无失败/跳过，类型检查和构建退出 0，保留原 Vite 大 chunk 提示。组合回归首次退出 1：新增夹具误把首次锁申请正常创建的 `root.gate` 当成恢复写入；其余 43 个集成测试通过。先初始化原有锁文件后只重跑受影响的 7 项，实际退出 0。原始失败日志保留，没有降低产品门禁或将该失败计为成功。此前红测试中 waiting 的导出/导入均实际出现“缺少预期拒绝”；后两个失败是错误导入后目标已占用造成的级联，不能算更多独立漏洞。

证据与源码摘要：[网页及身份补验清单](evidence/enterprise-backup-web-identity-2026-10-29/manifest.json)。操作路径：[企业备份恢复说明](../deployment/enterprise-backup-recovery.md)。浏览器仅使用合成资料；生成的 5,115 字节 Downloads 测试备份已解密核对归属和 SHA 后删除，截图和小型证据保留。本轮没有付费模型、Git 修改或 JJ 部署。

## 尚未完成

- 原生 PostgreSQL 的独立连接等待、提交/回滚和跨引擎格式兼容：当前没有配置已拥有的测试实例；此前跳过的 13 例仍是未验证，不能由 PGlite 证明替代。
- 公司真实 IdP、受信生产 HTTPS 和目标部署的完整登录/重新授权；网页导入与本地 TLS/OIDC 已分别通过，但尚不能合称公司环境端到端验收。
- 整份停止任务长套件的既有超时，以及企业备份发布；独立代码审查已完成并关闭发现的问题，本轮没有据此声明整个仓库通过或更新 JJ 生产服务。

当前属于“已实现、定向回归通过、剩余验收待补齐”，尚不能标记整个 F1 企业备份交付完成。
