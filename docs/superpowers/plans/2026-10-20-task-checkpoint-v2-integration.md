# B2 Task 5 接续裁定：私有检查点引用与完整成果消费

本文件细化已批准的 task-sandbox-integration 计划 Task 5，基线提交 68085f5。Task 4 本地工程接线已通过，不改变 Task 6 前保持 profile 关闭的条件。两份实际源码地图在本计划 evidence 目录中保存；地图只读，没有把设计当测试结果。

## 复用边界

继续复用 DSH 员工宿主 checkpoint policy/flush、现有 SHA 对象存储、Handoff mutex、SQL canonical head/CAS、既有备份 envelope 和 OpenShell 维护 journal。没有增加第二套执行器、插件引擎、对象文件系统或任务队列。

当前真正的 CanonicalRef 是 `{revision,manifest,mergeId}`，TaskMergeReceipt 位于 task-canonical.ts；不假设存在 runId/objectRoot 字段。源档案所有权必须随 checkpoint.runId 或 recoverySource.sourceRunId 传递；裸 ref 不能确定对象目录。

## 实现前固定的接口

TaskCheckpointRefs（纯可信进程内数据，非 HTTP/模型 DTO）包含：

- `profile/key`：完整 run/task/attempt/generation。
- `inputManifest` 及新增必需 `inputOrigins`：保留固定来源的 source.kind、snapshotId、agentIds/accepted 或 checkpoint 身份；不能仅留下无法重建来源的 hash。rolling own output 的来源仍由 manifest/已提交回执证明。
- `workManifest`、`canonical:CanonicalRef`、`lastMerge:TaskMergeReceipt|null`、`scopeHash`、`capabilityHash`，以及可选 `recoverySource` 原始来源引用。

`LocalRunExecutor.prepareCheckpoint(context,signal,{phase:'before-tool'|'after-tool'|'boundary',operationId?})` 在现有权限/lease/任务/operation 锁边界验证 SQL 和对象，返回上述私有引用。after-tool 必须指定原 operationId；不能用任意“最新成功”替代。work revision 是 sandbox 部分文件的 digest，不能误用代表完整 canonical 的 scope.workRevision。

`HandoffGate.bindCheckpoint(taskId,attemptId,refs)` 接收已验证引用；同步 checkpoint 方法只核对并提交本地已持久 refs。wrapper 在 before-tool、结果 observe、node-accepted、cycle/DSH flush 前 await 引用准备；失败则不派发下一步。不可在同步方法中假装完成异步设备导出。已经持久验真的原 operation 导出可复用，不重做员工命令。

v2 的 `files` 必须等于 task workManifest，而不是完整 canonical.manifest。完整 canonical ref、inputOrigins 等只进入可信 API/Handoff/检查点档案，不能挂到员工工具结果、arguments 或保护上下文中。canonical 可指 B 的最新提交，而 lastMerge 是 A 的最后提交，两者分别验证，不要求 mergeId 相等。

保持 v1 格式/摘要和旧恢复读取。v2 环境/合同摘要纳入完整源身份、输入来源、权限/能力及固定 backend/policy。源 key 与新目标 key 分别验证；不能直接把含旧 key 的 hash 与新 key 比较后忽略差异。旧终端批准不得重放，v1 passing test 不能升级为新 profile 证明。已完成源节点保留原接受证据及来源，不重新执行；未完成节点的命令证据只有经过 v2 来源/文件/环境/当前权限核对后才可显式继承，必须标明 inheritedFrom，不改写为新执行。

## 新恢复 run 的初始化

旧代码将 checkpoint.files 直接恢复成整个 artifacts，会丢掉 A 检查点之后 B 的成果。复用已有 initializeTaskCanonical 的 NULL-only 发布协议解决：

