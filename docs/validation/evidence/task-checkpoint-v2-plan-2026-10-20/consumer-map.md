# Task 5 消费者、维护与备份接口地图

2026-10-20；只读调研；基线 `8cda280`（Task 4）。本文件不是实现完成或 RED/GREEN 证据。未运行数据库、模型、JJ、依赖安装、生产命令或测试；仅阅读代码并保存本地图。并行中的 D2 工作不在本文件内修改。

## 首要结论与门禁

1. **Task 3 已有最小读取原语，不需要新文件系统层。** `apps/api/src/task-canonical.ts:56-72` 的 `readCommittedCanonical(traceRoot, run)` 从 **SQL row 的 `canonical_workspace`** 验证完整 manifest、所有 SHA 对象、revision 和 committed receipt，返回 `{ref,files}`。Task 5 应复用它，不以 `artifacts` 缓存补齐任何新 profile 缺失对象。
2. **真实消费者仍没有接通。** 列表/下载、Office 来源素材、父运行复制、规划、恢复判定和工作记录仍读取 `artifacts`。缓存中断时它们会观察到半套或错误版本；backup 会把这种缓存连同 SQL head 导出，却不校验两者的 canonical 关系。
3. **维护有明确错选对象问题。** API 在 `storage-lifecycle.ts:22` 以 `.find(s=>s.runId===runId)` 选首个对象，并在 `:23-25` 将 task work revision 与整 run cache revision 比较。设备已支持 task key，API 尚未传它。
4. **备份不能直接把 `local_operations` 加进可恢复表列表。** 它依赖 `local_devices` FK，而恢复明确删除设备；历史 started 行不能进入 live poll。必须先确定版本化的只读证据导入边界。
5. **旧恢复路径不可用于带企业身份/审计的目的地。** `backup.ts:61` 的 `TRUNCATE ... CASCADE` 可以清空部门关联的审计和 membership，UPDATE/DELETE 审计触发器挡不住 TRUNCATE。D2 Task 8 已明确要求保留目的地身份/审计的协调导入，或在破坏性 SQL 前拒绝。
6. **profile 继续关闭。** `execution-policy.ts:20-23` 拒绝 task profile 启动/恢复；`product-runtime.mjs:80-87` 仍拒绝 task recovery。Task 5/6 的门禁没有完成前不能删除这些拒绝，不能以本文件或模拟 DB 测试作为 JJ/物理沙箱/真实模型验收。

## 唯一成果读取边界

已有签名保持：

```ts
readCommittedCanonical(traceRoot: string, run: {
  id: string;
  canonical_workspace: unknown; // 由可信 SQL row 提供
}): { ref: CanonicalRef; files: TaskWorkspaceFile[] }
// ref = { revision, manifest: [{path,size,sha256}], mergeId }
// files = [{path,content:base64}]
```

- 调用方先用已有 DB/事务取得 `project_runs` 的 `id,snapshot,canonical_workspace`，按 `snapshot.executionProfile` 分支。`readRun()` 只读 snapshot + journal，不携带最新 SQL head（`services/agent-runtime/trace-store.mjs:60-80`）；不能直接将它当 SQL row。档案身份/完整性检查仍保留。
- 每个消费动作只选一次 SQL head，后续列表、文件选择、内容和 receipt 比较使用这一次 `{ref,files}`。对象不可变，因此较新 head 的并发提交不把当前动作拆成旧新两套。若需要多表一致性，沿用调用方既有只读事务；不要每个文件重新查 head。
- 新 profile 的 manifest/hash/object 失效直接明确受阻；不回退 cache，不跳过坏文件、不返回不完整列表。旧 profile（含无 profile 旧快照）保持原 artifacts 分支；未知 profile 不伪装 legacy。
- `readCommittedCanonical` 已全量验证对象，大小边界为 128 文件、单个 5 MiB、总量 20 MiB（`:58-70`）。`archive-objects.mjs:24-34` 已校验普通文件、nlink、O_NOFOLLOW、size、SHA 和读取期间文件身份；无需另写 blob 引擎。
- 下载按 manifest 精确匹配交付 path，然后使用**已验证 SHA 对象** `checkpoint-objects/<sha256>`，响应文件名仍取交付 path。可复用已有对象函数的小型 verified-path 暴露；不要将交付 path 拼进对象路径，不把泛化路径解析器暴露给客户端。对象导出接口必须保留现有验证，不能只 `join(dir, sha)` 后跳过它。
- 内部 metadata-only 消费者可直接使用 `ref.manifest`；需要正文的消费者从 `files` 解码。`resumeHandoff(...,root,files?)` 已有第 5 个清单参数（`handoff-checkpoints.ts:9-10`），`buildCheckpointContext(...,selectedFiles)` 已有清单入口（`checkpoint-context.mjs:73-79`）。可复用这两个窄入口，不建立 FileView/虚拟 FS。
- `materializeCommittedCanonical` 只在已有 project/run 写 fence 下运行（`task-canonical.ts:195-200`）。启动/Handoff 的可信镜像可以保留；HTTP/规划/备份不能为读取而依赖 mirror 成功，也不能借读取无锁修复缓存。

