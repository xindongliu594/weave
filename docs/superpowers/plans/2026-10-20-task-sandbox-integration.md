# Task Sandbox Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task is a separate review gate; do not start later tasks with an unresolved earlier gate.

**Goal:** 接通 B2：真实员工的文件工具、终端和原生插件在 OpenShell 0.1.2 的 task-attempt 沙箱运行，仅导入授权副本，结果经可信验证和持久 CAS 合并后才能成为正式成果。

**Architecture:** 复用已审过的 `apps/desktop/task-workspace.cjs`、现有 local operation/claim/lease、OpenShell CLI journal、archive/checkpoint 对象和 DSH 工具入口。可信 API 固定任务身份和来源，桌面执行器仅持有任务可见文件；canonical 留在 API 私有 archive，以完整 manifest 的数据库 head 和既有 operation 记录提交结果，`artifacts` 只是兼容读缓存。首版继续串行执行，保留 HandoffGate mutex，不建设第二种沙箱或通用文件系统引擎。

**Tech Stack:** Node.js/TypeScript、PostgreSQL、DSH 0.1.5-rc.1、AgentTeams 0.1.20、固定 OpenShell 0.1.2 CLI、现有 archive/checkpoint 存储。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`；细化依据 `docs/research/enterprise-execution-boundaries-2026-10-20.md`。

## Global Constraints

- 服务部署仍在 JJ；不在 JJ 加载大型语言模型。
- 既有项目目录是可信成果区，不交给员工命令可写挂载。CAS 合并验证基线版本，冲突不会静默覆盖。
- Checkpoint 不回滚已发生的外部效果、账本、审批或审计。结果未知的有副作用操作必须核对，不能自动重放。
- 归档清理只操作本应用可证明拥有的目录；活动运行、未决操作、保留要求及恢复所需版本不可删除。
- 受影响的权限、账本、迁移、恢复变更必须有负面测试和集成验证；固定模型响应只能证明程序路径，不能冒充真实模型验收。
- 每项进度分别标注：未开始、实现中、本地已验证、JJ 已验证、真实业务已验证、受阻；只有所需证据齐全才能完成。
- OpenShell 版本、CLI SHA、镜像 digest、策略及 effective-policy hash、UID/GID 1000、1 CPU、512 MiB 沿用 `OPENSHELL_CONSTANTS`；不升级 DSH，不复制管理凭据给员工。
- `weiwu-task-workspace-v1` 是已实现的纯 planner schema；新增执行 profile 为 `task-attempt-openshell-v1`。两者不能混称，scopeHash 不是授权或 OS 隔离证明。
- 不提高已有金额/次数/未知费用限额。本计划只编写工程及 JJ 验收路径；真实模型验收仅使用仍有效的既有授权，授权不足时记录受阻。
- 本次规划不运行生产命令、不查看凭据、不发付费请求；以下接口除明确标为现有者外均为待实现。

## Review Focus

- 任务切换发生在审批等待或排队期间：旧 attempt/版本批准在派发前拒绝，终端启动计数为零（任务 1、4）。
- 第一条命令提交后第二条仍使用最初 planner 基线：必须滚动可信 scope，不能永久冲突或放松 CAS（任务 1、3、4）。
- 合并中断后下载、恢复或备份读到半套成果：消费者只读 committed manifest；缓存可重建，未知提交不得重跑命令（任务 3、5）。
- 单 run 多沙箱让原维护代码 `.find(runId)` 选错对象：以 task scope 和 sandboxId 选择，未知/未导出对象保留并占容量（任务 2、5）。
- 确定非零退出、导出拒绝、执行未知、合并未知混同：分别记录，不把拒绝的成果写入 canonical，不因无成果提交而自动重放（任务 3、4、5）。

## 已有证据、复用与接线决策

已阅读上列研究与设计，以及实际 helper、`local-execution.ts`、`openshell-executor.cjs`、`local-client.cjs`、`host.mjs`、`handoff.mjs`、两个工具 adapter、checkpoint/recovery、storage lifecycle、run coordinator 和 backup 代码。Task 1 的纯 helper 已过评审；本计划不把它再次算作隔离接通。

| 复用项 | 已核对能力 / 本计划的限制 |
| --- | --- |
| OpenShell 0.1.2 | 继续 `create/get/admit/exec/stop/start/delete` 与既有 journal；独立 sandbox 是边界，改变 cwd 不是。官方固定版来源见研究 §2/§4。 |
| DSH 固定实装 | 复用原 registry、`tools.guard` 与 checkpoint policy；原生插件 bundle/worker 不重写。guard 同步拒绝，异步事务在现有包装层/API。 |
| `task-workspace.cjs` | 现有 `createTaskWorkspace(options)`、`validateTaskExport(workspace, exportedFiles)`、`planTaskMerge(workspace, exportedFiles, currentCanonicalFiles)`；返回完整 `mergedFiles`，CAS 首版要求完整 canonical revision 相同。 |
| local operation + archive | `LocalOperationService.enqueue/wait`、领取 token、started、result/late_result 及桌面持久回执继续使用；只加任务绑定、merge 状态及对象引用。 |
| checkpoint objects / storage | 复用普通文件/SHA/容量/fsync 的存储规则；抽取最小对象读写函数供 checkpoint 和 canonical 共用，不建设插件式存储后端。 |
| DSH taskboard / Git worktree | 已有研究判定不是安全边界，不安装、不引入为替代引擎。 |

实际缺口及确定的解法：

1. `LocalRunExecutor.prepare()` 当前向 run 沙箱发送全部 `exportFiles(root)`。新 profile 的 prepare 只初始化可信 canonical head，不建共享沙箱；第一次获验证的 task 调用才创建该 attempt 沙箱。
2. API 当前只对文件工具核对部分回执，终端的 `artifacts/workspaceRevision` 未在 API 独立验证；新分支必须重新计算并核对全部内容与身份，不能只信设备校验。
3. `mirrorFiles(root, result.files)` 会删掉未返回文件。新 profile 禁止此路径；先取得完整 merge plan，持久提交完整 manifest，再刷新兼容缓存。
4. helper 的初始基线不能复用到第二次提交。保持 attempt 身份和 sandbox generation 不变，每次工具调用前重新生成**操作 scope**：原输入的来源及依赖版本始终固定，不能按当前同名文件重绑定；同一 attempt 已提交输出可成为下一次合法输入，来源为先前 merge receipt。输入同时也是自己获准输出时，允许沿本 attempt 的已提交修改链读取新版本，但必须保留原输入 ancestry。新 scopeHash 随基线变化，并进入批准和回执。若另一 task 改了无关文件，下一操作可建立新基线；已经排队的旧操作仍按旧基线冲突。
5. 不把 helper 的整个 `TaskWorkspace` 下发：`baseCanonicalManifest` 含其他任务私有元数据，留在可信侧。设备只收到授权 `importedFiles/inputManifest`、许可路径、binding、scopeHash、工作版本和执行 profile；不得收到其他 canonical 内容或路径清单。
6. helper 的 Origin schema 暂无 external/imported-file variant。用户固定资料须引用可信 `snapshot.importedFiles` 的 snapshotId/SHA/agentIds，在 scope 记录中保存完整真实来源；在 helper 的现有字段使用实际当前 run、当前 task、当前 attempt、初始化 canonical revision 表示“本 attempt 授权导入”，不得伪造上游 accepted。上游来源严格从 `handoff/accepted` 原记录解析；同名文件不是来源证明。
7. 输入与输出重合的修改必须有输入读取授权；已有目标输出若不属于原输入或本 attempt 的已提交输出，首版拒绝，不因输出声明而隐式授予读取。`inScope/outOfScope` 先由可信合同解析器核对。首版不支持删除、静默忽略未知文件或在导出根放临时文件；临时文件用沙箱 `/tmp`。

## 文件和接口地图

| 文件 | 职责 |
| --- | --- |
| `packages/contracts/task-workspace.ts`（已有）及新增 `task-execution.ts` | 保留纯 planner 类型；定义执行 scope、receipt、committed canonical 引用和 checkpoint v2 类型。 |
| 新 `apps/api/src/task-execution.ts` | 从可信运行快照、host 注册的活动 attempt、原始交接/恢复记录生成 scope；执行模式选择及复核。 |
| `apps/api/src/product-schema.ts`, `local-execution.ts` | 增量 schema、现有 operation 事务、结果验证及 merge 状态；保留历史 operation 状态语义。 |
| 新 `apps/api/src/task-canonical.ts`；新 `services/agent-runtime/archive-objects.mjs` | 私有 SHA 对象和完整 manifest 提交；复用 checkpoint 存储规则、现有 project row fence 和 archive。 |
| `apps/desktop/openshell-executor.cjs`, `local-client.cjs` | 按 scope 定位沙箱、受限传输、生命周期/回执；旧 schema 1 run 映射继续可读。 |
| `services/agent-runtime/host.mjs`, `product-tools.mjs`, `native-plugin-tools.mjs`, `handoff.mjs` 及相应 `.d.mts` | 可信 attempt 注册、审批前固定工作区、派发前复核、guard、观察已提交结果。 |
| `run-coordinator.ts`, `execution-policy.ts`, `execution-backend.ts`, `product-runtime.mjs` | 真实入口 profile 选择、启动门禁、兼容缓存初始化、执行证明验证。 |
| checkpoint/recovery、run/work-files、storage、backup 相关现有文件（各任务列出） | 使用 committed 成果，保留旧记录，按 task scope 恢复及维护。 |

## Task 1: 固定执行模式、可信 attempt 与操作 scope

**Files:** 新 `packages/contracts/task-execution.ts`、`apps/api/src/task-execution.ts`、`tests/task-execution-scope.test.ts`；修改 `packages/contracts/index.ts`、`apps/api/src/product-schema.ts`、`apps/api/src/execution-policy.ts`、`apps/api/src/run-coordinator.ts`、`services/agent-runtime/host.mjs` 和新增 `services/agent-runtime/task-execution-context.test.mjs`。

**Interfaces:**

```ts
type TaskAttemptKey = {runId:string; taskId:string; attemptId:string; generation:number};
type TrustedTaskAssignment = TaskAttemptKey & {agentId:string; sessionId:string; runtimeTaskId:string; contractHash:string};
type TaskExecutionScope = {profile:'task-attempt-openshell-v1'; key:TaskAttemptKey;
  workspace:TaskWorkspace; workRevision:string; capabilityHash:string}; // private; never send whole workspace