1. 批准时固定源 run、源**最新完整 committed head**、所选 A checkpoint id/SHA 和当前授权合同。实际初始化时再次验证；源变化、对象坏/缺、未知操作/merge 或输入/权限/能力/backend/profile 不兼容均拒绝。
2. 新 child 尚无 canonical head 时，锁定并核对批准的源 head，以该完整集合构造可信当前基线。用现有纯 planTaskMerge 把 A 所选 work 当候选 export；只允许 A 已批准输出 delta，固定只读输入必须相同，B 文件保留。
3. 对象先验证并复制进 child 自有 checkpoint-objects，再 CAS child head `NULL → 完整候选`。初始 head 使用现有 `{mergeId:null,receipt:null}`，另存受校验的 recovery-initialization provenance。不能复制 parent receipt 冒充 child receipt，也不能伪造成功设备操作来初始化。
4. SQL 丢应答/归档失败后只查原 child head 和持久初始化来源，补证，不重做命令或重置已经前进的 child head。原 source 数据、事件、批准、费用均不修改。
5. 后续 scope 按 child head 构造，恢复的 own outputs 具有显式 checkpoint 来源。resolveTaskScope/admitTaskOperation 原来整段拒绝 recovery 的条件，只能替换为严格的已验证恢复来源 gate，不能直接去掉保护。

保留源的完整事件给 B/费用/unknown/rework/接受记录，仅截 A 所选 task 的历史上下文和 session cursor。resumeHandoff 消费完整候选 manifest，不能把 A work 当全项目。未知的 SQL 执行/合并由原 operation 核对；acknowledgeUnknownOperations 不能作为 task-profile 的已决证明。

## 成果消费者与维护

同一请求先读取实际 SQL project_runs（档案 snapshot/JSONL 不含 canonical head），再复用 readCommittedCanonical。列表、下载、Office from-run、父素材导入、规划、work records、恢复提示/检查和备份均只能读同一 committed 集合或明确受阻。下载使用已验 SHA 对象，不能读正在重建的兼容缓存。legacy profile 保持原路径。

维护 HTTP/类型/网页传播完整 task key + expected sandboxId/workRevision，不能 `.find(runId)` 或用 runId 作为同 run 多 scope 的 React key。沿用既有 delete journal/确认原 sandboxId absent/unknown reconcile；task work revision 不等于完整 canonical。活动、未决、缺检查点/merge 证据或费用未决的对象不删，unknown/stopped 磁盘占用保留。

已核实存在第三节点的真实容量缺口：设备只允许两个 running slot，stopAcceptedTask(key,expected) 原语已能停止已验收对象并保留文件/映射，但产品没有调用链。Task 5 必须把可信 accepted + v2 checkpoint + 原操作全部已决的证明接到该原语，在第三任务需要容量前停止完成对象；不删除工作区、不增 slot。停止前持久绑定原 key/sandboxId/workRevision，确认原对象 Stopped 后才释放 running slot。停止应答未知/进程中断只 get 核对原 sandboxId，不重发停止或借 retired/absent 冒充 Stopped，unknown 保留占用。需持久 stop-intent/核对来源时扩既有 task journal，而非另建维护引擎。三 distinct task 的真实产品工程链及 Task 6 物理链都必须验证此项。

## 备份的执行隔离与审计边界

在原加密 envelope 内增量版本化 task scopes、原 operation/payload/result/late_result、merge 状态/结论、heads、v2 refs 和对象，完整校验引用。旧格式可读；新备份缺关键引用则拒绝认证。

历史操作恢复为现有备份档案中的只读 source evidence，不插回 live local_operations（其设备 FK 和 poll 会引入执行身份风险），也不激活 active scope。原状态作为历史事实保留，不伪改 cancelled；不会恢复有效设备 token/管理证书/凭据或自动启用插件。后续恢复若需要执行必须重新授权并创建新 run/key。此只读证据承载不是第二套操作运行系统。

旧 TRUNCATE CASCADE 可能清除目标身份/审计。在协调 preserving restore 完成前，必须在任何 DB 清空/文件 swap 之前拒绝有企业身份/审计的目标恢复，并验证原目标不变；格式能读不等于允许破坏性恢复。D2 Task 8/F1 仍须完成保留目标历史和投影重建，不因此缩小总目标。

## 分工与验收

先落共享 v2 类型/纯编解码与对象校验，再接可信 API refs/恢复初始化和实际 wrapper，最后统一消费者/维护/备份。共享 run-management/app/local-execution 不并行写；root 统一集成，其他负责人提供窄 helper 与明确接缝。完整任务列表仍是主计划 Task 5，不能只完成 v2 格式就收口。