## 实际消费者地图与归属

| 优先级 / 消费者 | 现有代码位置与真实行为 | Task 5 最小接线 / 负责组件 |
| --- | --- | --- |
| P0 文件列表 | `apps/api/src/run-management.ts:29`：仅以 `readRun` 判断存在，再 `listArtifacts(.../artifacts)`。前端 `RunExtras.tsx:113,207`、`WorkFilesCenter.tsx:33` 都直接消费此接口。 | API run-management 从 SQL row 选 profile；task 分支返回一次 committed manifest，保持原数组响应形状与 legacy 行为。禁止 cache 部分读。 |
| P0 下载、文本预览 | `run-management.ts:30`：`artifactFile(cache,path)` + `sendFile`。当前 catch 把所有问题变成文件 404。 | 同一读取边界选 manifest entry，下载已验 SHA 对象；保留 CSP、nosniff、attachment 交付文件名。canonical 不完整应明确 409/受阻，不能被泛 catch 隐藏为无文件。 |
| P0 Office 来源素材 | 没有独立 Office canonical HTTP 读取器。真实路径是 `work-files.ts:144-161` 的 `/work-files/from-run` 读 cache 字节，进入 `store` → `prepareWorkFileSnapshot` → `readOfficeFile`（`:31-40`）。`verifiedText` 再对素材 base64/SHA/Office 正文核验（`:49-51`）。 | work-files 负责从 committed `files` 精确选择字节，并以同一 manifest 核验 Handoff；既有 `readOfficeFile`、素材限额、提取正文与格式规则全复用。新 canonical 读取不另造 Office parser。 |
| P0 从已完成 run 生成素材 | `work-files.ts:146-159` 查询只有 status/snapshot；要求 archive completed/integrity，再 `resumeHandoff(cache)` 与 cache 文件 SHA 对 accepted seals。 | SQL 查询补 canonical head；task 分支将 committed manifest 传现有 Handoff 清单入口，文件内容来自该 head。必须继续核验 completed/accepted、来源身份和 selected paths，不能因 head 存在绕过验收。 |
| P0 父 run 导入 | `work-files.ts:90-107` 的 `prepareImportedWorkspace` 同步递归复制父 `artifacts`；`run-coordinator.ts:142-143` 从 launch 调用它/restoreStepWorkspace。 | coordinator 在现有可信 DB 边界取得父当前 committed head，task 恢复按 checkpoint 团队约定传入已验数据。将完整当前 canonical 作为新 run 初始基线，只有所选 A 工作副本下发给新 A；不能把 A checkpoint.files 当整 run。legacy 原函数路径保留。 |
| P0 recovery inspect | `recovery-conditions.ts:72` 已 SELECT *，但 `:122` 仍将 cache 或 selected checkpoint.files 传给 `resumeHandoff`；`:88-90` 读原 archive。 | recovery 组件复用 row head；当前 canonical 检查与选中 A work 检查分开。SQL 未决 operation/merge 优先，不能由旧 runtime finished 抹除。checkpoint v2 selector 的具体合同由 checkpoint 子任务负责。 |
| P0 recovery mutate | `run-management.ts:64,79-95` 有 source SQL row 和 archive，但 `:92-94` 使用 cache，且 selected.events 截至 checkpoint.seq。 | run-management 只消费 checkpoint 子任务的新分支输出；当前 head 保留 B，A 工作副本引用固定来源，账本/审批/完整原 journal 保留。不能把截断事件当恢复后的全局事实。 |
| P1 recovery UI 提示 | `apps/api/src/app.ts:547` 对 failed/interrupted/cancelled 调 `resumeHandoff(cache)` 生成 checkpointBlocked。 | 与真正 inspect/mutate 共用 committed 清单和 SQL 未决状态。UI 提示不能承诺真实恢复不会允许的内容。 |
| P1 规划上下文 | `planning-execution-context.ts:68` 在调用方只读事务中执行；`:91` latest 查询没选 head；`:117,133,141` 以 cache 核验 Handoff/输入；`:148` 仅用 JSONL unresolved。 | planning 查询补 snapshot/head，以 committed manifest 查实际 seal；保留 `currentPlanMatches`/固定输入/accepted 逻辑。未知 SQL merge 要出现 issue/unknown，不能按空集合规划；不调用模型或改变费用。 |
| P1 工作记录/知识登记 | `work-records.ts:11-22` 的 acceptedWorkEvidence 只查 status/snapshot，再 `resumeHandoff(cache)`；`:37-43` 生成记录，费用/共享判定另保留。 | work-records 查询带 head，acceptedWorkEvidence 用 committed manifest。保持 completed/全部节点/accepted 来源限制，不把只写入 head 当成可登记知识。`files` 索引来自真正 seals。 |
| 已有受控 runtime 镜像 | `product-runtime.mjs:80-96` task 分支先 `sandbox.prepare` 重建再建 supervisor；`handoff.mjs:129-196` 从镜像读取、核验 task receipt/merge。`task-canonical.ts:174-182,195-200` 持 fence 重建 latest head。 | 沿用 Task 4。Task 5 只接 v2 与恢复 refs，不能让 HTTP 读 cache；不得从旧 receipt materialize 老 head 覆盖较新 B。 |
| 备份 | `backup.ts:30` 在 REPEATABLE READ 中导出 project_runs 与 archive 文件；目前没有 canonical 验证。`backup-checkpoints.ts:8-45` 只查 step/checkpoint、原观察和 lineage。 | backup/checkpoint validator 共同验证同一 SQL head、操作/merge 原记录和全部对象引用。archive append 失败时 SQL committed receipt 仍权威；JSONL 不是 head 发布点。 |
| 原生 Office/其他工具 | Task 4 已经由 product/native wrapper → local operation → task merge；见 `tests/task-sandbox-flow.test.ts:27,80-82,146-179`。这是工程 fixture 插件，不能称真实原生 Office 产品验收。 | root 的固定 DSH 原生审计负责此边界，本地图不重做插件研究或实现。Task 5 仅消费原 scope/merge/checkpoint 引用，不直接在可信 host 跑插件。 |

