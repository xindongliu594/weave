# Enterprise Backup Preserving Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan does not authorize subagents, installation, paid calls or JJ deployment.

**Goal:** 从网页导出完整、版本化的加密企业数据包，在全新隔离目标中恢复身份、授权、审计、费用、操作及恢复证据，保留原环境并在重新核对前禁止执行。

**Architecture:** 复用现有 SQL 快照、ArchiveWriterManager 根独占锁、vault lock、AES-GCM/scrypt、checkpoint codec 和 backup-restore-state 的物理 manifest、SQL receipt、启动核对。新增 v2 显式表合同和只向空目标插入的导入器；恢复历史不等于恢复信任。旧 v1 路径及其身份保护不变，不建立第二套备份引擎。

**Tech Stack:** 当前 Node/TypeScript、Express 5.1.0、pg 8.16.3、Zod 4.1.5、React 19.1.1；测试复用 PGlite 0.5.8、pgvector 和已有隔离原生 PostgreSQL fixture；无新依赖。

**Spec:** `docs/research/reuse-and-ai-delivery-estimate-2026-10-29.md`（用户已批准）；范围约束见根 `AGENTS.md`。本计划补足该研究的 F1 实施合同，不表示功能已实现或通过。

## Global Constraints

- 为伍仍运行在 JJ；本阶段只在当前隔离工作树开发/测试，不访问、安装或部署 JJ，不调用付费模型。
- 固定 DSH `0.1.5-rc.1`、AgentTeams `0.1.20`、OpenShell `0.1.2`；企业 task 执行门禁继续关闭。
- 不删除、覆盖源环境，不清除目标已有身份、审计、操作或费用；不禁用触发器、不 `TRUNCATE ... CASCADE`、不以 `ON CONFLICT DO NOTHING` 丢弃冲突。
- 备份/恢复均要求停止队列/运行任务、等待进行中模型调用和经理回复结束；未知费用、未知效果必须完整保留。
- 用户通过网页操作，不要求手写 SQL。全新目标部署及 OIDC 密钥配置仍是运维操作；不在备份中携带目标会话签名密钥、OIDC client secret 或主机绝对目录授权。
- 完整停机目录副本是运维兜底，PGlite `dumpDataDir/loadDataDir` 可用于隔离快照，原生 PG 沿用原生工具；它们不替代本计划的网页 v2 交付。超过在线限额须明确拒绝，不能声称任意大小在线备份已完成。
- 证据分接口、组件、独立进程/原生 PG、浏览器、真实模型；本阶段真实模型次数为 0，不将 PGlite 单后端锁测试描述为独立连接竞争。

## Review Focus

1. 目标已有一条 audit/operation 或额外用户：导入前 409，既有记录/文件/key 原样保留（Task 3）。
2. 包虽成功解密却有遗漏表、额外列、断裂自引用、路径大小写碰撞、压缩炸弹：422，未创建 stage（Task 1/2）。
3. 原 SID、设备令牌、过时管理员/权限或来源相同但版本已变：不得恢复执行权（Task 4/6）。
4. SQL COMMIT 已执行但客户端超时，或物理文件换一半：重启依赖原回执判定，不能重放导入（Task 5）。
5. 旧 checkpoint 后有未知工具效果或费用、task carrier 缺一个 CAS 对象：证据保留、恢复执行拒绝，不能释放费用或回退历史（Task 2/4）。

---

## 已核对的复用与文件边界

`backup.ts` 的 v1 列表未覆盖身份/审计、`local_operations`、`task_attempt_workspaces`；`backup-destination.ts` 有意拒绝这些企业依赖。`identity-schema.ts` 明确要求 session/login transaction 排除备份。`human_audit_events`、`tool_effect_contracts`、runtime `local_operations` 有不可变触发器。`backup-restore-state.ts` 的 anchor/receipt 是本机控制状态，不能从源包复制到目标。`app.ts` 已在 identity 初始化和 coordinator 启动前核对恢复状态，必须沿用该顺序。