必须实际 RED→GREEN：v1/v2 对象与 hash 约束；异步 barrier 阻止下一次工具/模型；A旧 checkpoint→A后改→B提交→恢复 child 只回 A且保 B；SQL unknown 即使 JSONL finished/人工 acknowledgment 仍阻断；source变化/坏对象/撤权/能力变更拒绝；半套 cache 下所有消费者一致；同 run 双 key 维护与未知删除/容量；备份缺引用拒绝、隔离恢复不激活历史操作；目标身份/审计不变。复用 Task 4 的真实产品/HTTP fixture，不预填成功 merge。PGlite、原生 PostgreSQL、真实 OpenShell/JJ 与付费模型分别记录。

本文为实际接口接续裁定；各批次按下列独立审查门禁推进，profile 不开放。

## 独立审查后的分批门禁（2026-10-20）

首次独立审查为 CHANGES REQUIRED，报告保存于本计划 evidence 目录；没有把设计或静态地图记为测试。审查允许两个不依赖恢复承载的批次先行：① 非恢复 v2 编解码、对象校验、私有异步 refs 与同步 checkpoint barrier；② live SQL canonical 成果消费者。前者使用现有 import/accepted 来源类型，遇到 recoverySource 或未知来源拒绝；后者遇到未认证的 restored/recovery 来源拒绝，不能退回缓存。两批通过不代表 Task 5 完成。

恢复批次采用最小明确规则：**v2 未完成任务的命令/测试证据不继承，目标必须重新验证**。源已完成节点的 accepted 记录保留其原始身份作为历史证明，不重跑、不改写为目标执行；旧终端批准绝不用于新派发。新目标的 run/attempt/generation/session/sandbox 身份必须重新分配。完整来源真实性、当前权限/能力、固定 backend/policy 和 SQL unknown 仍须核对。完整 v2 验证继承不在此批实现，后续如需启用须另列兼容字段及实际证据。

路径集合裁定：所选 A checkpoint 的 work 路径集合与源最新 canonical 中 A 当前获准导入路径集合不一致时，明确返回“检查点路径集合已变化，当前版本不能恢复此分支”，**不发布 child head、不修改 source**。不得将缺失项默认为删除，也不得悄悄把后来文件放进旧 checkpoint。Task 5 支持路径集合不变的内容回退并保留 B；C2 完整分支/循环恢复目标不因此取消，新增文件回退须另设计仅针对新 child 初始化的严格 owned-output omission。具名 RED：A checkpoint→A 新增允许输出→B 提交→选旧 A，验证零 child head/source 原样。

恢复 provenance 的实际持久字段/摘要/CAS 同事务协议、checkpoint 来源 variant，须在恢复 codec/初始化编辑前冻结并复审。既有 API/桌面维护 provider 的 accepted-stop 交付与原 sandboxId 复核、journal 丢应答核对协议，须在容量批次前冻结。只读备份 carrier/严格 DTO/可信 reader/claim fence，须在任何 task 备份或 restored-source admission 编辑前冻结。未冻结批次不以空索引、假 receipt 或缓存绕过；core/live reader 工作继续推进。

已先行独立修复旧 restore 的目标保护（不新增 task 备份格式）：在原 restore 事务/锁内、TRUNCATE 和任何文件 swap 前，对身份/会话/bootstrap/审计/outbox/projection 表取得 NOWAIT 的 SHARE ROW EXCLUSIVE 锁，再检查是否已有记录或已变更 bootstrap。繁忙或受保护均明确拒绝；空白 legacy 环境仍可恢复。此保护不是 preserving import，也不认证 task 备份或 restored-source 可执行性。隔离 HTTP 3 项、原扩展备份 6 项和独立原生 PostgreSQL 的并发锁证据分别保存，仍须独立代码审查。

## accepted-stop 设备子批次冻结裁定

基线 e3374fd；独立合同审查指出普通 perform 和 inspectStorage 会重启 stopped 沙箱、现有 get/waitForPhase 按名称查询且 admit 要求 Ready。先完成设备端交付语义，不提前开放 API/产品调用链；SQL 历史验收证明、accepted_stop admission fence 和三任务产品链仍须后续整批接通。