补充：`services/agent-runtime/storage-governance.mjs:67,84,96` 也以 artifacts cache 证明本机副本可清理。若新 profile 的这类副本纳入维护，必须由 API 传已验 head seals；首版也可明确不产生 enterprise workspace-copy 候选，保留现场。不可通过泛化该纯文件模块暗中读取数据库。

## 维护：复用已有协议，按 key 选对象

已有设备能力无需重写：

- `openshell-executor.cjs:251-259,362-366` 已列出 legacy + task rows，task row 含 `{key,runId,sandboxId,phase,workspaceRevision,storage,retirement}`；无法验证的映射返回 unverified 而保留。
- `:396-411` 的 inspect 实际接受 `string | TaskAttemptKey`，核验 task 工作清单与存储；停止对象重启检查重新容量准入。
- `:414-434` 已持久 retirement intent、按原 sandboxId 删除、confirmAbsent 后才 retired，delete 应答未知仅 reconcile 原对象。`:425-427` 回执包含 key（schema 2）。不要建新删除 journal。
- `:261-266` 已将所有非 retired 对象计入 128 scope/磁盘，stopped 保留磁盘占用，unknown/unverified 占运行 slot；最多两个运行资源 slot。不能因 HTTP 列表/恢复丢失一行而释放容量。

