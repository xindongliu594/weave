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