type TaskExecutionReceipt = {profile:'task-attempt-openshell-v1'; key:TaskAttemptKey;
  scopeHash:string; operationId:string; beforeWorkRevision:string; afterWorkRevision:string};
// Trusted in-process methods; do not expose a model-callable registration endpoint.
LocalRunExecutor.bindAttempt(assignment:TrustedTaskAssignment, signal:AbortSignal):Promise<void>;
LocalRunExecutor.taskScope(context:{agentId:string;sessionId:string;taskId:string;attemptId:string}, signal:AbortSignal):Promise<TaskExecutionScope>;
resolveTaskScope(db:pg.PoolClient, run:any, assignment:TrustedTaskAssignment,
  canonical:{files:TaskWorkspaceFile[];revision:string}, previous:any|null):TaskExecutionScope;
```

- [ ] 编写失败测试：伪造 employee/assignee/task/attempt/session；过期 lease；任务已 completed/failed；运行中 rework 新合同与旧 hash；跨 run 的 accepted/checkpoint；未接受 producer；import 未授予 employee；只声明输出试图读取已有其他文件；输入 SHA 改变；缺 generation；模型提交 readPaths。全部在 queue 前拒绝，local_operations 为零。
- [ ] 运行 `node --import tsx --test tests/task-execution-scope.test.ts`；确认因接口缺失/未拒绝而失败。
- [ ] schema 增量添加 `task_attempt_workspaces`，主键 `(run_id,task_id,attempt_id,generation)`，保存 principal/session/runtimeTaskId、固定合同/权限/能力摘要、原始 input origins、sandbox identity、最近 work revision/scope、phase；唯一活动 generation，保留 retired/unknown 行。仅 host 在 `activeWork()` 已核对 native team state 后，经 `bindAttempt` 注册；API 在现有 project→run→operation 锁顺序内核对注册、lease owner 和 run snapshot。动态 rework 必须由现有可信 rework 记录推导有效合同，不信模型参数或仅以 `run.snapshot.tasks` 的旧任务代替。generation 由服务端分配，不用 taskId 伪造 runId。
- [ ] 新增显式 `WEIWU_EXECUTION_MODE=legacy|enterprise` 配置校验（未配置保留 legacy），批准 snapshot 固定 executionProfile；enterprise 所有新执行/恢复要求 local OpenShell + 完整合同，缺配置/容量/profile 拒绝，禁止 `RunSandbox`/native/demo fallback。`oidc` 身份模式不隐式改变执行模式；部署启用 enterprise 必须明示设置。旧无 profile snapshot 仅 legacy 可运行，不自动加标签。
- [ ] 实现 scope 解析；复用 `checkpointContract`，permission/capability 摘要包含 employee tools、有效授权版本、固定 native bundle/definition；origin 追到不可变 accepted/初始化/恢复证据。保存 scope JSON 与其 digest，但调用权限始终单独校验。
- [ ] 运行上述单测、`node --test services/agent-runtime/task-execution-context.test.mjs` 与 `npm run build`，通过后提交 `feat: bind task execution scopes to trusted assignments` 并独立评审。

## Task 2: OpenShell task-attempt 生命周期与有界导入/导出

**Files:** 修改 `apps/desktop/openshell-executor.cjs`, `apps/desktop/local-client.cjs`；新增 `apps/desktop/task-execution.test.cjs`；扩展 `apps/desktop/openshell-executor.test.cjs`, `local-client.test.cjs`；新增 `scripts/validation/task-sandbox-transport.cjs`。

**Interfaces:** 消费 Task 1 key/receipt。新增设备 job `executionScope` 只含 `{profile,key,binding,scopeHash,readPaths,writePaths,inputManifest,expectedWorkRevision}`，prepare 的 `files` 仅授权输入。现有 `execute(job,signal)` 返回 `{...现有result,taskExecution:TaskExecutionReceipt}`。新增 `inspectTaskExport(key:TaskAttemptKey, operationId:string):Promise<any>` 只查询原工作区和原操作引用；不能执行原命令。原 `read/stateFile/inspectStorage/retireStorage/reconcileStorage` 接受 `string | TaskAttemptKey`，string 仅旧 run 映射。

- [ ] 失败测试：同一 run 的 A/B/new-attempt/new-generation 对应不同 sandboxId；同 key 重开仍同对象；篡改 scope/profile/binding/expected revision 拒绝；旧 run state schema 1 仍可读；task key 不能落入 legacy stateFile；prepare 非空/重复、已完成 operation、未知 create/start/stop/delete 均不重放。
- [ ] 运行 `node --test apps/desktop/task-execution.test.cjs apps/desktop/openshell-executor.test.cjs apps/desktop/local-client.test.cjs`，确认红灯。
- [ ] 继续使用当前 `perform/admit/get/cli/REMOTE_SCRIPT`，新映射 schema 2 放 `openshell-task-scopes/<sha256(JSON.stringify([runId,taskId,attemptId,generation]))>.json`；文件内容保存完整 key 并复核，不能仅信文件名。persist intent 后单次 lifecycle dispatch，pre/post admission、nonce、UID/resource/policy 验证保留。维护列表同时枚举旧/新目录，返回完整 key；未知条目不跳过容量计算。
- [ ] 统一新 profile 的 stdin 预检：`MAX_TASK_EXEC_STDIN_BYTES=3*1024*1024`，按最终 UTF-8 JSON（含 nonce、base64、bundle、参数）计数，须在 create/exec 变更派发前完成可完成的预检；remote parser 用相同上限，超过即拒绝。首版采用受限单 envelope，不实现分块。文件数量/单文件/总量仍受原 128 / 5 MiB / 20 MiB 限制，但能传输的输入还受 3 MiB envelope 限制；5 MiB bundle/输入不得宣称可用。导出 stdout 使用现有最大 32 MiB 并验证完整 envelope，溢出是 unknown、保留现场；不能拿 stdin 4 MiB 推断 stdout 上限。
- [ ] `REMOTE_SCRIPT` 新 readonly `task_export_inspect` 分支导出原 scope 与原 operation 的现有文件；所有导出执行 lstat、普通文件/nlink=1、路径/大小写/前缀/SHA/数量/总量检查。不能以 shell stdout 中的 JSON 冒充 receipt；子进程收尾后确认进程组终止，后台写仍存在则阻止导出提交。设备 journal 保存 key、scopeHash、工作版本和 operationId，重启仅递交旧 receipt，不新建 generation 来清除 unknown。
- [ ] 添加容量准入，复用现有 storage headroom 和串行 queue：每设备同时至多一个 active exec、最多两个占用运行资源的 task sandboxes（creating/importing/ready/starting/stopping/unknown 都预留 slot），最多 128 个未 retired task scopes（包含 stopped/unknown）；所有工作/tmp 占用均计磁盘准入。已 accepted 且 checkpoint/操作全已决的 task 可以按既有确认 stop 流程停下并释放运行 slot，保留对象供审计；未 accepted 的其他 task 若占满则排队/明确阻断。stopped 的 start 必须重新预留 slot 并准入。上限不足拒绝创建；不自动删除旧/未知对象。更高限额须后续 JJ 容量证据，不在本轮默认提高。
- [ ] transport 验证脚本仅在显式临时验证目录和给定固定配置下运行：验证完整 3 MiB envelope 的 SHA 往返，以及 3 MiB+1 在调用 adapter transport 前被拒绝；记录固定 CLI SHA、实际序列化字节和 observed hashes，不输出配置秘密。未在真实 JJ 验证前只称 mock protocol 通过。
- [ ] 运行上述测试和 `node --test tests/local-base64-limits.test.cjs`；通过后提交 `feat: isolate OpenShell task attempt lifecycles` 并评审。

## Task 3: API 独立结果验证与持久完整合并

**Files:** 新 `apps/api/src/task-canonical.ts`、`services/agent-runtime/archive-objects.mjs` 及 `.d.mts`、`tests/task-canonical.test.ts`、`tests/task-operation-result.test.ts`；修改 `apps/api/src/local-execution.ts`、`product-schema.ts`、`services/agent-runtime/step-checkpoints.mjs`。

**Interfaces:**

```ts
type CanonicalRef = {revision:string; manifest:TaskWorkspaceManifestEntry[]; mergeId:string|null};
type TaskMergeReceipt = {mergeId:string;operationId:string;key:TaskAttemptKey;scopeHash:string;
  beforeRevision:string;afterRevision:string;workRevision:string;status:'committed'|'rejected'};
