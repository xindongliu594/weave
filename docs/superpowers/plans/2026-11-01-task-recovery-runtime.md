# Task 4：初始化成果进入真实任务运行的最小合同（待 root 审核冻结）

日期：2026-11-01。这里只完成本地源码调研和接口建议，未改产品源码，未运行数据库、模型或网络。本文件不代表公开恢复入口、企业 profile 或 JJ 验收已开放。

前置：[任务恢复来源与初始化](2026-10-21-task-recovery-source.md) 的 Task 1–3。继续复用固定 DSH `0.1.5-rc.1` 的员工 Host/session/checkpoint-policy、AgentTeams `0.1.20` 的 staged restore、现有 HTTP 设备 claim/result、任务 planner、SQL 提交链和原生 writer manager。不新增调度器、恢复引擎或文件系统。

## 1. 源码核查所得的直接阻断

1. `task-execution.ts:pinnedInputs` 只给合同输入，`rebuildTaskScope` 只追加当前 key 的 own commits。child 已有 A 的恢复输出，但 child own commits 为空；`task-workspace.cjs:buildWorkspace` 因现有输出缺少 read authorization/origin 拒绝。因此删掉 recovery 条件也不能执行 A。
2. `pinnedInputs` 只认本 run 最新 `handoff/accepted`。B 的原 seal 仍属于 parent，不能复制成 child accepted，也不能只按 taskId 查最新来源。
3. `validateTaskCheckpointRefs` 精确拒绝额外外层字段、foreign origin 和额外 origin 键。虽然 TypeScript 已有一个缺 generation 的 `recoverySource?`，运行时并不支持；不能据此声称已接通。
4. `RunCoordinator.tick` 在 `acquireOwner(child)` 后才进入 `launchOwned`。`withSource/withRecoverySource` 明确禁止在已有 writer 上下文中嵌套取得源锁，所以不能在 `sandbox.prepare()` 内调用现有 initializer。
5. `launchOwned` 当前对 `workspaceCheckpoint` 调用 `restoreStepWorkspace`，复制的是 CP 的 A 小工作集。task profile 必须使用 SQL marker 已发布的完整 initialHead/当前 head，否则会遗漏 B，或者碰到已存在 artifacts 后拒绝。
6. `TaskAcceptedStopLifecycle.terminalAuthority/terminalEvidence` 要求每个批准任务都有 child SQL scope、当前 member 和 child accepted。保留的 B 没有 child sandbox，这个要求不能沿用，也不能给 B 伪造 scope/stop。
7. `readLiveCanonical` 无条件拒绝 recovery 和 NULL-merge head。初始化后首个真实 prepare 之前，合法 child 正是 NULL-merge head，必须走准确 marker 根分支。

## 2. 身份及不变量

- 新 A 完整 key 是 `{childRunId, taskId, childAttemptId, childGeneration}`，session/runtimeTaskId 由新 staged team 和真实 `bindTrustedAttempt` 产生；generation 不能由模型指定。parent generation 只作为来源，不要求 child 的数值 generation 大于 parent。
- parent A 的未验收输出是恢复工作基线，不是 child 的 `committed_outputs`，也不是已接受的 B 输入。不复制 parent claim、receipt、sandboxId、session、终端批准或旧测试。
- B 的原 `accepted.runId/taskExecution.key/attemptId` 和 node-accepted CP 保持 parent 身份。child staged team 可以恢复其 completed 状态；不能为此创建 B 的 child SQL 工作区、执行器或停止请求。
- 所有执行依旧经过当前 project/run/设备/部门/知识/插件权限、lease、未决操作、预算和结果验真。恢复来源格式/摘要只检测一致性，不能独立授予执行权限。
- 费用与调用累计继续读现有预算、收据和 `budgetHistory`；不从 CP 回退这些记录。旧未知费用和原容量上限不变。

## 3. 推荐的最小合同：复用 V1 初始化记录

### 3.1 V1 已有字段能推导什么

只做“选中 A 的同路径恢复 + 已验证 B 的原验收保留”时，现有 V1 足够，不新增 evidence envelope：