| 文件 | 工作 |
| --- | --- |
| 新 `apps/api/src/enterprise-backup-schema.ts` | v2 严格格式、固定表/列映射、纯验证、导出类型；不得动态执行包内 SQL |
| 新 `apps/api/src/enterprise-backup-export.ts` | 全表一致快照和文件闭包，调用现有锁/加密实现 |
| 新 `apps/api/src/enterprise-backup-restore.ts` | fresh-only、有序 INSERT、物理安装及现有 receipt 接线 |
| 新 `apps/api/src/enterprise-restore-admission.ts` | 目标本机 quarantine、验证/激活和统一执行准入 |
| 改 `backup.ts` | 保留 v1，路由分派 v2、提取共用受限加密 helper，复用根锁封装 |
| 改 `backup-checkpoints.ts` | v2 task/workspace/operation carrier 闭包验证，继续调用现有 codec，不重写其格式 |
| 改 `backup-restore-state.ts` | 仅在必要时支持同一事务的 v2 admission marker，保持现有 manifest/receipt 语义 |
| 改 `db.ts`、`app.ts`、`api-route-policies.ts` | additive 本机 marker 迁移、启动及入口门禁、显式路由分类 |
| 改 `execution-policy.ts`、`run-current-authority.ts`、`local-execution.ts`、`manager-chat.ts`、`automation-learning.ts`、`cost-control.ts` 及对应调用入口 | 恢复隔离门禁覆盖效果、设备/自动化/模型，而非只禁按钮 |
| 改 `apps/web/src/SettingsCenter.tsx`；新 `apps/web/src/enterprise-backup-state.ts` | v2 导出、预检、空目标导入、核对/重新登录状态，纯状态函数可测试 |
| 新 `tests/enterprise-backup-{schema,export,restore,admission,ui,native}.test.ts` | 下列红绿断言；扩展现有 crash fixture |
| 新 `docs/validation/enterprise-backup-preserving-restore-2026-10-29.md` | 实际来源指纹、命令、结果、未验证项；实现时生成 |

官方来源沿用研究报告第 4 节的固定版本核对和链接。PGlite dump/load 不解决跨引擎行格式、外部文件一致性或信任；所以只补为伍特有格式/接线，不新增通用备份库。

## v2 格式与表合同（Task 1 固化）

新增 envelope `format: 'agent-department-enterprise-backup-v2'`，精确字段 `format,kdf,cipher,salt,iv,tag,data`；固定 `kdf:'scrypt-n16384-r8-p1'`、`cipher:'aes-256-gcm'`，16-byte salt、12-byte IV、16-byte tag，canonical base64，认证 envelope 固定头作为 AAD。沿用现有 crypto/zlib；v1 编解码语义不变。密码 12–200 字符。

解密 payload 精确字段：`version:2, schemaId:'weiwu-enterprise-2026-10-29-v1', createdAt, source:{applicationVersion,databaseId,engine}, tables, files, master, nativePluginBundles, vaultFiles, manifest`。`schemaId` 的兼容合同绑定受控列清单及 FK/触发器 fingerprint；发现未知迁移/列必须拒绝而不是猜测默认值。后续迁移另加显式 schemaId adapter。engine 是 `pglite|postgresql`，只作来源信息，不代表物理可移植。

`manifest` 为各表行数/规范排序后的 SHA-256 和每个文件的 root kind、相对路径、字节数、SHA-256；`files` 只含 trace 根相对路径，vault/bundle 分别沿用其 validator。JSON 日期明确 ISO 字符串；bigint、numeric、vector 用无损文本 codec，不能把金额先转 JS number。每表仅接受固定列；SQL 用该映射的显式列参数化 INSERT。缺表（即使应为空）、重复 PK/唯一键、未知表/列、未知根、哈希不符均拒绝。

上限保留现有 50 MiB **解压后完整 JSON**（包括 base64 文件）和 70 MiB HTTP body；外层文件统一上限 70 MiB，解码前检查，gunzip `maxOutputLength` 50 MiB。最多 100,000 文件、每表最多 100,000 行且总行数最多 500,000，bundle 最多 100，单 path 最多 1,024 UTF-8 bytes。现有物理 receipt 上限（128 MiB manifest、40 MiB vault、512 MiB 树）仍独立成立。错误明确 `BACKUP_SIZE_LIMIT`，UI/API 同值；禁止 UI 45 MiB 与 API 不一致。总 plaintext 同限仍是最终边界。

固定 portable 表如下，不能运行时 `SELECT *` 发现并导入所有 public 表：

