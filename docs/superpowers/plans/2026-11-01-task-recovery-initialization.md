# Task recovery initialization implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 当前用户已选择 root + 2 agents；数据库工程验证仍串行占一个执行槽，不另行请求执行方式。

**Goal:** 在可信 live 来源核对后，将完整候选成果一次性发布到已批准、尚未初始化的 child，并在丢应答或 child 后续前进时只补证、不回退。

**Architecture:** 复用固定 DSH persistence、AgentTeams staged restore、现有 SHA 对象存储、task merge planner 和 PostgreSQL 锁。先以原 Manager 一次取得 source 排他读与 child 写权限，再组合 Task 2 可信 collector，在同一事务原子发布 canonical head 与严格初始化记录；没有新恢复引擎、插件引擎或文件存储。

**Tech Stack:** Node.js ESM、TypeScript、pg/PostgreSQL、fs-native-extensions 1.5.1、现有 Zod codec、PGlite 工程测试。

**Spec:** [原 Task 3/4 合同](2026-10-21-task-recovery-source.md)、[已完成事实层验收](../../validation/recovery-source-primitives-2026-10-30.md)。本文件是定向源码审计后的执行拆解；现有复用调研继续有效，不重做网络选型。

## Global constraints

- 总体企业 profile 保持关闭。完成私有 initializer 不等于网页可恢复，不删除现有 `TASK_RECOVERY_UNAVAILABLE` gate。
- 累计 $3.41、七笔旧未知费用、现有权限、2 running / 128 retained 上限不变。本批只做无付费工程验证。
- 首批 source 必须停止、排空、非恢复的 live parent；NULL、空表、裸初始 head、档案 `integrity:ok` 不构成原操作证明。
- A 的路径集合变化、B 依赖被回退 A 版本、SQL unknown、late/pending merge、scope unknown、非 stopped accepted_stop 均拒绝。保留 B 字节与验收，不重跑 B。
- 不复制 parent live operation、claim、sandbox/session 身份或收费回执，不修改 source、预算、费用及既有 v1/v2 检查点摘要算法。
- 原 Task 1 codec 的 `authority`、512 KiB 限制和 NULL 与合法 V1 空记录的区别不变；不放宽归档凭据脱敏。
- 本批不涉及 members/observability/eval、部署、JJ/OpenShell/真实模型调用或 backup carrier。

## Review focus

1. source scope 不能嵌套 writer：两 run 必须一次取得原生锁，且 source 永远不可写；Task 1 验证角色、跨进程互斥、失效与失败闭锁。
2. SQL 已提交但 COMMIT 应答丢失：丢弃连接，只读核对同一 child，不把 ROLLBACK 应答当作未提交证明；Task 3 注入前后丢应答。
3. child 已有新 merge：恢复记录只能补证当前连续链，缓存不得写回 initial head；Task 4 验证两次前进及重入。
4. 复制后权限或来源发生变化：发布前同锁重读全部 pins；Task 3 验证撤权、source 前缀/SQL head 改写、坏对象与取消。
5. 新 nullable 列使固定导出 schema 漂移：迁移不回填、不默认认证；Task 2 验证 schema catalog，并明确 recovery carrier 继续拒绝。

## 已核实的接缝与文件责任

| 现有位置 | 已有能力与需要补的接线 |
| --- | --- |
| `services/agent-runtime/archive-writer-scope.mjs` / `.d.mts` | `withSource` 仅顶层只读；`withWriter` 不能在 source 中借用，`acquireOwner` 也不能嵌套。新增窄 `withRecoverySource(sourceRunId,childRunId,fn,options)`，不是放宽 `withSource`。 |
| `services/agent-runtime/archive-write-fence.mjs` | 已有 shared root + 排序 run lifetime 锁；`acquireMaintenance([source,child])` 对两个 run 都排他。直接复用原生 guard，不新增原生锁模式。 |
| `apps/api/src/task-recovery-source.ts` | Task 2 正在组合 `captureLiveTaskRecoverySource(writers,locator,signal)`；提取实际 guard 下的 transaction/collector 供 initializer 调用，不能拿返回 JSON 当长期授权。 |
| `apps/api/src/task-recovery-provenance.ts` / `task-recovery-scope.ts` | 复用原操作链、所选 CP、候选 planner、保留 B 的验证；不能新增“忽略停止/未知状态”开关。 |
| `apps/api/src/product-schema.ts` | `migrateProduct` 已添加 `canonical_workspace`，在其旁增加 additive nullable `task_evidence jsonb`。 |
| `apps/api/src/task-recovery-state.ts` | 复用 `TaskRecoveryInitialization`、`TaskRecoveryEvidenceV1`、摘要与严格 decoder，不另造认证标记。 |
| `apps/api/src/task-canonical.ts` | 复用 `readCommittedCanonical`、`materializeCommittedCanonical` 和原 merge 验真；现有 `initializeTaskCanonical` 直接从 artifacts 初始化，会绕过恢复来源，产品接线前必须明确分流。 |
| `apps/api/src/task-recovery-initialization.ts`（新增） | 只负责 child 对象复制、NULL-only 发布、初始化记录重入验真、事件/缓存补证。 |
| `apps/api/src/live-canonical-reader.ts` | 当前明确拒绝 recovery 与 NULL-merge 初始 head；待 Task 5 冻结后以 initializer proof 分支接入，不能只删除拒绝条件。 |
| `apps/api/src/enterprise-backup-tables.ts` / `backup-checkpoints.ts` | 固定列/fingerprint 与 NULL-merge head 来源检查需显式处理；载体支持另列合同，本批不可借迁移自动开放恢复导入。 |
| `services/agent-runtime/product-runtime.mjs`、`host.mjs`、`checkpoint-team.mjs`、`checkpoint-context.mjs` | 已有新 team staged restore 和上下文；后续只接可信 evidence，不复制原 session 或重建另一套 DAG。 |