API 必须改的窄边界：

| 位置 | 当前缺口 | 所需归属 |
| --- | --- | --- |
| `storage-lifecycle.ts:4` | maintenance 类型只允许 runId:string。 | 类型改为已有 `string | TaskAttemptKey`，不要改变 legacy 调用语义。 |
| `:8-11` | completed SQL 只检查 operation.status/started/result 和 pending costs，JSONL 只查旧 unresolved；漏 merge pending/unknown。 | 共同未决查询覆盖该 run/需要保护的 ancestry 的 operation + merge；确定 rejected/committed/reconciled 才关闭局部未决；未知保留。 |
| `:20-29` | `.find(runId)` + task revision == full cache revision。 | task 请求完整 key + expected sandboxId/workRevision；按四元 key 精确选一行，再核 SQL/设备身份、accepted task、持久 v2 export/checkpoint、merge receipt、完成及费用状态。work revision 按 task 工作清单验证，不等于 canonical head。preview/result 持久保存 key。 |
| `:31-39` | apply/reconcile 只传 runId，返回只核 run/sandbox。 | 将原 preview.key 传设备，回执还须 key 一致；未知 delete 只能查询原 sandboxId，不创建/替换/重发删除。 |
| `storage-governance.ts:24,29,35,38` | blocked/idle/retention 漏 merge 状态；retention `:42` 仅按 runId some；可误报多个 task 对象可回收。 | 同一 SQL 未决边界和 scope 选择；建议按 key 显示，不承诺任意 row eligible。 |
| `:45-48,62-65` | inspect 只接 runId + 空 body；preview 只接 kind/runId。 | legacy 旧 schema 原样；task schema 要完整 key 和 expected 身份版本，拒绝不完整/混合 profile。 |
| `:75-107` | 已有 started/partial 清理状态与 reconciliation，不应另造。 | 保留现有两段锁/持久 started/确认流程，只传播 key/refs 并扩验证；重复 confirm 不重复删除。 |
| `apps/web/src/StorageCenter.tsx:3,24,28,51-52` | candidate 类型只含 runId/path/bytes，scope 列表 React key 为 runId；inspect/preview 回调只传 runId。两个 task 同 run 会有重复 key，且用户无法准确选择。 | UI 从选中 scope 传完整 key/expected sandboxId/workRevision，行标识和清理历史包含 key；不能默认选 run 下第一个对象。保留 legacy 按 runId 回调。 |

## 备份清单、对象与身份边界

现状：

- 在线 envelope 为 `agent-department-backup-v1` + payload.version=1（`backup.ts:26-27,30,43`），限制 50 MiB（`:23-25`），对象与 cache 都来自 traceRoot 全文件 walk（`:30`）；`checkpoint-objects` 已在目录中，因此复制了对象不代表完整性已认证。
- 表清单在 `backup.ts:21`，扩展列表来自 manager chat/browser MCP/work-files/automation/storage/native。`project_runs` 已包括 `canonical_workspace` 列；**没有 `task_attempt_workspaces`、`local_operations`、`local_devices`、human identity/audit/outbox**。新增 scope schema 在 `product-schema.ts:83-91`；operation merge 列在 `:71-81`。
- backup-checkpoints 现有 `:18-21,24-45` 认证 archive/checkpoint 原观察和恢复 lineage；对没有 step/checkpoint 事件的 SQL canonical head 没有验证，须增加 task 分支。
- native bundle 复用 `exportNativeBundles/restoreNativeBundles`（`native-capabilities.ts:68-86`），它们保留固定 manifest/bundle/metadata 并验 hash/限额；backup restore 将 `native_capabilities.enabled=false`（`backup.ts:46`）。不要在恢复中自动重新启用插件。
- 当前完整在线备份包含加密业务凭据与主密钥（`backup.ts:30,54,58,69`）；**不能声称现有在线备份“所有凭据均排除”**。设备授权明确不便携，restore 删除 `local_devices`/`request_keys`（`:62-64`）。新 task evidence 不得携带/激活设备 token、OpenShell 管理配置/证书/密钥或原生外部账号凭据；DSH bundle 不是运行凭据。