1. `initialHead.manifest` 按 `readPaths` 过滤，正好得到 A 旧工作 manifest；必须重新计算摘要，等于 `checkpointWorkRevision`。Task 2 已证明当前/旧 A 工作路径集合相同、只读输入相同，planner 只改变获准同路径内容，因此这个推导有明确前提。
2. 原 A 的完整 key/generation、CP id/SHA/seq 已在 `source.sourceCheckpoint`。恢复 own-output seed 来自 `readPaths ∩ writePaths`，剔除仍属于合同固定输入的路径；逐项核对当前合同、初始 manifest 和初始化 delta。不得因此授权读取 `private.txt`。
3. B 的完整 parent key、commands、输入/输出及报告已在实际 child SQL `snapshot.handoffCheckpoints`。真正 source collector 已把它们逐项绑定到 verified retained 集合；无需再复制一套 B nodeCP pins。
4. 在初始化及**每次 launch 之前、尚无 child writer/SQL 事务时**，用真正 source guard 重捕获 source/权限/retained 和原批准，验证 child SQL snapshot 与唯一 `run/created` 固定的原始 archive snapshot 一致。该步骤之后重新锁定并核对 child snapshot/marker 再领租约，关闭准备到 launch 的 TOCTOU。
5. 运行中的每个消费口仍重读真实 SQL marker、原 child archive snapshot 和连续 child committed 链，并核对固定 snapshot。后续 parent 变化不能改写 child 已固定的 SHA，也不能把新的 parent accepted 自动替换为本 child 输入。需要重新认证/初始化时回到前置入口，不能在已有 child writer 内升级源锁。

没有单独保存逐路径 origin 不构成缺失：这里定义的是新的恢复 CP 基线来源，原 A origin 以其 parent key + CP 工作 revision + CP id 明确表达，**不冒充**父任务原提交的 canonical revision。B 则保留原 accepted 的真实 revision。`task_evidence` V1 的旧格式、512 KiB 上限和 `sourceHistory:null` 均保持。

上述 launch 前正向重验证、SQL/archive snapshot 固定和后续真实 child 链缺一不可。单独 V1 codec 成功、单独 NULL head 或模型提供的同形 seed 均不能授予执行权限。

### 3.2 新 scope 的独立 seed

```ts
type CheckpointPin = { key: TaskAttemptKey; id: UUID; sha256: SHA256; seq: PositiveInt };
type TaskRecoverySeed = {
  version: 1;
  initializationDigest: SHA256;
  sourceCheckpoint: CheckpointPin; // 含 parent generation
  workRevision: SHA256;          // 等于 Initialization.checkpointWorkRevision
};
// 新 child scope/新 child v2 refs 可选，旧记录一律不补此字段。
TaskExecutionScope.recoverySeed?: TaskRecoverySeed;
TaskCheckpointRefs.recoverySeed?: TaskRecoverySeed;
```

- seed 输出只包含所选 A 在原 CP 已存在、属于获准 writePaths 的恢复输出。path/SHA/size 从真实 SQL initialization 完整 initialHead/readPaths/writePaths 推导，不接收调用方数组；scope 中只保存上面的三项已有 pins。只读合同输入仍放 `inputOrigins`。
- seed 输出的 origin 明确定义为 `{path,runId:parentKey.runId,taskId:parentKey.taskId,attemptId:parentKey.attemptId,acceptedRevision:seed.workRevision,checkpointId:parentCP.id}`。`acceptedRevision` 在此表示已提交恢复 CP 的工作版本，不表示员工已经交接验收；类型和授权区分依靠 `recoverySeed`。
- `rebuildTaskScope` 的顺序为固定合同输入 → 真实 seed 输出 → 当前 child key 的真实 own commits。seed 输出只增加 readPaths/origins，不加入 SQL `committed_outputs`。
- child 后续改写同一路径时，workspace 的 rolling origin 变成真实 child commit；`recoverySeed` 保留原基线，不能跟随当前内容重写。新 scope 及 CP 外层仍绑定 child key。
- 若其他未完成员工已经有未验收输出，不能自动当作 A seed 或不明 opaque 文件导入。首批应明确拒绝为该员工初始化已有输出，直至它也有按固定 source chain 推导的独立 seed 合同；不能因此丢弃其文件。
- 同一 child 后续换 generation 时，也不能把上一 generation 的输出直接归给新 key；没有明确的真实链桥接就拒绝，不补通用分支重算。

### 3.3 B 的跨 run 固定输入

保留旧 `import`、本 run `accepted` 来源格式。新增明确 discriminator，避免给旧 accepted 记录补 generation：

```ts
type RecoveryAcceptedSource = {
  kind: 'recovery-accepted';
  initializationDigest: SHA256;
  key: TaskAttemptKey;          // parent B 完整 key
  revision: SHA256;
  acceptedDigest: SHA256;      // 已绑定到 child SQL/archive snapshot 的原 seal
};
```

`origin` 保留 parent B 的 run/task/attempt/revision，不改标为 child。只有前述 launch 正向来源检查过、实际 child SQL/archive snapshot 中固定的 seal 能构造该来源；逐路径核对合同依赖、accepted 输出、候选/当前字节。新的 child producer 被真实验收后仍使用现有本 run accepted 路径。相同 task/attempt 对应多个 generation、重复相同来源 tuple 或找不到精确 seal 均拒绝。