## Task 1: 原 Manager 的 source/child 组合权限

**Files:** 修改 `services/agent-runtime/archive-writer-scope.mjs`、`.d.mts`；新增 `services/agent-runtime/archive-recovery-source-scope.test.mjs`（必要时新增同名专用 process helper）。

**Interfaces:**

```ts
withRecoverySource<T>(sourceRunId:string,childRunId:string,
  fn:(scope:ArchiveWriterScope)=>T|Promise<T>,options?:ArchiveFenceAcquireOptions):Promise<T>;
```

原始 factory Manager 的 `assertArchiveSourceScope(writers,sourceRunId)` 可在该回调中认证固定 source；`assertWriter(childRunId)` 只认证 child。其余 source/write 角色、maintenance、root、owner 与新增 run ID 均拒绝。`ArchiveWriterScope.retain` 只保留原 child producer 的寿命，不暴露 native guard 或可转交 source authority。

- [x] 先写失败测试：source 只读、child 对象/事件写入可用、角色反向/伪 Manager/越界/同 ID/嵌套升级拒绝；回调结束、逃逸 AsyncResource 后两种权限都失效。
- [x] 运行 `node --test services/agent-runtime/archive-recovery-source-scope.test.mjs`，确认缺接口导致 RED。
- [x] 一次 `fence.acquireMaintenance(sorted[source,child])`，内部将逻辑 source ID 与 child writer ID 分开；原生断言必须使用真实 maintenance guard，不能伪装 source guard。取得全套锁后才运行回调；部分获取失败由原 fence 反序清理。
- [x] 失败策略沿原 writer：不确定写入/原 producer 失败会保留锁并 fail closed；只有调用方已证明的无副作用拒绝，作为 `{ok:false,error}` 值返回。原 `withSource` 继续保持只读拒绝可释放的语义。
- [x] 新测试以独立真实进程证明两个 run 的 writer/source/root 被阻断、第三个 run 可写、竞争 initializer 只能一个进入；retain 完成前不放锁。运行新测试及旧 `archive-source-scope.test.mjs`、`archive-writer-scope.test.mjs`、`archive-write-fence.test.mjs`。结果见 [组合权限验收](../../validation/task-recovery-source-child-scope-2026-11-01.md)。

## Task 2: additive nullable evidence 与严格读取

**Files:** 修改 `apps/api/src/product-schema.ts`；新增 `tests/task-recovery-initialization.test.ts`；按现有 schema 生成/核对流程更新 `apps/api/src/enterprise-backup-tables.ts` 的真实列与 fingerprint，但不声明恢复 carrier 已支持。

**Interfaces:** SQL `project_runs.task_evidence jsonb NULL`；继续用 `decodeTaskRecoveryEvidence(value)`，SQL NULL 不传入 decoder 当空 V1。

- [ ] 写迁移测试：旧 run 升级仍 `task_evidence IS NULL`，迁移两遍无新增认证/operation，原 canonical、snapshot、费用逐值不变；新 run 默认 NULL。
- [ ] 执行 `node scripts/test-integration.mjs tests/task-recovery-initialization.test.ts --test-name-pattern=migration` 观察 RED；增加一条 `ADD COLUMN IF NOT EXISTS`，不设 default、不回填。
- [ ] 新 source collector 必须分别核对 source evidence 为 NULL 和 child evidence 原值；不可将新列悄悄加入已有 `task-live-source-history` v1 摘要而改变旧记录解释。若要扩展历史摘要，显式版本化；本批优先单独 pin/精确 CAS。
- [ ] 核对固定备份 schema：新列不允许静默丢失；已有 recovery child 仍按明确 unsupported 拒绝。`backup-checkpoints.ts` 的恢复 NULL-merge 认证待 carrier 合同，不以假的 committed operation 绕过。
- [ ] 运行迁移测试与相关 enterprise schema catalog 测试，保存“API/SQL 已验证、carrier 未开放”的证据。