最小增量必须明确：

1. 在同一个既有加密 envelope 内版本化 task evidence，包含 task scopes、canonical heads、operation 原 payload/result/late_result、merge_state/merge_record/merge_rejection、checkpoint v2 refs 及引用对象；需要严格 DTO/版本/来源/摘要验证。缺 required refs 的 **新** backup 拒绝认证，旧 v1 读取继续。
2. 原 operation 状态和原身份引用作为审计事实保留。不要用 `status=cancelled` 重写历史以“避免重放”，也不要把原 started/queued 行恢复到 live poll。`local_operations.device_id` 强制 FK 到 `local_devices`（`product-schema.ts:72`），因此**不能仅在 tables 数组追加 operations，再沿旧 INSERT 恢复**。
3. 最小安全导入边界是现有备份/档案体系的只读 source evidence：历史行仅可核对、不参与 enqueue/poll/claim，不恢复有效设备 credential，不激活 active task scope。具体 SQL/档案承载与查询接口须由 root 在实现前固定；若选择 live 表承载，必须有持久非执行标记且所有 enqueue/poll/claim/恢复读取验证它，不能仅靠设备离线或 deadline 过期。不要建立第二套操作运行引擎。
4. Canonical validator 对备份的 SQL row 调同一 `readCommittedCanonical(stage,row)`，再核对应 task scope/operation/merge refs。latest head 可领先 JSONL `task/merge-committed`，但原 SQL receipt、操作/对象不能缺失；export/import 都不能用旧镜像“修复”为新 head。
5. 所有对象仍计现有 archive 限额/保留策略（`archive-objects.mjs:38-64`、`storage-governance.ts:52-58`）；孤立/unknown 对象保留，不做新 GC。备份损坏不能破坏原档案或目的地数据。

D2 Task 8 交接是独立阻断项：

- `docs/superpowers/plans/2026-10-20-enterprise-observability.md:208-213` 指定 `restoreAuditEvidence` 原 ID/同内容去重/不同内容拒绝、身份引用不可重分配、目的地 audit 保留；重建 derived projection 不回放业务或 OTLP。
- 当前 `identity-schema.ts:16-20,56-75` 中 membership/audit FK 指向 departments/human_users，append-only trigger 仅 BEFORE UPDATE OR DELETE。`backup.ts:61` TRUNCATE departments CASCADE 可清掉这些关联数据；不能靠该 trigger 证明安全。
- B2 Task 5 可先为 enterprise restore 在进入旧 TRUNCATE 前实现明确拒绝并提供证据，直到 A2/D2/F1 的目的地保留导入程序就绪；不得临时 disable trigger、清空审计或编造 human actor。legacy backup 格式可读不等于允许删除企业目的地历史。

已有验证脚本的证明范围不要混淆：`scripts/verify-mvp-backup-real.mjs:11-29,138-172` 是业务 API 投影，明确排除 source DB/credential；其 project_runs 投影没带 canonical_workspace，因此不适合作为新 profile 完整备份。`scripts/verify-mvp-full-offline-backup.mjs:131-158` 读取独立离线恢复 DB、全表计数/脱敏摘要，保护 credential 不读；保留其协议，再补 canonical/task evidence 引用验证，不能将原报告自动升级为 Task 5 验收。

## 待实现的实际 RED 集成场景