1. 基础：`gateways, departments, department_versions, models, templates, knowledge_spaces, knowledge_documents, knowledge_revisions, knowledge_chunks, knowledge_embeddings, product_settings`。
2. 身份：`human_users, department_memberships, identity_bootstrap`；保留 issuer/subject/id/版本/epoch/历史 bootstrap，禁止重开源 bootstrap。
3. 业务：`projects, plan_versions, activity, usage, project_runs, model_reservations, model_capability_tests, organization_previews, organization_conversations, manager_messages, work_file_snapshots, mcp_connections, storage_cleanups, native_capabilities`。
4. 审计/效果：`human_audit_events, audit_outbox, audit_run_projection, tool_effect_contracts, tool_approvals, local_devices, local_operations, task_attempt_workspaces`。
5. 自动化：`automation_schedules, automation_occurrences, automation_notifications, automation_observations, automation_knowledge_candidates, automation_improvements, automation_evaluations, automation_reviews`。

**排除且不得输入：** `human_sessions, human_session_lifecycles, oidc_login_transactions, request_keys, backup_restore_anchor, backup_restore_receipts`，以及本计划新增的目标 `enterprise_restore_admission`。原会话安全生命周期不跨环境延续；不导出 SID/token/session JSON。保留会话相关审计事件已有的 actor snapshot，不伪造丢失会话。local_devices 只导出非凭据历史列及 disabled 形式；新目标随机不可用 token hash 填满足 NOT NULL，原 token 不进包。`backend/grant_id/label` 可保留为历史证据但无主机访问权。

**插入顺序：** 基础无依赖表 → human_users → identity_bootstrap/memberships/contracts → projects → plan_versions/project_runs/其余 run 子表 → audit 父链 → approvals → local_devices → operations 父链 → outbox/projection → 自动化各父/子表。准确有向边从受控迁移合同与 `pg_constraint` 比对：`tool_approvals.decision_audit_id→audit`、audit.requested_by_audit_id→audit、operations.parent_operation_id→operations；自引用做 Kahn 排序（最多行数已有限），缺父/环直接拒绝；不通过关闭 FK 解决。JSON 内的 runId/operationId/checkpoint/CAS 也校验闭包，不能只看 SQL FK。

文件覆盖仅声明受管理交付：trace 下 archive/CAS/checkpoint/canonical 文件、`work_file_snapshots` 内文件、已登记 vault 笔记与已登记 native bundles。导出前验证每个 committed manifest 引用的字节都在包中；遇到尚依赖外部工作目录且无归档对象的承诺交付即拒绝，不默默漏掉。现存 OpenShell sandbox/主机目录本身不能跨主机信任或复活，恢复只用已提交对象重建新授权工作区；环境配置、服务文件与任意外部目录仍由停机运维副本覆盖。

`departments` INSERT 的版本历史触发器会生成当前 `department_versions`：导入历史前对自动生成同主键行逐字段比对，相同则复用，否则拒绝；不盲用冲突忽略。fresh DB 的默认 product_settings 与 identity_bootstrap 只能在尚无历史/激活时按固定预置值核对后做显式处理。identity_bootstrap 原样导入，已有 activated bootstrap 目标不得被静默覆盖。

### Task 1: 固化格式、列清单及受限 crypto

**Files:** 新 `enterprise-backup-schema.ts`、`tests/enterprise-backup-schema.test.ts`；改 `backup.ts` 共用 helper。执行前从上述所有 migrate 函数提取完整列名/codec 字面量进 schema 文件；本计划不复制数百行数据库定义。

**Interfaces:** 导出 `EnterpriseBackupV2`、`EncryptedEnterpriseBackupV2`、`EnterpriseTableName`；`parseEnterpriseBackup(value:unknown):EnterpriseBackupV2`；`encryptEnterpriseBackup(value:EnterpriseBackupV2,password:string):Promise<EncryptedEnterpriseBackupV2>`；`decryptEnterpriseBackup(value:unknown,password:string):Promise<EnterpriseBackupV2>`；`enterpriseTableSpecs` 固定列/PK/FK/codec 描述。schema 名/表名绝不来自请求。