### 3.4 v2 codec 的兼容规则

- `step-checkpoints.mjs:validateTaskCheckpointRefs` 的 exact keys 仅增加可选 `recoverySeed`，其全部嵌套仍 exact；弃用现有仅 TypeScript 可写、运行时不认的 `recoverySource?`。
- 原有 `inputOrigins` 校验保持。只有 `recovery-accepted` 可携带经过实际初始化记录和固定 child snapshot 绑定的外来固定输入；只有精确 seed 路径可出现没有合同 inputOrigin 的 parent A workspace origin。
- 原父 origin 结构不新增 generation 键；完整 generation 位于 source/seed 的 `TaskAttemptKey`，避免改变 `task-workspace.cjs` 的旧 origin schema。planner 本身允许来源 run 不等于 binding run，继续使用它的原路径/manifest/hash算法。
- 已被 child own commit 改写的 seed 输出必须按当前 key 的真实提交验真；纯 codec 不能凭“存在 lastMerge”宣称这种来源已认证。
- `checkpointDigest` 不变。无新字段时 `checkpointContract/checkpointEnvironment` 的输入对象、键顺序及结果完全不变；有新字段的新记录使用显式新 domain/version，把 `recoverySeed`/新 source 元数据纳入绑定。旧 CP 不重编码、不补字段、不改摘要。

## 4. 共同消费者接口

建议一个窄服务函数，始终从调用方原事务连接重读真实 SQL，而不收 `verified/skipRecovery`：

```ts
readTaskRunRecoveryState(db, traceRoot, runId, archive)
  -> null | {
    initialization,
    initialCanonical, currentCanonical,
    retained: OriginalAcceptedSeal[],
    selectedSeed: TaskRecoverySeed,
    seedOutputs: (ManifestEntry & { origin: TaskWorkspaceOrigin })[]
  };
```

调用者持现有 project → run 锁（读取消费者按其原只读规则取得真实 SQL 行）；函数校验实际 V1 envelope、固定 child snapshot/archive、完整 initialHead 对象、初始化 marker 与三项已有 pins 的关系。head 前进时，复用真实 claimed child before→after 链，要求根精确等于 marker.initialHead，逐 scope 校验 seed/来源与真实 marker/固定 snapshot 的关系。NULL head、单独档案 marker、纯 codec 成功或外部传入对象均不能获得此状态。

这个函数不重取 parent 原生锁、不复制文件、不调用设备，不因 return 对象便开放 profile。需要核对/修复来源时，走独立的无 child writer 前置入口，重新运行真正 initializer/source guard；不能在运行事务内升级锁。独立成果读取也须核对真实初始化与固定 snapshot，不把缓存格式验证冒充一次新的源认证；若需要重新认证则由其无 writer 外层取得 source guard。

### 具体文件接缝