以下是失败测试验收设计，**本次没有创建或运行测试，不声称已 RED**。通过 `scripts/test-integration.mjs` 的隔离 PGlite/API 环境运行，不用 ambient DATABASE_URL；真实 PG 事务/设备隔离证据属于 Task 6。

| 测试文件 / 场景 | 实际入口与断言 | 当前失败原因 |
| --- | --- | --- |
| `tests/task-canonical-readers.test.ts`：committed head 后缓存半成品 | 用真实 LocalOperationService + `/poll → /start → /result` + commitTaskResult 产生 A/B 成果（复用 Task 4 fixture，不 mock readCommittedCanonical）。SQL committed 后在 cache-mirror 故障注入中删除一个 cache 文件并写坏另一个；分别调用 `/runs/:id/artifacts`、下载、`/work-files/from-run`（含真正 DOCX/XLSX fixture）、planning context、acceptedWorkEvidence、recovery conditions、backup export。每个动作只能得到同一完整 head 的 SHA/字节，或明确受阻；无一读取半套。 | 路由/素材/规划等仍直接读 cache，backup 没有 canonical 认证。 |
| 同文件：缺失/坏对象 | 留下看似完整 cache，删除/改坏 head 引用对象；列表、下载、素材、规划/恢复不得使用 cache 成功。检查返回 canonical 受阻、原文件/SQL head 无改写、无新 operation。 | 多数实际消费者根本未读对象。 |
| `tests/task-checkpoint-recovery.test.ts`：A checkpoint 后 B commit | 完成真实 A 首次写入 → v2 A checkpoint（记 cpA/refA/workA）→ B 的另一 scope commit b.txt 得 canonical C2 → 停止原 run → recovery inspect/retry 选择 cpA → 新 run、新 A attempt/generation/sandboxId。新 run canonical 初值是 C2（B SHA 不变），仅新 A 导入 cpA 的授权工作副本；A 再 merge 仍保留 B。原 run、cpA、全部 B/费用/审批/unknown 记录不改。 | selector `step-checkpoint-recovery.ts:33-44` 以另一 task 事件拒绝或截断事件；restore 仅复制 checkpoint.files；父导入走 cache。具体 v2 fixture/selector 由 checkpoint 子任务负责。 |
| 同文件：SQL merge unknown 与执行 unknown 不互相清除 | 在 terminal command receipt 已存在但 merge pending/unknown、以及 command 自身 unknown 两种情况下，以完整/截断 JSONL 调 inspect/retry；两者都无新 execute；完整旧文件不能让 unknown 消失；原 operationId 必须核对。 | `unresolvedOperations` 只从旧 runtime start/finished reducer 推导（`recovery.mjs:29-38`），无 SQL merge 索引。 |
| `tests/task-storage-lifecycle.test.ts`：同 run 两个 key | 同 run 的 A/B scope 有不同 sandboxId、work revision，canonical 含 A+B。真实 HTTP inspect/preview/confirm 只选择 keyA；adapter 记录参数必须是 keyA；删除 A 后 B key/id/work/storage 原样。A task revision 不等 canonical 仍可在证据齐全时维护。缺 generation、sandboxId/revision 过期、跨 run key、未 accepted/无 v2 export/缺 receipt 均零 delete。 | API 类型/body 仅 runId；find(runId)；比较全 cache revision。 |
| 同文件：delete 应答丢失、容量 | 沿现有 storage_cleanups started/partial/reconcile 走真实 API，设备 transport 模拟 delete 已受理但应答丢失；后续只 get **原 sandboxId**，delete 计数仍 1。只有 absent 才 retired。stopped/unknown/unverified 都保留 scope/磁盘容量，unknown 不变 retired/不释放 slot。 | 设备原语已有，但 HTTP key 传播与 task eligibility 未接；断言必须覆盖该整段而非仅 executor 单测。 |
| `tests/backup-checkpoints.test.ts`：实际在线 export/restore | 已停止 fixture run 含 canonical C2、A cp、B merge、原 SQL committed 但 archive append 故障；调用真实加密 export/restore 到独立目的地；比 source/destination canonical refs/对象 SHA、task key/merge 原记录、未知标记。历史 started 不可被 poll；无模型/工具重执行，设备/插件不自动启用。删一个 canonical/object/merge/scope ref 后认证失败且目的地 DB/文件不变。 | 现有表清单漏 scope/op，validator 只认证 step checkpoint。 |
| 同文件 + D2 restore suites：目的地身份/审计保留 | 目的地先有与 source 不同的 human/department/membership/audit/outbox；含 published/pending outbox 的备份恢复必须走协调 preserving 流程，或在 TRUNCATE/文件 swap 前受阻；验证全部目的地 ID/count/hash 不变。duplicate ID 不同内容、缺 human/department refs 均失败；会话/OIDC/设备管理秘密排除。 | 旧 TRUNCATE CASCADE 可清 audit/membership，且备份没有 identity/audit 表。此用例不能仅用空目的地证明。 |
| legacy 回归 | `tests/checkpoint-branch.test.ts`、`tests/backup-checkpoints.test.ts`、`tests/work-files-from-run.test.ts`、`tests/planning-execution-context.test.ts`、`tests/work-records.test.ts`、`tests/storage-governance.test.ts` 原分支保留。 | 不能以将所有 legacy reader 全改成 task head 让新测试通过。 |