- [ ] 写测试 `strict_v2_roundtrip_and_lossless_money`：日期/大 epoch/numeric/vector 往返一致；加密包不含 SID/token/可检索明文；错误密码/头篡改 422。
- [ ] 写 `reject_unsupported_before_stage`：未来 schemaId、缺表/多列、重复主键、自引用环、非 canonical base64、50 MiB+1 解压 JSON、70 MiB+1 envelope、行/文件上限及大小写/Windows 路径碰撞均失败；边界等号通过。路径拒绝 `..`、反斜线、绝对路径、驱动器、ADS、NUL、设备名、软/硬链接。
- [ ] 运行 `node --import tsx --test tests/enterprise-backup-schema.test.ts`，确认新断言先红；实现以上接口和固定表 codec。
- [ ] 同命令绿；再跑 `node --import tsx --test tests/backup-size.test.ts tests/backup-checkpoints.test.ts`，v1 回归零失败。提交该任务指定文件，message `feat: define bounded enterprise backup v2 contract`。

### Task 2: 完整一致导出和 carrier 闭包

**Files:** 新 `enterprise-backup-export.ts`、`tests/enterprise-backup-export.test.ts`；改 `backup-checkpoints.ts`、`backup.ts`。

**Interfaces:** `exportEnterpriseBackup(input:{principal:Principal;traceRoot:string;writers:ArchiveWriterManager;state:BackupRestoreState;password:string}):Promise<EncryptedEnterpriseBackupV2>`；`validateEnterpriseBackupReferences(payload:EnterpriseBackupV2,stagedTraceRoot:string):void`。调用 Task 1 crypto 和现有 `validateBackupCheckpoints`，Task 3 复用后者。

- [ ] 建完整 fixture：human/admin+member+撤权用户、membership、human approval/audit 请求链、runtime/local operation 父链、task_attempt_workspaces、uncertain reservation/usage、knowledge version、checkpoint CAS/恢复 initialization 与 native bundle；断言所有受控表行数/hash、sourceId 和原 DB/files/key 前后 digest 相同。
- [ ] 写 `snapshot_denies_concurrent_writers` 及 `missing_carrier_is_rejected`：活动 run/经理/测试/pending 模型 409；未知费用/效果允许归档且原状态不变；缺 CAS、sourceHistoryDigest 对应来源、task refs/SQL original operation 对应证据失败。
- [ ] 运行 `node scripts/test-integration.mjs tests/enterprise-backup-export.test.ts` 先红。实现根独占→vault lock→现有 SQL advisory locks 918274/918275→事务/受控表 SHARE 锁→当前管理员重验→读取的顺序；快照第一次读取前获得全部需要的表锁。沿用成本维护锁顺序，锁忙/超时 409，未知提交/解锁置现有安全屏障。不要在 export 偷写 knowledge 索引；若必须 syncObsidian 则在快照前按原锁完成，并明确其写入。
- [ ] carrier 保留现有 trace 树/步骤 codec；task v2 继续用 `task-recovery-state.ts`、`step-checkpoints.mjs`、`task-original-commit.ts` 的固定对象/回执校验。格式尚无可信生产 writer 的 task carrier 可存证但标记 `executionEligible:false`，不得用备份自行签发可信来源。不能因此省略这些数据。
- [ ] 同命令绿，补 Task 1 回归；提交 `feat: export complete enterprise backup snapshots`。独立 PG 并发在 Task 5 证明，当前 PGlite 证据只证明功能。

### Task 3: 新目标有序保留导入，复用物理回执

**Files:** 新 `enterprise-backup-restore.ts`、`tests/enterprise-backup-restore.test.ts`、`enterprise-restore-admission.ts` 的 marker 迁移/写入部分；改 `db.ts` additive 迁移；必要改 `backup-restore-state.ts`，不改 v1 destination gate。本阶段函数暂不挂载产品路由，Task 4 完成门禁后才允许接入。

**Interfaces:** `preflightEnterpriseRestore(db:Pick<pg.PoolClient,'query'>,payload:EnterpriseBackupV2):Promise<void>`；`restoreEnterpriseBackup(input:{principal:Principal;payload:EnterpriseBackupV2;traceRoot:string;writers:ArchiveWriterManager;state:BackupRestoreState}):Promise<{operationId:string;status:'quarantined';inputDigest:string}>`。本任务定义并实现下述 `migrateEnterpriseRestoreAdmission` / `installRestoreAdmissionIn`，必须和行导入/receipt 同事务；Task 4 消费该 marker。