| 文件/函数 | 必须接入的行为 |
| --- | --- |
| `task-execution.ts:bindTrustedAttempt/resolveTaskScope/pinnedInputs/rebuildTaskScope` | 新 Host 建 child key；真实恢复状态允许替换原无条件恢复拒绝；seed 作为独立 read baseline；B 输入用精确 whitelist 来源。本 run 原有 active/member/lease/权限、unknown 和 previous-scope CAS 全部保留。 |
| `task-operation-admission.ts:admitTaskOperation` | 每次实际 enqueue 从同连接重核真实 run recovery state、child key 和 seed。只替换无条件 recovery 拒绝，保留当前 scope/lease/accepted-stop 门禁；metadata 不能作为调用参数批准。 |
| `task-canonical.ts:permissions/initializeTaskCanonical/admit` | recovery child 不允许从 artifacts 扫描初始化新根；必须已有准确 marker/head/固定 snapshot；只 materialize 已验证完整当前 head。prepare/result 仍真实 HTTP claim/commit，planner 不变。 |
| `local-execution.ts:prepareOwned/prepareTaskOwned/taskTransaction` | `prepare()` 消费已发布状态，不调用源 initializer。A 首次真实 prepare 使用带 seed 的 importedFiles，生成全新 sandbox_identity 和真正 child committed operation。 |
| `task-checkpoint-state.ts:prepareTaskCheckpoint` | 用真正 child 最新 SQL operation/新 scope/key/session 发布 CP；携带不可变 recoverySeed；前置、后置、COMMIT 后发布的 assignment/authority/object 检查均保留。 |
| `task-original-commit.ts` 及恢复 child 链读取 | 新 scope 的 seed 要在共同恢复状态验证中对实际 SQL marker/固定 snapshot 检查；保留 claim/result、scope/result digest、backend、sandbox、own-output 一一对应证明。不得接受仅带 seed 的伪 row。 |
| `task-accepted-stop.ts:current/observation/verify` | 真实 child A 的停止仍要求 child accepted → nodeCP → original claim/commit 与全新 sandbox，不忽略状态。pinned-input 检查复用共同来源派生函数。 |
| `task-accepted-stop.ts:terminalAuthority/terminalEvidence` | 从真实恢复状态将批准任务分为原 B retained 与本 child materialized scopes。B 只核已固定原 seal/dependency/当前字节，无 child scope/member/stop；A 继续原完整停止流程。不能复制 parent B stopped marker。 |
| `live-canonical-reader.ts:readLiveCanonical` | 有准确 SQL初始化记录时允许它的精确 NULL-merge initialHead；后续要求连接该根的真实 child 链。legacy NULL 根及不明恢复仍拒绝。所有成果消费者共享该分支。 |
| `product-runtime.mjs:execute` | executor `prepare()` 必须在 Host/模型前完成真实状态验证；替换原无条件 recovery throw，不用任意 plain-object proof 或 `skipRecovery`。完整文件一致性读 canonical，缓存仅兼容镜像。 |
| `host.mjs:bindActiveWork/restoreCheckpoints`、`checkpoint-team.mjs` | 沿现有 staged restore 恢复 B completed。A 由新 AgentTeams/EmployeeHost 建新 session/attempt，并经真正 bindAttempt分配 generation。不得恢复父 A session 或让 B 再执行。 |
| `handoff.mjs:HandoffGate` | 使用已经绑定真实初始化/固定 snapshot 的原 B seal；A 新 commands/writes/stepStatus 为空，旧测试保持不可继承。新 A/B 依赖按当前文件字节核验。 |
| `run-coordinator.ts:tick/launchOwned` | queued child 初始化发生在无 SQL/child owner 时，完成后重新领 project/run、状态与 marker。task 恢复 `prepareWorkspace` 只镜像完整 SQL head；legacy 才走 restoreStepWorkspace。 |
| `run-management.ts`、`step-checkpoint-recovery.ts` | 现 selector 是 legacy摘要/全 CP 小工作集逻辑，不能冒用作 Task4。任务 profile 私有工程选择器调用真实来源事实；无 child 的 preview 只能诊断，不签发批准。服务器组装完整 B seals/上下文/预算后才创建并固定 child snapshot。 |
| `execution-policy.ts:assertExecutionProfile` | 公开 profile gate 最后单独处理。私有工程链完成不等于全局开放；不得添加 caller 布尔绕过，也不得为通过测试临时删除 `snapshot.recovery`。 |

## 5. 分块实施与验收

1. **先固定 V1 派生与新 CP codec。** seed/recovery-accepted RED → GREEN；旧 V1 evidence、原 CP v1/v2 roundtrip/hash 金样保持，坏来源 generation、未知字段、来源/目标混用、错 initdigest、重复来源、凭据脱敏和过大记录均拒绝。增加“没有 launch 前真实来源检查不可进入正式运行”及 snapshot 改写负例。
2. **接 SQL scope/admission/canonical/checkpoint。** 用已经真实初始化的 child，保留原 snapshot，真实 HTTP prepare/start/result。A 新 key/session/sandbox，第一次 prepare 带旧 a.txt；child committed_outputs 只包含 child 真操作；private.txt 在完整 canonical 内而不送设备。真实读取、改写、提交、前后 CP 通过。
3. **接保留验收与终态/reader。** B seal 字节及 full key不变，B零新设备操作；A 实际新验收/新CP/停止。B 的输入失效则拒绝，绝不丢 B seal 或代跑 B；unknown/late/坏对象/撤权/错误 generation/旧终端批准均阻断。初始化 NULL根、child前进和应答丢失后的读取都须有真实SQL证明。
4. **接 Product/Host/协调入口。** 真实 ProductDshRuntime → 新 EmployeeHost → DSH checkpoint policy → Handoff → HTTP → SQL，完成 A 后交付。staged restore 让 B 保持 completed，运行次数/调用预算不回退。验证原生锁不在 child owner 内升级，原生 PostgreSQL 独立连接与 PGlite 证据分开。
5. **最后产品门禁。** selector/retry/coordinator、网页主流程及 JJ/OpenShell/真实模型小任务按照原独立门禁验收。未做真实模型、未完成公开 gate时明确保留关闭状态；不得用工程夹具声称网页已能恢复。

本合同待 root 冻结的核心选择只有两个：无 writer 的初始化/launch 正向检查及随后 child snapshot/marker 再核的准确位置；新 v2 可选 seed/source 的 exact schema 与摘要 domain。没有冻结这两点前，不并行修改消费者源码。当前建议复用 V1，无需新 envelope 或 CP v3。