沿用既有 schema-2 task journal、maintenance 串行队列及固定 OpenShell CLI。私有 expected 严格为 `{version:1,stopId,key,sandboxId,workspaceRevision,proofDigest,accepted:true,checkpointResolved:true,operationsResolved:true}`，另必需可信进程内 beforeDispatch 回调；结果为身份六字段加 `{phase:'stopped',replayed:false}`。完整 key/sandboxId 和部分 workRevision 分别核对。调用入队前复制 expected，不能让排队或回调中的对象变动改变停止目标。

在原 admit 后调用 beforeDispatch；回调完成后同步重新读取 journal，要求 key、身份、工作版本、scope/binding、阶段、activeOperation/commandFence 和全部停止前记录与回调前一致，并重查本地 grant/config。中间不再 await，先 fsync `acceptedStop:{identity,stage:'stop_intent',intentAt}` 和 stopping，再派发一次原固定 stop 命令。失败保留 intent/unknown，不清空或重发。严格读取与容量 inventory 识别该记录；未知继续保留 running/scope/disk 占用，只有原对象确认为 Stopped 并落盘才释放 running。

确认和 reconcile 共用只读 mTLS/config/原 sandboxId 查询，校验原 id/name、配置准入及固定有效策略；不能调用要求 Ready 的 admit，也不能通过名称寻找替代对象。reconcile 不发 start/stop/exec/create/delete，不调用会启动沙箱的 storage inspect。缺原 intent、Ready/Stopping、absent/retired/错身份均不算停止成功；重复调用只核对同 stopId，绝不重发 stop。

只要存在 acceptedStop，普通执行、任务导出和 storage inspect 均拒绝，防止已验收对象再次启动；schema-1 行为不变。后续删除有单独目标/版本/审批边界，本子批次不放宽或冒充支持。用实际 executor/journal + 有界 transport fixture 保存 RED/GREEN、应答丢失/重启/坏 journal/错身份/回调变更/冷启动容量证据；物理 OpenShell、原生 PG、真实模型仍单独验收。未完成 API 接线不能声称第三员工产品容量问题已解决。

### accepted-stop SQL 合同冻结候选

在既有 task_attempt_workspaces 仅增加 nullable `accepted_stop jsonb`，旧行 NULL。私有状态 codec 位于 API，不进入网页/模型或恢复执行队列。严格 v1 记录为 `{version:1,identity,proof,state,preparedAt,dispatchedAt?,confirmedAt?,result?,lastError?,digest}`；所有嵌套 exact keys、无 unknown 透传，编码最多 32 KiB。identity 为上述身份六字段（version/stopId/key/sandboxId/workspaceRevision/proofDigest）。proof 严格为 `{accepted:{seq,digest},checkpoint:{id,sha256,seq},originalOperationId,originalMergeDigest,runtimeTaskId,principal,sessionId,contractHash,permissionHash,capabilityHash,deviceId,grantId,fingerprint}`。UUID、完整 key、正 seq、64位 SHA 和非空有界文本沿用现有约束。

令 D 为递归 key 排序 JSON 的 SHA256（array 不改序）；identity.proofDigest = D({kind:'task-accepted-stop-proof',version:1,proof})。外 digest = D({kind:'task-accepted-stop',version:1,identity,proof})，不自引用，也不把可变状态当签名。日期必须为规范 ISO UTC。prepared 仅 preparedAt；dispatching 还必须 dispatchedAt；unknown 可保留 dispatchedAt 和 lastError:{code,message}，不含 result/confirmedAt；stopped 必须 dispatchedAt、confirmedAt 和与 identity 完全一致的 `{...identity,phase:'stopped',replayed:false}`，不可有 lastError。所有存在的时间须单调。codec 仅证明结构，不能证明员工已验收或设备已停止。

普通 guard 单独检查本 run 全部非空 marker 并校验各自 row 完整 key：prepared/dispatching/unknown 拒绝任何普通 bind/scope/operation；stopped 拒绝其自身 key，但其他当前获准任务仍走原权限检查。检查须覆盖 bindTrustedAttempt 的同绑定提前返回和首代插入、resolveTaskScope，以及经 admitTaskOperation 的 enqueue/poll/start/result。无普通 except 参数。未知格式一律 fail closed。原 claim 的回执在失去可执行资格时仍按原 HTTP 逻辑保留 result/late_result，不能丢弃或用停止结果清除 SQL unknown。