- [ ] 写 `fresh_restore_preserves_ids_history_and_original`：A 导出 B 导入，两个不同拥有标记临时根/DB，所有不含活动凭据的 portable 行按 codec/hash 相同、audit/FK 完整，A 未变，B 的 anchor.database_id 仍是 B。
- [ ] 写 `reject_nonempty_target_without_mutation`：对每类 protected/业务/history 表单行非空、已激活 bootstrap、修改过默认 settings、额外用户、额外文件、现存 credential.key（非 fixture 预置）分别 409 `BACKUP_DESTINATION_NOT_FRESH`；错误包无 stage，目标非空预检也在 stage 前。预检后竞态写入在 SQL 锁内重验，不能覆盖。
- [ ] `node scripts/test-integration.mjs tests/enterprise-backup-restore.test.ts` 先红。实现全表 NOWAIT 锁和 preflight；仅允许明确 migrate 创建的默认行。载入 staging 后调用 Task 2 validator，再在 SQL 锁内重验 freshness/当前本机管理员。严格 INSERT，保留 audit/operation/contract 触发器；数据库触发器额外生成行须显式校验，不静默吞错。
- [ ] 调用现有 `state.prepareRestore`（trace/vault/key/bundle）、导入行与 quarantine marker、`installArchive`、`recordCommitReceipt`、COMMIT、`confirmCommitted`；失败完全沿用现有 rolled-back/unknown 分支和保留前后树。绝不复制源 `.backup-restore-state`/lock/control。返回 `operationId/inputDigest` 可核对，响应不含秘密。
- [ ] 同命令绿；`node scripts/test-integration.mjs tests/backup-enterprise-protection.test.ts tests/backup-restore-state.test.ts` 必须仍绿，v1 仍拒绝企业历史。提交 `feat: restore enterprise snapshots into fresh destinations`。

### Task 4: 恢复隔离、费用及来源重新准入

**Files:** 新 `enterprise-restore-admission.ts`、`tests/enterprise-backup-admission.test.ts`；改 `db.ts`、`app.ts`、`execution-policy.ts`、`run-current-authority.ts` 及实际效果入口。

**Interfaces:** `type RestoreDb=Pick<pg.PoolClient,'query'>`；本机表 `enterprise_restore_admission(operation_id uuid PRIMARY KEY,input_digest text UNIQUE NOT NULL,status text NOT NULL CHECK(status IN ('quarantined','active')),source_issuer text,activated_by text,activated_at timestamptz)`；`migrateEnterpriseRestoreAdmission(db:RestoreDb):Promise<void>`；`installRestoreAdmissionIn(db:RestoreDb,payload:EnterpriseBackupV2,operationId:string,inputDigest:string):Promise<void>`；`assertRestoreExecutionAdmitted(db:RestoreDb):Promise<void>`；`activateRestoredEnvironmentIn(db:RestoreDb,principal:Principal,input:{operationId:string;inputDigest:string}):Promise<void>`。保留 marker，不重置 historical epochs；freshness 将本机 marker 非空也视为非空目标，防止重复导入。