## Task 3: NULL-only 完整发布

**Files:** 新增 `apps/api/src/task-recovery-initialization.ts`；提取/复用 `apps/api/src/task-recovery-source.ts` 的 guarded collector；扩展 `tests/task-recovery-initialization.test.ts`。

**Interfaces:**

```ts
initializeLiveTaskRecovery(writers:ArchiveWriterManager, input:TaskRecoveryLocator,
  signal:AbortSignal, fault?:TaskRecoveryInitializationFault):Promise<{
  initialization:TaskRecoveryInitialization; currentHead:CanonicalRef; existing:boolean;
}>;
type TaskRecoveryInitializationFault=(point:'blob-fsync'|'before-sql-commit'|
  'after-sql-commit'|'archive-append'|'cache-mirror')=>void;
```

这是私有可信 locator 入口；只收 sourceRunId/checkpointId/childRunId，不收调用方 `source`、候选 files、verified 标记或权限事实。fault 仅工程测试传入，不接 HTTP。

- [ ] 写失败测试，使用真实 SQL/对象/档案事实调用入口：A 旧 CP → A 后改 → 独立 B 提交/验收 → 停止 source → 已批准 queued child；断言 child 全 manifest 中只有 A 内容回退、B 字节保留、head 的 mergeId/receipt 都 NULL、evidence 非 NULL 且严格解码通过。
- [ ] 运行该定向工程测试观察 RED；将 collector 提取为需要原 Manager `assertArchiveSourceScope` 的内部 entry。public capture 继续 `withSource`，initializer 使用 `withRecoverySource` 包同一 collector/SQL 事务；不在 source 回调中嵌套 writer。
- [ ] 原生 locks → `BEGIN` → exclusive advisory `918275` → project → source/child 按 ID `COLLATE "C"` → 全 operation → device → 全 scope → 排序 actor/native namespace → `assertCurrentRunPermissions(...,{authorityLock:true})`。沿用 Task 2 顺序和 query deadline/取消结算，不倒置成本/项目锁。
- [ ] 校验 child 尚无操作/scope、尚未开始、同 project/plan/source/checkpoint 且 head NULL。evidence 原值仅允许 SQL NULL 或严格 V1 `{version:1,recoveryInitialization:null,sourceHistory:null}`；分别保留原值，不合并两者。
- [ ] 从 source 最新完整 head + 所选 checkpoint + planner 候选生成 Initialization。复制全部候选 SHA 对象到 child，复用 `storeArchiveObjects` 的 fsync/链接与大小防护，随后 `readArchiveObject` 全量核验。不提前写 artifacts 当 authority。
- [ ] 发布前在同一 guard/事务内再次核对 source 全 SQL/history/archive cursor、child 原值、权限/backend/capability/resource pins、B 验收关系及对象，取消则不发布。没有 callable JSON proof 的信任路径。
- [ ] 一个 SQL `UPDATE project_runs SET canonical_workspace=$head,task_evidence=$evidence WHERE id=$child AND canonical_workspace IS NULL AND task_evidence IS NOT DISTINCT FROM $old::jsonb RETURNING id`；rowCount 必须 1。此事务不写 parent 或 live operation，不分两次 head/marker UPDATE。
- [ ] COMMIT dispatched 后任何失败视为 unknown：`release(true)` 丢弃原连接，停止发布新动作。另用新连接只读核对同一个 child marker + head/后续链；不重发设备/员工操作，不因 ROLLBACK 成功清掉 unknown。无法确认则明确 unknown，原 scope 依 writer 失败策略闭锁，不能强制解锁。
- [ ] 注入复制失败、发布前取消/撤权/坏对象/改写 source、head-only/marker-only/不同 marker、COMMIT 执行前与执行后应答丢失；确认始终无半份 SQL 发布、原来源和所有费用不变。
- [ ] 运行 `node scripts/test-integration.mjs tests/task-recovery-initialization.test.ts`，只表示 PGlite 事务/工程证据；独立 PostgreSQL 锁与断连放 Task 4 单独验证。

## Task 4: 丢应答重入、child 前进与工程链

**Files:** `apps/api/src/task-recovery-initialization.ts`、`tests/task-recovery-initialization.test.ts`；新增 `tests/task-recovery-initialization-postgres.test.ts`（复用项目现有隔离 PostgreSQL 测试配置，不触生产库）；工程证据 `docs/validation/task-recovery-initialization-2026-11-01.md`。

**Interfaces:** 同一 initializer locator 重入；内部 `verifyTaskRecoveryChild(db,traceRoot,row,initialization)` 返回当前 canonical，使用原 `verifyOriginalTaskCommit`/merge record 验真，不导出调用方可设置的认证对象。