后续历史 verifier 只可检查内部选定的同 stopId/key/proof 来更新自己的 prepared→dispatching→stopped，或 prepared/dispatching→unknown→stopped；不是普通操作免检模式。NULL→prepared 与每次状态前进均在原 project→run→scope 锁内 CAS，同一 proof/identity 不变。CLI 不在 SQL 事务内；COMMIT 应答未知不授权新 effect。stopped 结果只接受已选中 provider 的实际只读核对/journal 回执，不能凭调用者 JSON。此 SQL codec/guard 子批次不产生 stop、不新增 API route、不认证 accepted 资格；历史 verifier/provider 接线仍需独立实现和实际产品证据。

恢复/backup carrier 必须包含该列的只读 exact DTO 及其历史原状态；sourceHistoryDigest 与 unresolved 同时纳入非 stopped marker，不能因 phase=active 或 live 表为空就丢掉未知停止。不恢复 live marker/设备 journal，不自动重发停止。缺这些跨合同字段时，恢复与 task 备份继续封闭。

SQL 子批次已独立复审 PASS 后可实施：使用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 升级已有表；sourceHistoryDigest 保留全部 marker（包括 stopped），只有 unresolved 判定过滤非 stopped。`executable` 继续把权限类 4xx 转为 false，使 `/result` 进入原 late_result 分支，不能 route 前抛错丢回执；新派发和 pending merge 必须被 guard 阻断，已 committed 原回执的只读重取不当作新执行。历史 verifier/provider 仍闭合。

## 恢复/carrier 独立审查后的继续门禁

独立审查为 CHANGES_REQUIRED，尚未授权把整份提案直接写入恢复路径。除上述 accepted_stop 跨合同要求外，固定以下裁定：

- 第一批 live-source 只接受非恢复 parent，必须用原 SQL scope、原操作/claim/result/merge 与所选 v2 checkpoint 的完整正向关系证明来源。NULL sourceHistory、空 live 表或裸 null-merge head 不能证明 live；缺证据明确拒绝。历史模式要在 carrier 批次显式定义，不用缺失索引推断。
- sourceArchiveCursor 增加完整已验证 prefix 的 SHA（固定 seq 以内全部事件的规范编码），末事件 SHA 只作定位。相关 accepted/rework/mapping 不能在末事件未变时被替换。批准/首次初始化都校验，复制对象后、发布前再次核对源 head、SQL 历史和 prefix；现有 child 的 bookkeeping 只走持久 marker/child chain，不覆盖前进后的 head。
- A 回退后，对每个保留的已完成节点检查它的固定输入与上游 accepted 版本。B 字节保留不代表旧验收自动有效；若 B 依赖被回退的 A 版本，本批拒绝并保留 source/child head NULL，不假装 B 仍通过。完整依赖重算与后代失效策略留在 C2，不能通过吞掉失败缩小总目标。
- token-free carrier 的原 resultDigest 是可信导出见证的历史事实，不能由投影重算，也不是独立设备认证。导出先对原 SQL raw result 验真，再产生有版本/严格 schema/双摘要的投影；导入信任边界必须明确到原有认证加密 envelope。原摘要不重写、不送回 live merge 验证器。carrier codec/reader/import 仍须按修订合同独立审查。

当前本地已验证结果仅到 e3374fd 的非恢复 foundation，以及后续分批实际测试；本文裁定本身不算恢复成功证据。profile 继续关闭。

## accepted-stop 产品接线冻结裁定

设备基础已独立审查并提交 50826ad；SQL codec/普通 guard 本地完成，仍单独收口。历史 verifier/provider 提案独立审查后唯一必改（旧 work revision 不能用新递归排序 D 计算）已修正并复审 PASS。原 `checkpointDigest`、`checkpointContract`、`checkpointEnvironment` 和 canonical revision 算法不变；新 D 只用于新 stop proof/marker 及 accepted event envelope。