- [ ] 写 `restored_credentials_cannot_execute`：旧 SID、旧 OIDC transaction、旧 device token 均失败；任何 local-owner/human 下排队、经理模型、模型测试、工具 dispatch、自动化唤醒、device poll/claim、MCP/native enable、task recovery 在隔离状态 409 `BACKUP_RESTORED_ENVIRONMENT_QUARANTINED`。API 读/核对照常授权，不靠改历史 run status 绕门禁。
- [ ] 写 `unknown_cost_effect_and_authority_survive`：uncertain reserve/history 金额不变、pending export 拒绝；confirmed 操作不重放，unknown/dispatched/prepared 等原证据保持原值，不能因 restore 改 failed-known。恢复后 coordinator/ProviderReconciliation/automation/startKnowledgeIndex 不得自动释放过期未知预留、重发 outbox 外部效果或启动模型。审计投影只在确认后按 idempotent 既有流程继续。
- [ ] 写 `activation_requires_fresh_current_admin`：必须目标 OIDC 新登录、同 issuer/subject 映射的 active admin、当前 epoch/权限重验；已 disabled、issuer 不同、旧 cookie、local-owner、过期 digest 均拒绝。activation 追加新审计，不修改历史 audit/approval/operation；源 bootstrap 不重开。原审批只能作历史，新效果仍经当前权限/预算/合同版本/设备授权检查。
- [ ] 运行 `node scripts/test-integration.mjs tests/enterprise-backup-admission.test.ts` 先红。实现 marker 的启动/执行门禁，逐个盘点所有实际效果入口；导入后自动化保持暂停、native/MCP 保持不可执行，以本机 overlay 门禁和设备 disabled 实现，历史包摘要仍能核对。激活仅解除环境总门禁，设备/主机目录授权、连接/插件需重新授权；不自动启用 task profile。目标 session signing secret/OIDC config 使用目标运维配置。
- [ ] 同命令绿；复用 `tests/run-current-authority.test.ts`、`tests/identity-session.test.ts`、`tests/cost-carryover.test.ts`、`tests/cost.test.ts` 及现有 tool-effect 回归，确认撤权/未知保护未减弱。提交 `feat: quarantine restored authority and execution`。

### Task 5: 独立进程崩溃及原生 PostgreSQL 证明

**Files:** 新 `tests/enterprise-backup-native.test.ts`；扩展 `tests/fixtures/backup-restore-crash.mjs`、`tests/backup-restore-state.test.ts` 或新专用 owned fixture；沿用 `tests/backup-restore-native.test.ts` 的 URL/目录所有权约束。

**Interfaces:** fixture 增加 `kind:'enterprise-v2'`，阶段 `prepared|old-moved|installed|committed`；输出 `{phase,operationId,inputDigest}` 和 restart `{status:'committed'|'rolled-back'}`。不新增产品故障注入 HTTP。

- [ ] 先写/运行红测试：四阶段 kill+restart，SQL import/marker/audit/device存根与 trace/key/vault/bundle 只能一起 old 或一起 new；源 A 始终同 digest。模拟 committed 未收到 ACK，重复同包不能再次插入/重复审计，应返回既有 operation 状态或 409 非空目标。
- [ ] 增加独立后端屏障：原事务未决时，第二进程确实在 advisory gate 等待（`pg_stat_activity.wait_event_type='Lock'`），不能把 receipt 暂无判成 rollback；原事务分别 COMMIT/ROLLBACK，后续准确核对。marker/receipt 损坏、generation 错误、after 文件篡改均保持屏障且保留两侧。
- [ ] 运行 `node scripts/test-integration.mjs tests/backup-restore-state.test.ts tests/enterprise-backup-restore.test.ts`；有已拥有的 loopback 原生 fixture 时运行 `node --import tsx --test tests/backup-restore-native.test.ts tests/enterprise-backup-native.test.ts`。无 `BACKUP_RESTORE_POSTGRES_URL` 时 native 会 skip，必须报告“未验证”，不能安装新服务或把 skip 算通过。
- [ ] 核对 TAP fail=0、各必测阶段实际 executed、原生屏障有真实 wait 断言；证据记录数据库类型/OS、源码 hash、命令/退出码，不收集凭据。提交 `test: prove enterprise restore crash consistency`。

### Task 6: 网页和 API 收口

**Files:** 改 `backup.ts`、`app.ts`、`api-route-policies.ts`、`SettingsCenter.tsx`；新 `enterprise-backup-state.ts`、`tests/enterprise-backup-ui.test.ts`，扩展 API 路由分类/授权测试。

**Interfaces:** 保留 v1 URL；新增 admin 路由 `POST /api/backup/enterprise/export {password}`、`POST /api/backup/enterprise/inspect {password,backup}`、`POST /api/backup/enterprise/restore {password,backup,confirmation:'RESTORE ENTERPRISE'}`、`GET /api/backup/enterprise/status`、`POST /api/backup/enterprise/activate {operationId,inputDigest}`。inspect 仅返回 `{format,schemaId,createdAt,tableCounts,fileCount,totalBytes,unresolvedCosts,unresolvedOperations,requiresFreshDestination:true}`；不缓存密码/解密包到持久存储。status 返回 marker+安全核对状态。inspect 无文件写入；restore 自己重新验证，不信客户端 inspect。