readCommittedCanonical(traceRoot:string, run:any):{ref:CanonicalRef;files:TaskWorkspaceFile[]};
commitTaskResult(service:LocalOperationService, operationId:string, signal:AbortSignal):Promise<TaskMergeReceipt>;
reconcileTaskMerge(service:LocalOperationService, operationId:string):Promise<TaskMergeReceipt>;
materializeCommittedCanonical(traceRoot:string, run:any):void;
```

- [ ] 失败测试真实临时文件 + isolated DB：伪造 artifacts/workspaceRevision/receipt scope/operationId、read 文件被改/删、未声明输出、链接和导出根未知文件、部分合法加一个非法文件均零发布；CAS 冲突保留 B；task 结果缺 B 文件仍完整保留 B；重复同一 claim/receipt 返回原 merge，不重跑；不同重复 receipt 拒绝；非零 exitCode 可记录确定执行但不自动等于验收通过。
- [ ] 运行 `node scripts/test-integration.mjs tests/task-operation-result.test.ts tests/task-canonical.test.ts`；确认红灯，测试必须核对无 usage/model_reservations 新行。
- [ ] 增量添加 `project_runs.canonical_workspace jsonb`（完整 head/manifest/revision）、`local_operations.merge_state text` 与 `merge_record jsonb`。无需第二套 operation 表/队列；mergeId 固定为该原 operationId，状态 `pending|committed|rejected|unknown`，`result.status=completed` 仍只代表设备操作结果已持久接收。首次新 profile prepare 把可信 `artifacts` 全量验证、保存到既有 `checkpoint-objects/<sha>` 后初始化 head；禁止把这些全量文件传设备。
- [ ] 抽取 checkpoint 的最小 SHA 对象写/读校验，保留原 hash/普通文件/容量约束，并加对象目录 fsync。对象不可变；碰到已有 hash 但内容不符拒绝。所有 blob 在完整验证后、head commit 前持久化；孤立对象只计容量，不代表已发布。
- [ ] `/result` 验证设备 key、claim、started、run/lease/grant 和 backend，再对新 profile 核对原 payload 的 scope/key/operation、`revision(files)`、`manifest(files)`、before/after work revisions，以及实际工具业务结果。所有 checks 只针对可信 queued scope，不接收设备自报扩大权限。迟到/撤权 receipt 可保存原操作证据，不能合并/重新授权；结果验真和当前执行授权分开处理。
- [ ] `commitTaskResult` 使用既有 project→run→operation row locks 重新核对 active assignment、授权、lease fencing、原 scope、unknown 门禁；调用实际 `validateTaskExport/planTaskMerge`。先持久 `merge_state=pending` intent（before/after 完整 manifest、blob refs、scope/receipt 摘要），保存/核对对象；再单事务 CAS `canonical_workspace` + `merge_state=committed` + merge receipt。SQL head 是唯一发布点。事务外 archive 追加 `task/merge-committed`（sourceKey=`task-merge:<operationId>`）；丢应答/append 失败按原 operation 查 SQL 和对象补证，不重跑 command。任一前置版本不符为 rejected/conflict，保留导出副本及原成果。
- [ ] 故障注入分别落在 intent、任一 blob fsync、SQL commit 前/后、archive append、缓存 mirror 中途；DB 指针提交前只读旧完整集合，提交后只读新完整集合。提交未知按 operationId 只查结果；不以文件 rename 或 `mirrorFiles` 原子性证明事务。头已提交但缓存损坏时从该 head 重建后才能恢复 runtime/Handoff；重建失败阻止启动。对象缺失、坏 hash、head/receipt 不一致时冻结该 run 成果提交及恢复，原文件保留。
- [ ] `LocalRunExecutor` 新 profile 的 execute 先 wait 设备结果，再 commit，最后用 `mergedFiles` 的完整集刷新兼容缓存并返回公开摘要。`visible.artifacts` 只含任务授权文件及提交路径，不能把完整 canonical 文件名泄给员工；可信 Handoff 从缓存及 merge receipt 观察完整变化。next scope 从 committed own outputs 生成，原输入仍固定。不能把 task scope 原样传 `mirrorFiles`。
- [ ] 上述测试、`node --test services/agent-runtime/step-checkpoints.test.mjs`、`npm run build` 通过后提交 `feat: persist validated task merges with canonical CAS` 并评审。

## Task 4: 把真实员工工具、审批与 Handoff 接到新链路

**Files:** 修改 `services/agent-runtime/host.mjs`、`product-tools.mjs`、`native-plugin-tools.mjs`、`handoff.mjs`、`handoff.d.mts`、`product-runtime.mjs`、`apps/api/src/local-execution.ts`、`run-coordinator.ts`、`execution-backend.ts`；新增 `services/agent-runtime/task-sandbox-flow.test.mjs`、`tests/task-sandbox-flow.test.ts`；扩展原 `product-tools.test.mjs` / native tool tests。

**Interfaces:** 消费 Task 1 的 `bindAttempt/taskScope` 和 Task 3 receipt；新增 `LocalRunExecutor.prepareTask(context:any,signal:AbortSignal):Promise<TaskExecutionScope>`（可信 scope 后只发送授权输入、等待 scope-bound prepare receipt）。`revision(context?)` 旧模式仍返回 canonical；新模式调用方必须使用 `scope.workRevision`。`assertExecutionBackendReceipt(backend,result,expectedTaskExecution?)` 增加新 profile 验证，旧调用保持兼容。

`prepareTask` 只在该 key 尚无沙箱时导入一次。后续调用复核该沙箱当前工作版本与可信上次 receipt，滚动操作 scope 而不再次 prepare/复制整个 canonical；工作版本或原输入 ancestry 不符即阻断。为未知操作另建 generation 不能绕过未决门禁。

- [ ] 红灯场景必须经 `ProductDshRuntime → host/activeWork → product/native adapter → LocalOperationService → poll/start/result → LocalRunExecutor → Handoff`，禁止只 mock 直接 planner：A 创建两个输出、再改一个输出、terminal_test、accepted，B 只导入 A 已 accepted 的一个输出并产出 B 文件；断言每次 canonical 完整、own-output origins 可追、两个 sandboxId 不同、员工结果不暴露其他路径。
- [ ] 同链路负面测试：approved 后 attempt/session/合同/scope/work revision 改变；approval 等待时 B 合并；terminal/文件/native 任一 context 缺 attempt；插件试图扩大 readPaths；新工具晚注册/scope shadow/嵌套调用/无 employee 后台调用。均在工具体或 exec transport 前拒绝，host shell/native/shared-run fallback 计数零。
- [ ] `tests/task-sandbox-flow.test.ts` 固定具名断言：`two consecutive task writes roll scope and preserve original input lineage`（两次成功、同 sandboxId、不同 scopeHash、原 dependency acceptedRevision 相同、第二次 beforeRevision 等于第一次 afterRevision）；`unrelated task commit rebuilds next scope without rebinding inputs`（B 更新无关路径后 A 新 scope 可成功并保留 B；B 改了 A 固定输入则拒绝）；`approval cannot authorize a renewed scope`（旧批准绑定原 scope，换新 revision 后实际 exec 计数零，重新批准才可执行）。JJ runner 原样复现三例并记录实际 operation/scope/approval IDs；不能仅用 planner 单测代替。
- [ ] 运行 `node --test services/agent-runtime/task-sandbox-flow.test.mjs` 和 `node scripts/test-integration.mjs tests/task-sandbox-flow.test.ts` 确认红灯。
- [ ] 工具 wrapper 顺序固定为：`activeWork` 与 principal → bindAttempt/prepareTask → 固定 scope/work revision → 终端逐次申请批准 → 排队 → 在 mutex 内再次 activeWork/权限/scope 检查 → checkpoint barrier → enqueue → verified result/committed merge → Handoff.observe → checkpoint。审批参数增加 `executionScope:{profile,key,scopeHash,workRevision}`，保留 `expectedWorkspaceRevision=workRevision` 和现有 SQL arguments 完全匹配；任何变化均拒绝旧批准，不能悄悄替换参数继续。
- [ ] `enqueueAttempt` 对全部四类文件/终端工具和 `native_plugin` 强制可信注册及准确 assignee/attempt；prepare 只允许可信 task initialization，企业模式拒绝原 run-wide prepare。native 调用仍使用 `nativeToolBinding/nativeFileAccess`，新 scope 同时限制工具声明和合同，bundle digest进入能力摘要；不修改插件业务实现。
- [ ] 在固定 DSH `ctx.tools.guard` 注册一个单调拒绝检查：协调工具保留既有精确名单；产品工具/获授权 native definition 才可进入对应 wrapper；未知、动态改定义、没有主体、scope 不符拒绝。employee host 与 coordinator 都覆盖；scope-local shadow 不因名称相同放行，校验实际 definition/binding。此 gate 不是 C1 外部副作用合同的替代；未有受控执行 wrapper 的新增变更能力在 enterprise 暂不开放。
- [ ] Handoff 保留完整 canonical 可信镜像、输入固定、accepted 和 mutex。新分支 `observe` 要求 scope-bound committed merge 或纯读取已验证 receipt，原始设备成功不能成为写入证据；记录 command 的 workRevision/scopeHash/mergeId 与对应 canonical revision，`prepare` 核对最后工作版本/outputs，不把另一员工无关 canonical 更新当当前测试有效。执行成功、导出验证、merge committed、task accepted 分四类事件；任何失败使本 attempt 旧命令证据失效。只已 accepted 的 producer 产物可被其他任务导入。
- [ ] `run-coordinator` 和 `ProductDshRuntime` 在构造 supervisor/读取 `sandbox.root` 前初始化/恢复 committed cache；enterprise 缺 target/profile 不得走 `createExecutor?.(...) ?? new RunSandbox`。`LocalRunExecutor.prepare` 的旧分支完全保留；新 profile 不能创建 run 共享沙箱。不要让运行收尾误回收未决 task sandbox。
- [ ] 运行两层 flow 测试、已有 `npm run test:handoff`、`node scripts/test-integration.mjs tests/openshell-api-admission.test.ts tests/local-operation-heartbeat.test.ts` 和 `npm run build`。通过后提交 `feat: route employee task tools through isolated execution` 并评审。此时只能称“本地接线已验证”。

## Task 5: Checkpoint v2、canonical 消费者与维护/备份兼容

**Files:** 修改 `services/agent-runtime/step-checkpoints.mjs`/`.d.mts`、`recovery.mjs`、`handoff.mjs`、`apps/api/src/step-checkpoint-recovery.ts`、`recovery-conditions.ts`、`run-management.ts`、`run-coordinator.ts`、`work-files.ts`、`work-records.ts`、`planning-execution-context.ts`、`app.ts`、`storage-lifecycle.ts`、`storage-governance.ts`、`backup.ts`、`backup-checkpoints.ts`；新增 `tests/task-checkpoint-recovery.test.ts`、`tests/task-storage-lifecycle.test.ts`、`tests/task-canonical-readers.test.ts`，扩展 `tests/backup-checkpoints.test.ts`。

**Interfaces:** checkpoint `version:2` 保留原 `{id,runId,boundary,files,receipts,sha256}`，增加 `{profile,key,inputManifest,workManifest,canonical:CanonicalRef,lastMerge:TaskMergeReceipt|null,scopeHash,capabilityHash,recoverySource?}`；`files` 为该 task 工作副本的对象清单，不能误用作整 run canonical。`recoverySource={sourceRunId,sourceTaskId,sourceAttemptId,checkpointId,checkpointSha256}`。既有 v1 读取/备份验证继续。维护方法消费 Task 2 的 `string | TaskAttemptKey`，HTTP 新 profile 请求必须有完整 key 和 expected sandboxId/workRevision。

- [ ] 红灯：A checkpoint 后 B 已提交，恢复 A 不回退 B；新 run/attempt/sandbox，不覆写原记录；原命令 unknown、合并 unknown、缺对象、permission/bundle/输入/镜像/policy/profile 改变均阻断。旧 v1 可浏览/导出备份，legacy 恢复不变；enterprise 升级恢复只筛选批准文件，旧 terminal_test 不继承新 profile 通过证据。
- [ ] 红灯：partly materialized cache 时 artifact listing/download、work-file source selection、planning context、recovery 判断和备份均得到同一 committed head 文件集或明确受阻；不能半读旧新。runId 下两个 scopes，维护 A 不删 B；未知/活动/无检查点/缺 merge receipt 不可删，delete 应答丢失仅查原 sandboxId；总容量含 stopped/unknown。
- [ ] 运行 `node scripts/test-integration.mjs tests/task-checkpoint-recovery.test.ts tests/task-storage-lifecycle.test.ts tests/task-canonical-readers.test.ts tests/backup-checkpoints.test.ts` 确认红灯。
- [ ] checkpoint v2 在 before-tool、tool-result、node-accepted 及 DSH flush 边界写入独立 input/work/canonical refs；异步导出先在 wrapper 完成并缓存为可信对象引用，`HandoffGate.checkpoint()` 只提交已验引用，不能在同步方法里假装异步拉取沙箱。pre-tool 取 scope 已知 work revision，post-tool 取验证导出；读取/持久 flush 失败不派发下一步。
- [ ] `checkpointContract/checkpointEnvironment` v2 纳入 profile/key、input/origin hash、能力和权限版本、完整 backend/admission 摘要；v1 算法保留。`selectStepCheckpoint/restoreStepWorkspace` 新分支以 committed canonical head 为新 run 成果基线，仅把选中 A 的 work files 交给新 A scope，合并仍 CAS。源未决 operation/merge 未核对前禁止恢复；不要简单用截断 checkpoint.seq 事件抹掉之后 B 的成果、费用或未知记录。
- [ ] `unresolvedOperations` 增加 scope-bound operation/merge 的未决索引（保留现有调用方与旧分类）：原 runtime finished 不清除 pending/unknown merge；只有对应持久 committed/rejected/reconciled receipt 关闭该局部状态。`inspectTaskExport` 只能证明当前文件，不能伪造原命令退出码/外部结果；无完整原命令证据继续 unknown，不能新沙箱重跑猜结果。新任意工具不靠名字自动加入 READ_ONLY_TOOLS。
- [ ] 新 profile 的 canonical 消费者统一走 `readCommittedCanonical`；文件下载用已核验 immutable SHA 对象路径（文件名/响应头仍显示交付路径），列表、Office 读取、父 run 导入、handoff/recovery、规划上下文和 work records 均由同一 head 读取；旧 profile 保持 artifacts 读取。运行中 runtime cache 只由已提交 head 更新，启动先重建；外部 HTTP 不直接读可能重建中的 cache。
- [ ] storage 旧 run 单对象行为不变，新 profile 按 key/sandboxId 列出和预览，不能再 `.find(s=>s.runId===runId)`；删除验证 task work revision、已存导出/检查点、merge receipt 和完成状态，不要求 task work revision 等于全 run canonical。容量/回收凭证和 UI 列表包含 key，确认原对象消失才释放 slot。未知、非完成、未决费用及活动祖先保留。
- [ ] backup 数据表列表纳入 task scopes（现有备份没有包含 local_devices/local_operations，因此不能假设 operation 随 DB 快照已保存）；新 profile 导出包含用于审计核对的 operation/merge 原始记录及 canonical heads、checkpoint objects，按既有 backup schema 增量版本化并验证引用。导入不得让历史 started operation 重新入队或激活设备凭据；记录恢复为只读审计/需核对状态。旧 backup format 读取继续；缺 canonical/merge/blob refs 的新备份拒绝认证通过。对象计入既有 archive 限额与保留规则。
- [ ] 上述测试及 `node scripts/test-integration.mjs tests/checkpoint-branch.test.ts tests/backup-checkpoints.test.ts`、现有 storage/backup 单测、`npm run build` 通过后提交 `feat: recover and maintain task sandbox evidence safely` 并评审。

## Task 6: JJ 真实 OpenShell + 实际产品链路验收及发布门禁

**Files:** 新 `scripts/validation/task-sandbox-integration.ts`、`scripts/validation/task-sandbox-integration.test.ts`、`docs/validation/task-sandbox-integration-2026-10-20.md`；更新 `scripts/deployment/openshell-v012/README.md`。消费 Task 1–5 真实接口；不绕过 API/审批/租约直接以 executor 成功冒充产品验收。

- [ ] 先给验证 runner 加失败测试：非临时/非本应用所属目录、生产 DB、缺 scope、未知上次执行、配置 fingerprint 不符拒绝；重启验证 runner 只续查原 operation。提供 `--check`（只检查路径/版本）、`--run`（显式临时工程项目）、`--reconcile <evidence-dir>` 三个互斥模式；输出逐项证据与失败 exit code，隐藏管理配置/凭据。
- [ ] 本地 gate：`npm run build`；Task 1–5 指定的单元/协议/PGlite 集成全部通过。真实 PostgreSQL 的独立事务竞争另开临时 DB 验证两 worker 过期 lease、CAS 同目标、同一 operation 两次提交；PGlite 报告明确不提供此锁证据。检查新旧 snapshot/profile、checkpoint 和备份夹具皆通过，不重复付费测试。
- [ ] JJ 先 `--check`，按已有部署说明只检查固定 CLI/image/policy/admission，复用当前 gateway/配置；不升级重装。记录版本、image/policy hashes、uid/resources、磁盘和已有 scopes 总量。3 MiB stdin 边界脚本通过才继续；未通过降低首版限额、更新相同测试和说明并评审，绝不临时提高到 29 MiB。
- [ ] 在新私有验证目录、独立临时真实 PostgreSQL 数据库和隔离 API/worker 运行产品链路；用工程 fixture provider 触发真实 `ProductDshRuntime`/employee host/工具 API 和真实 OpenShell，审批走真实 approved 记录。A、B 及 A 新 attempt 至少两个不同 sandboxId；A 输入复制只能来自被接受/授权版本。验证 A 的绝对 canonical 路径、B 的 `openshell://`/沙箱目录、host journal、OpenShell HOME、管理证书、socket、网络端点均不可达；不读取真实秘密，用受控 canary。测试相对/绝对越界、symlink/hardlink、后台写、修改输入非输出、创建未知输出，提交前后原 canonical/B canary SHA 不变。
- [ ] 正常链必须包含 A 多次 artifact/terminal 写与 terminal_test、A accepted、B 获授权输入后 native plugin 或 terminal 产出、完整文件下载。使用已安装且固定版本的原生文件插件验证共用 task scope，若首版 3 MiB envelope 容不下则明确阻断并保留该能力未验证，不能转 host/native 执行。验证真实产品调用路径，直接 executor probe 仅作 OS 边界辅助。
- [ ] 故障链至少包含：command 已发出/receipt 丢失、SQL commit 应答丢失、worker 在缓存同步中退出、桌面重启、令牌/权限/lease 撤回、A checkpoint 后 B 提交、导出/对象持久化磁盘不足、stop/delete 不确定、无容量和 OpenShell 不可用。每次记录原 operationId/key/sandboxId、command 启动计数、scope/work/canonical revisions、merge state/receipt 与 expected outcome；未知操作启动计数不增加，企业 fallback 计数为零。
- [ ] 调试完必须按 key 核对验证 scopes：仅已决且导出持久者按既有确认流程回收，并确认原 sandboxId absent；未知保留完整证据/容量占用。不得清理生产/他人 sandbox。冷重启后验证新 profile committed 下载与恢复，旧本机/native/demo/旧 run OpenShell profile 的原样夹具和选择路径仍可用。
- [ ] 将工程 fixture、真实 OpenShell OS、真实 PostgreSQL、完整产品链路、真实模型业务分列。真实模型验收只在已有授权额度内做一个小任务，沿用网页现有 API/预算/收据；无有效额度则列“真实业务已验证：受阻”，不抬额、不本机推理、不把 fixture 叫真实员工业务。部署只启用已达门禁的 profile。
- [ ] 发布前保留备份和旧 release；enterprise 配置先在隔离环境启用并实测启动 failclosed。升级为增量 schema，回滚代码先停 admission/排空；新 profile 运行冻结由支持版本核对，不将其交旧共享执行器。legacy 工作台的默认模式不变，已有资料/费用/未知记录保留。写入运行 ID、证据目录、测试摘要、限制和回滚步骤；提交 `test: verify task sandbox integration on JJ`，评审通过后才标记 B2 的相应验证层完成。

## 完成定义和本计划状态

依赖顺序为 1 → 2 → 3 → 4 → 5 → 6；每项可被独立评审否决，后项不能拿 mock 证据跳过前项。任务 2 的 OS adapter 与任务 3 的提交协议分别有测试边界，但完整交付必须到任务 6。

本计划完成自检：scope 身份/实际工具入口/初始全量泄漏/第二次 merge/CAS 完整候选/持久提交/迟到回执/传输限制/未知不重放/检查点/普通消费者/备份/清理/旧 profile/企业 failclosed/真实 JJ 验证均有归属。没有重新建设执行引擎、异步调度器或通用文件系统；C1 外部核对补偿、其他企业基础模块仍由总计划推进。

当前仅**计划已形成**；Task 1 纯 helper 的已通过评审状态不变。本文件没有声称 B2 已实现、本地接线已通过、JJ 已验证或真实业务已验证。