- [ ] 先写失败测试：初始化后 child 真实 merge 一次、再 merge 第二次；旧 initializer 重入只得到 current head，保留第二次字节，事件仍仅一次。
- [ ] 既存 marker 先严格 decoder、身份/checkpoint/approval digest；从 `initialHead` 开始，按真实 child committed operation 的 before/after revision 接续到当前 head，全量验原 claim/result/scope/receipt/objects。缺链、分叉、unknown、伪造父回执均拒绝。不得重新运行“child 必须全空”的初始发布校验而误把正常前进判为未初始化。
- [ ] 复用原 `materializeCommittedCanonical`，在重新取得 child SQL 锁后读取当前 head；补事件使用固定 `sourceKey: 'task-recovery-initialized:'+childRunId`，内容绑定 immutable initialization digest。事件或缓存失败不回滚已提交 SQL，也不重做初始化；同 sourceKey 内容冲突应拒绝。
- [ ] PGlite 注入 SQL 后事件失败、缓存失败、丢应答后再次查询、坏中间 merge；断言只补证/修复当前缓存，费用与 operation 数不增加。
- [ ] 原生 PostgreSQL 两个独立 backend + 两个 process 争相初始化同一 child，另一实例只能等待/拒绝或返回同一 marker；杀连接/丢 COMMIT 应答后新连接核对，不重复 UPDATE 或设备动作。新源写者在整个 source 核验/复制/发布窗口均被原生 fence 阻断。
- [ ] Product/Host/HTTP/SQL 工程源验收复用现有 fake provider 与真实执行路径，不手填“已验证”历史。覆盖 A/B 主链及 B 依赖失效、路径新增、unknown stop、早期事件改写、撤权、坏对象、错身份。
- [ ] 保存命令、exit、测试数、源码 hash，分别写明 codec、接口/SQL、原生 fence、独立 PostgreSQL、组件/浏览器/真实模型证据。没有运行的列未验证；不以 PGlite 冒充独立锁、不以工程 fake provider 冒充真实模型。

## Task 5: 初始化验收之后才冻结产品恢复接线

此部分是明确后续边界，并非本 initializer 的“完成”断言。先完成 Task 3/4 与独立审查，再列产品接线测试，不直接删 gate：

- [ ] `packages/contracts/task-execution.ts` + `step-checkpoints.mjs`：新版本 `recoverySource` 必须固定完整 source key（含 generation）及 initialization digest；明确 recovery input origin。新 child key/session/runtimeTaskId 由本次可信分派产生，不能复制 parent 作为本地已执行身份；旧 CP v1/v2 不改摘要。
- [ ] `run-management.ts` + `run-coordinator.ts`：现有 retry 先持 child writer 再读 source 不满足本合同；改为专用恢复 admission，调用组合 scope 并保留父子 project/权限/预算约束，恢复选点用完整 source + A CP，不把全部事件截到 A CP 而丢 B 后续验收。保持唯一 child 与未知操作阻断。
- [ ] `checkpoint-team.mjs` + `host.mjs`：沿用固定 AgentTeams staged restore，在 approve/成员启动前重建 DAG；B 完成态沿 source 认证结果恢复，A 未完成创建新 attempt。不能直接恢复原 DSH session 历史为可信执行；历史终端/测试批准标为来源上下文，不计作 child 新验证。
- [ ] `checkpoint-context.mjs` + `handoff-checkpoints.ts`：A continuation/context 固定所选 checkpoint/session revision 与完整 generation；B 保留当前已验收证据。retained knowledge/import/contract/capability/backend/resource pins 全部进入程序校验，不由模型判断覆盖。
- [ ] `local-execution.ts` / `task-execution.ts` / `task-canonical.ts`：先 initializer 再 child prepareTask；防止 `initializeTaskCanonical` 从缓存建裸 head。新 scope 的 input origins 能引用真实 parent accepted evidence，无须复制 parent SQL operation。新 device/session/sandbox 身份仍由现有机制产生。
- [ ] `task-accepted-stop.ts` / finalizer / `live-canonical-reader.ts`：分别认证初始化 anchor + child 后续真实 merges，停止边界不借用 parent 的新执行回执。live reader 只在严格恢复 proof 分支读取现 head，不因 marker 格式合法就开放读取。
- [ ] 工程链和实际 JJ 小任务验收、固定 profile 开放条件满足后才交付网页恢复；carrier、隔离导入和自动沙箱回收继续按各自合同处理。

## 本计划的验收边界

计划阶段只核对源码与接口，不新增网络/费用/部署承诺。Task 1–4 完成可说明“私有可信来源 → 完整 child 初始化 → 补证链已通过相应工程验证”；Task 5、profile gate 和实际 JJ 验收未完成，不能说明用户已可在网页恢复。