- [ ] 测试 HTTP：成员/审计员/设备无法 export/inspect/restore/activate；admin 撤权竞争失败；无 CSRF/错误 Origin 失败；70 MiB 路由 parser 同时覆盖 inspect/restore，其他请求仍原上限；错误状态不泄漏 credential/cookie/SQL。
- [ ] 测试纯 UI 状态和 SSR：默认完整 v2、旧 v1 清晰标业务格式；正确密码可预览计数、空目标约束、未知费用/效果提示；超限/坏 JSON/错误密码/409/unknown/restart 状态可理解且不显示“恢复成功”；确认字串精确，busy 防重复；激活要求重新登录，不提供跳过安全门禁按钮。
- [ ] `node --import tsx --test tests/enterprise-backup-ui.test.ts` 与相应 HTTP integration 先红。实现网页/API，沿用现有 api/session/CSRF/idempotency。`idempotency.ts` 已排除 `/backup/`；新增断言证明 v2 仍不进入 request_keys response cache，保留 operationId 去重。
- [ ] 首版恢复路径：源企业管理员网页导出 → **全新隔离实例使用既有 legacy-local loopback 管理页导入** → 留在全局 quarantine → 运维配置目标同 issuer OIDC 并重新启动 → 原 active admin 重新登录 → 网页核对并激活。禁止退化公开匿名恢复接口；正常已初始化 OIDC 目标仍拒绝导入。legacy-local 页面不解除 quarantine。`identity-store.ts` 现有 activated bootstrap 禁止 legacy-local downgrade，且比较 `expected_fingerprint`：启动配置须匹配源 bootstrap issuer/subject（不只是 issuer），不清 fingerprint；导入后若仍以 legacy-local 重启，应安全拒绝身份初始化并提示配置要求。加此重启测试；不得为让恢复页显示而去掉 downgrade 保护。上述过程无手工 SQL，UI 写清重登录/配置需求。
- [ ] 跑 `npm run build`、全部新 suite、上述 v1/identity/cost/route 分类定向回归；仅在新变化/失败时扩展测试。最后做一次隔离浏览器主流程抽查（导出、预览、导入、隔离提示），无需重复接口矩阵。不具备真实 IdP 时只计 fixture 登录证据。
- [ ] 写 validation 报告：每项“已验证/未验证/受阻”；附受控 schema/FK fingerprint、A/B 前后 digest、两种引擎行往返差异、原生 crash 结果、浏览器与模型次数。提交 `feat: expose enterprise backup recovery in settings`。

## 完成条件、风险和不能由代码猜测的问题

完成必须同时有完整表/文件覆盖、fresh-only preserving import、旧身份/设备失效、未知费用/效果不被清除、receipt 崩溃证明和网页可操作证据。只完成停机目录复制、只导出 JSON、v1 放宽保护、只有 PGlite 顺序成功均不能标 F1 完成。原生 PG/真实 IdP 未验证时明确限制发布资格，不冒充已验证。

已决定的常规实现选择：50 MiB 在线上限、不做现存企业库合并、保留 historical epochs、target-local quarantine、无新备份引擎/依赖、同 issuer 重新登录验收、禁用设备/外部连接/自动化。无需再逐项请求用户确认。

代码不能解决的外部条件：目标 IdP 是否可用及原管理员是否仍可登录；跨 issuer/全部管理员失联时由谁拥有恢复授权；目标主机目录/设备是否有有效重新授权；是否已有允许使用的原生 PostgreSQL 测试实例。跨 issuer 和管理员失联恢复不纳入首版，不能临时把任意账号升级成管理员。大于 50 MiB 的企业在线包另需有界流式格式/网页上传方案；本次明确提供停机副本兜底且不冒充在线覆盖。

计划自审：全部研究 F1 项分别落 Task 1–6；自引用/触发器冲突、目标默认行、未决费用、权限和启动后台服务、秘密排除、跨引擎无损 codec、重复导入均已有所属断言。没有产品代码更改，没有安装/付费/JJ 操作。实施者在开始时核对实际文件名和 P0 后基线，只允许对上列文件边界做必要接线，不顺带开放企业 task 或替换架构。