允许窄提取原 committed-operation/merge 正向校验 helper 供 active checkpoint 与历史 completed 共用；允许导出原 task-local acceptedVerificationRevision。历史 verifier 必须分别证明原 exact key/session/native completed、有效合同/权限/能力/lease/provider、accepted→boundary→v2 node CP→后续 native team checkpoint、原 scope/result/claim/committed merge及输出、当前完整 canonical（可为 B）。不得把 completed 加进 active resolver，也不要求 A 旧 partial/head 等于当前 B 的完整 head。

沿既有 project→run→original operations→device→scope 锁与 maintenance queue。NULL→prepared、同身份 prepared→dispatching 必须成功 COMMIT 才产生一次不可序列化 fresh dispatch closure；COMMIT 不明只核对原请求。callback 后仍做同步 archive/provider/本地 journal 复核，不增普通 guard except。真正已发生的 Stopped 用独立窄事实补记事务保存原身份结果，可在 cancel/lease 移交后补记；不授新 effect，也不把通用事务增加 ignorePermission/ignoreLease。停止失败不回滚已持久的 native completion/accepted/CP。

lazy provider 比较 executor 引用和 deviceId/grantId/fingerprint，不能比较新包装对象。只读核对已有 marker 必须在 bindAttempt 的普通 guard 前可达；新停止仅在 prepareTask 确认目标尚无 prepare 后发起。停止前后重新验证目标 context/当前权限/lease与scope，再走原 enqueue。缺维护能力的 task 路径明确拒绝；旧三参数构造和自定义注入保持类型兼容，不以缺 provider 静默跳过 task 保障。

实际验收新增三 distinct task：开发、QA、经理各有真实 task workspace 操作、不同 key/attempt/sandboxId。沿真实 ProductDshRuntime/Host/HTTP claim-start-result/CAS/Handoff 与真实设备 executor/journal/容量检查；CLI transport 及模型选择为 fixture，不 seed 成功 merge/accepted/CP。记录第三槽 pre-fix RED，以及 accepted→durable CP→stop intent→单 stop→原ID Stopped→下一 prepare 的顺序；保持两槽、128 scope及磁盘预留，不删除文件。另验 A 已验收但 B 已提交时可用 A partial 停 A且保 B；SQL/设备应答丢失、撤权/换lease/provider/目标变化、无 intent/absent 和迟到结果分别保留。

这批只接运行中的 accepted-stop，Task5 恢复/维护/carrier 和 Task6 原生PG/物理JJ/真实模型仍单列；profile 继续封闭到全部开放条件满足。

实现预审补充：provider 冻结并比较 stop/reconcile 方法引用，使用冻结引用调用；当前 B 完整 head 也需 B 自身原 claim/result/context/scope/committed-output 链的正向验证，不能只靠文件摘要。冷只读核对采用窄历史 observation verifier：允许运行已取消/结束或 lease 已转移，仍严格验证原 marker/accepted/v2 CP/SQL commit、原有效 device/grant/backend 与本地授权，只 get 原 ID并补记事实；不读取新知识、授予新工具或派发权限，不给通用 current/transaction/普通 guard 加 ignore 选项。随后普通 bind/执行照常拒绝失效权限。本批不新增公共核对 route。

本批本地产品接线已独立复审PASS：最终同步证明矩阵9项实际RED后完整API39项通过，三distinct员工的正常/交错/应答丢失三场景在最终源码上通过，scope25、类型与构建通过。原claim和完整binding正向校验共用；提交前基线与提交后同步相关档案/对象复核不引入新SQL豁免。实际证据见 `docs/validation/accepted-task-stop-product-2026-10-20.md`。模型、CLI、mTLS/UID/cgroup为工程夹具，不当作真实模型/物理JJ验收。先前OOM/未知进程失败日志保留，不以场景绿色证明长运行稳定性。

源审查另发现最后经理scope仍可能占槽，不能据同run三员工通过宣称跨run容量完成。下一批按已独立冻结的 `docs/superpowers/plans/2026-10-20-task-stop-finalization.md` 复用原队列/journal，补源任务finalizer、共享deadline、SQL派生待维护投影与有权限的原ID网页核对；再验证同一executor连续三项目。任务精确回收、恢复/carrier和Task6仍分批推进，profile不开放。