已有可复用证据：`tests/task-canonical.test.ts:189-200` 已覆盖 intent/blob/SQL/archive/cache 故障且 reconciliation 不新增 operation；`:202-207` 覆盖坏对象与 profile 关闭；但它没有调用上述业务消费者。`tests/task-sandbox-flow.test.ts:146-179` 已覆盖真实 API claim/start/result、CAS 和 employee adapters，适合作为新 RED 集成的 fixture 基础，模拟 transport 仍不能证明真实 OpenShell 隔离。

## 实施分工与顺序建议

1. Root 固定已有 readCommittedCanonical 的窄边界、SQL row/profile 选择、task 备份只读导入承载；继续保留 startup gate。checkpoint 子任务负责 v2/selector/恢复上下文，双方用完整当前 head + 所选 task work 两个不同引用交接。
2. API 消费者在同一小批改动中接一次 head：run-management 列表下载 → work-files/Office/父导入 → planning/work-records/app/recovery。避免某入口仍读半套 cache。
3. storage 负责人只扩已有 key 类型/HTTP schema/preview receipt/SQL eligibility，继续复用 Task 2 executor 的容量/retirement/confirmAbsent。
4. backup 负责人扩既有版本/validator/objects/evidence；与 D2/A2/F1 串行交接 `backup.ts`，先落明确的 destination-preserving 门禁。不得同时编辑 shared file 或对审计 schema 做 B2 私有改造。
5. 按计划运行新增 RED → 实现 → 同组 GREEN/旧回归/build，再独立评审。记录 PGlite/真实 PostgreSQL/JJ/业务四种证据；Task 5 本地通过仍不等于 profile 可发布。

## 冻结计划前补充：第三个 task 的运行 slot 裁决

**结论：已有设备 stop 原语，但没有产品接线；需要第三个工作区的 dev → QA → manager 链当前会被容量挡住。** 若第三个节点仅作无工作区的协调/总结，不会自动产生第三个 sandbox；阻断准确触发条件是前两个 task scope 都仍为 ready，第三个 task 首次 prepare。

- 计数不是 active exec 数：`openshell-executor.cjs:261-266` 分别限制 128 个非 retired scopes、两个非 stopped/retired 的运行 slot、所有非 retired 的 workspace/tmp 磁盘。`:295` 在新 task prepare 调 `admitTaskCapacity(true)`，两个 ready 已满即在 CLI create 前 `SANDBOX_STORAGE_LIMIT`。共享串行 queue（`:268,368`）不会把已完成 scope 自动变 stopped。
- 一般操作结束一律保存 `phase='ready'`（`:351`）。terminal/native 的 stop/start fencing（`:330-345`）在导出前重新 start，最终也回 ready；它是生命周期封口，不释放长期运行 slot。
- **可复用方法为 `stopAcceptedTask(key,expected)`（`:387-394`）。** 它要求 ready、无 activeOperation、expected.accepted/checkpointResolved/operationsResolved 全 true、准确 task work revision；串行 maintenance 内 admit 后持久 `stopping`，调固定 OpenShell `sandbox stop`，`waitForPhase(...,'Stopped')` 后才保存 stopped/accepted。get/wait 校验 name/id（`:229-235`）；这保留原 sandbox/files/scope/storage，不 delete、不 retired。因此只释放运行 slot，scope 数和磁盘仍占用。stop 不确定保存 unknown，仍计 slot，不能当 stopped。
- **生产代码没有调用该方法。** 搜索 apps/services/scripts（排除测试）仅有上述声明；调用只见设备测试 `openshell-executor.test.cjs:424,426,545`。该测试在两个 scope 后先断言第三次创建失败，再手动 stop A 后才允许第三个 scope（`:420-428`）；它不能证明真实员工链会自行释放 slot。
- 实际 accepted 路径为 `host.mjs:333-352`：准备/核验 task → native completed → `handoff.commit(record)` → team/checkpoint；`handoff.mjs:203-207` 只记 accepted 和 node-accepted checkpoint，无异步 stop。`LocalRunExecutor.execute/close`（`local-execution.ts:275-298`）只处理工具合并/取消未完成操作，没有 stop hook。桌面 `close` 明确只停 schema 1（`openshell-executor.cjs:436-442`），task schema 2 不被清退；不能改变这一点来掩盖未决现场。
- 现有公开 storage 维护也不能替代这段接线：`SandboxMaintenance` 类型无 stop（`storage-lifecycle.ts:4`）；boundSandbox 要**整 run completed**（`:8-17`）；inspect/confirm 的 idle 要无 queued/running run（`storage-governance.ts:27-29,48,85,92`）；retireStorage 最终删除原对象（`openshell-executor.cjs:414-434`）。它既不能在进行中 run 的 task 边界释放 slot，也不应为了释放 slot 删除交付现场。`scripts/local-api.ts:46` 虽把实际 executor 提供给维护 provider，API 没有对应 verified task stop 入口。
- `LocalDeviceClient` 仅从 poll job 进入 `executor.execute`（`local-client.cjs:50-79`），设备执行工具 allowlist 仍只有 prepare/filesystem/artifact_write/terminal/terminal_test/native_plugin（`openshell-executor.cjs:271`）。不能声称给 LocalRunExecutor 加一个未传输的同名方法就已接通，或允许模型直接传上述三个 true。

**Task 5/6 最小新增验收项：** 沿已有 accepted/检查点 flush/maintenance 持久回执与串行 queue，接一个可信、按 key 的 stop lifecycle 边界。只有 accepted 已持久、v2 work export/checkpoint refs 完整、该 scope operation/merge 已决、sandboxId/workRevision 未变且当前授权允许时，才调用现有 `stopAcceptedTask`；在后继第三次 prepare 前确认原对象 Stopped。不要另建调度器或提高两个 slot 上限。未知 stop 保留原 key/id/slot，仅查原对象，不重跑 command、不建替代 generation；响应丢失的已停确认需要沿已有 native get/wait + 持久 phase/receipt 补齐幂等核对，不能借 retirement 的 absent 回执证明 stopped。

RED 必须是实际产品链三 distinct task keys（dev/QA/manager 各有真实工作区调用）而非手工调用 stop helper：A accepted + durable checkpoint 后 stop A，B accepted 后 stop B，C prepare/create 成功，三个 sandboxId 均不同；A/B 原 files/work revisions/mappings、128-scope 与磁盘占用不变；任一 accepted/checkpoint/merge 缺证、stop 失败/响应未知则 C 不越过容量门禁且 exec/create/stop 不被重复发送。Task 6 以真实 OpenShell 重复此场景，保留 operation/key/id/phase 证据；当前仅能判定“设备原语存在，产品释放路径未完成”。
