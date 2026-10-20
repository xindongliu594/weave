# C1 工具副作用与结果核对接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本次任务只产出计划，不执行实现、不提交代码；后续按已授权执行方式推进。

**Goal:** 让员工实际调用的每种工具都绑定可信版本化效果契约，并在现有 operation 路径中记录意图、分派和可核对结果，使未知操作不能靠重启、换 attempt、恢复或勾选确认被重放。

**Architecture:** 继续使用固定 DSH registry、guard 和 tools/execute；在统一发现入口增加审核过的契约引用，不新增插件加载器。扩展已有 local_operations 为统一的操作记录，保留表名及本地设备协议；同一个本地调用从 runtime 到设备、B2 merge 使用同一 operationId。归档事件是可补投的审计投影，SQL 操作记录是核对状态的权威来源，B2 canonical head 仍是成果发布唯一权威。

**Tech Stack:** Node.js、TypeScript/ESM/CJS、Express、PostgreSQL、React、固定 DSH 0.1.5-rc.1 / AgentTeams 0.1.20；沿用 OpenShell 0.1.2，无新运行引擎和生产依赖。

**Spec:** `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`；`docs/research/enterprise-execution-boundaries-2026-10-20.md` §7。执行前同时读取 `docs/superpowers/plans/2026-10-20-task-sandbox-integration.md`（下称 B2）。

## Global Constraints

- 服务部署仍在 JJ；不在 JJ 加载大型语言模型。
- 权限收回即时影响新的读取、工具调用和恢复；历史授权快照仅用于审计，不能恢复已吊销权限。
- Checkpoint 不回滚已发生的外部效果、账本、审批或审计。结果未知的有副作用操作必须核对，不能自动重放。
- 既有项目目录是可信成果区，不交给员工命令可写挂载。CAS 合并验证基线版本，冲突不会静默覆盖。
- 工具发现不授予权限，插件声明和 MCP annotations 不授予可信只读/幂等属性；新增或改定义工具默认 unknown、不可准入、不可自动重放。
- 只读可能计费；沿用金额、次数和未知费用门禁，不把效果核对当作费用核销。首版没有经验证收费适配器的工具拒绝自动调用。
- 保留旧记录、旧版本和未决证据；不重建插件业务系统，不将公司能力上传公共市场。
- 受影响的权限、账本、迁移、恢复变更必须有负面测试和集成验证；固定模型响应只能证明程序路径，不能冒充真实模型验收。
- 每项进度分别标注：未开始、实现中、本地已验证、JJ 已验证、真实业务已验证、受阻；只有所需证据齐全才能完成。

## Review Focus

- 名称相同但 definition、MCP schema、连接/账户版本或 bundle 改变：不能继承原可信分类（任务 1、3）。
- 父调用成功而嵌套写入未知，或两个并发父调用交错：逐子操作保留身份，父成功不清子未知（任务 2、3、5）。
- `/start` 应答丢失、设备重启、SQL commit 应答丢失：执行次数不能增加，不能误用 notExecuted（任务 2、4）。
- 撤权后迟到回执、重复一致/冲突回执：收证据与执行许可分离，冲突不可覆盖已知结果（任务 4、5）。
- 核对或补偿本身失败/收费/未知：不能用原批准、重复 key 或文件回退解除原操作门禁（任务 5、6）。

## 固定源码补充调研与复用结论

调查日期 2026-10-20，读取当前工作区；不把工作区其他人的未提交改动当稳定发布版。以下均为实读源码的事实，后文 `新增` 接口为实现提议。

| 已有位置 / 接口 | 核对结果与本计划接法 |
| --- | --- |
| `services/agent-runtime/package.json`、`node_modules/@deepseek-ai/dsh-tools/lib/index.js` | 固定 0.1.5-rc.1；`guard()` 是同步单调拒绝，位于可扩展 pre-execute 之后；`tools/execute` 包裹实际 body。execution 具有 `token/callId/rootCallId/parent/agent/arguments/signal`。`parent` 是 token，不是可持久字符串；需在可信 wrapper 内映射 operationId。没有假定原生数据库 intent 或通用外部查询 API。 |
| `employee-tool-access.mjs:installEmployeeToolAccess` | 已固定允许集合、实际 definition 对象引用和员工 agent identity，后注册、scope shadow 可拒绝。继续复用；追加契约检查不能移除这层身份校验，也不能靠名称前缀放行。 |
| `employee-capabilities.mjs:installEmployeeCapabilities` | 当前统一入口为 `capability_search`：聚合获授权知识、`ctx.skills.list()` 与 `ctx.tools.schemas(agent)`，并非已有一张统一 catalog SQL 表。保留各加载路径，只为可执行条目关联契约。Skill 本身不变为可执行插件；其调用的工具分别受门禁。 |
| `apps/api/src/native-capabilities.ts`、`services/agent-runtime/native-capabilities.mjs` | 已有 namespace enable 状态、内容寻址 manifest/bundle、`snapshotNativeCapabilities/assertNativeCapabilities/nativeToolBinding/nativeFileAccess`；旧固定版本可保留，停用 namespace 撤权。契约审核引用该 manifestId，不能仅凭 `files.read/write` 判定无网络/无其他效果。 |
| `apps/api/src/work-tools-browser.ts:executeBrowserMcpTool` | MCP 原路径是自有 `HttpMcpClient` 的 initialize/listTools/tools/call；核对连接版本、员工和工具名单后仍依赖 `readOnlyHint===true`。需保持协议/凭据路径并增加可信审核、定义摘要及 operation，不改造成第二个 MCP runtime。 |
| `product-tools.mjs` / `native-plugin-tools.mjs` | 内建、外部和 native 分支各自记录 start/finished，只有部分调用经 `retryRead`；`isError` 和运行结束不等于无效果。native 实际 body 仍走 sandbox.execute('native_plugin')，不是 Host 直接加载任意代码。 |
| `apps/api/src/local-execution.ts` | `LocalOperationService.enqueue/wait`、`LocalRunExecutor.execute`、`operationTransaction`、设备 poll/start/result 已存在。锁序 project→run→operation→device；唯一 approval_id 防止一个逐次批准派发多个本地命令。回执/迟到回执已有相同则接受、不同则 409。 |
| `apps/desktop/local-client.cjs:record/run/deliver/start` | journal 原子临时文件 rename，阶段 claimed/starting/executing/completed/acknowledged；重连仅重发已有回执。**当前没有 fsync，acknowledged 记录不保留完整 receipt**，不能把已有原子替换宣称为断电持久屏障。 |
| `recovery.mjs`、`apps/api/src/step-checkpoint-recovery.ts` | `READ_ONLY_TOOLS` 是静态集合，`classifyFailure/retryRead/unresolvedOperations` 依赖名称；还排除 `agent_teams_` 前缀。需要固定版本契约/逐操作投影，未知不按名字推定安全。 |
| `apps/api/src/run-management.ts` | 当前 `acknowledgeUnknownOperations` 布尔确认可继续 retry，并把 unknown 列表写入新 snapshot.approval.reconciledOperations；它不是逐操作结果证明，C1 启用运行不得沿用此绕过。 |
| `apps/web/src/RunExtras.tsx`、`NativeCapabilities.tsx`、`BrowserMcpCenter.tsx` | 已有操作回执、迟到提示、插件启用和 MCP 配置入口；在这些页面接核对/契约，不另造控制台。 |

外部依据只补充核对 [MCP 2025-06-18 官方 ToolAnnotations schema](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)：annotations 是提示，未知服务的声明不可靠，不能据此授权。该协议没有保证所有工具支持业务幂等键或结果查询。DSH/插件复用采用上述固定安装源码及已有研究中的官方来源，无需升级或寻找另一套 operation 引擎。

## 与 B2 的唯一接口及共享文件安排

1. B2 拥有 `TaskAttemptKey`、`TaskExecutionScope`、`TaskExecutionReceipt`、`TaskMergeReceipt`，`bindAttempt/taskScope/prepareTask`、`commitTaskResult/readCommittedCanonical` 及 `canonical_workspace/merge_state/merge_record`。本计划消费这些接口，不复制 scope 算法、不增加另一 merge 表或 revision。
2. C1 operationId 在工具 admission 时生成；`LocalOperationService.enqueue(...,context,...)` 消费可信 `context.operationId`，在**同一** local_operations 行填充设备 payload 并变为 queued，不能再 randomUUID 建第二行。设备 job.id、回执 operationId 和 B2 mergeId 均为此 ID。`prepareTask` 初始化先于最终工具 intent，记为独立 system 前置操作，以同 rootCallId 关联、parentOperationId=null；不能引用尚不存在的父行。初始化完成不代表该工具已分派。真正嵌套工具则在父 intent 已持久化后各建子操作。
3. effect state 与 B2 merge state 是同一行两个正交维度：命令已执行可 confirmed，成果仍 pending/rejected；未提交成果不能推断命令未执行。C1 不自行写 canonical head；只有 B2 commit 的 receipt 能证明成果发布。
4. B2 scope 固定之后才生成终端批准参数及 C1 intent 摘要；prepare 早于该步骤，初始化操作绑定 assignment/初始 scope。一次调用中的新 scope、参数、权限或 work revision 变化一律使原 intent/批准失效。下一次调用生成新的 operation，不能借新 generation 越过未决旧操作。
5. 本计划只创建当前文档。后续 Task 1 可先实现独立契约模块；Task 2 开始前必须确认 B2 对 `product-schema.ts/local-execution.ts` 的接口已稳定。Task 3、4、5 修改 shared files 时串行交接，文件包括 host/product/native wrappers、recovery、checkpoint、backup 和 storage；禁止两个执行者同时改这些文件。B2 同名接口落地若变动，先更新本计划接口引用再接线。
6. 真人权限使用企业身份工作项交付的已认证 principal 与资源授权；当前不能声称 `identity-*` 文件已提供完整 route middleware。Task 6 接入前核对真实接口，不临时发明匿名管理员。受控测试可注入 principal，但生产 enterprise 缺身份授权接线须拒绝启用。

## 契约、操作与状态定义

新增 `packages/contracts/tool-effects.ts` 维护序列化类型，`services/agent-runtime/tool-effects.mjs` / `.d.mts` 负责共享确定性校验。契约不可变，内容摘要包含全部语义字段；可信 API 审核登记和版本绑定才使其可用，工具文本和模型不能写审核状态。

```ts
type EffectContract = {
  schema:1; capabilityId:string; namespace:string; toolName:string;
  source:{kind:'builtin'|'native'|'mcp'; reference:string; version:string; digest:string};
  definitionSha256:string; effect:'read'|'workspace'|'external'|'unknown';
  isolationProfile:string; permissions:string[];
  retry:'bounded-read'|'provider-key'|'never';
  cost:{kind:'free'|'metered'|'unknown'; adapterId?:string};
  reconciliation:{kind:'receipt'|'query'|'manual'; resolverId?:string; version?:string};
  compensation:{kind:'none'|'operation'; capabilityId?:string; contractSha256?:string; requiresApproval:true};
  evidenceRefs:string[];
};
type EffectIntent = {
  schema:1; operationId:string; runId:string; taskId:string|null; attemptId:string|null;
  rootCallId:string; callId:string; parentOperationId:string|null;
  principal:{kind:'employee'|'system'; id:string; sessionId:string; authorizationVersion:string};
  contractSha256:string; argumentsSha256:string; resourcePreconditions:Record<string,string>;
  scopeRef:{key:TaskAttemptKey; scopeHash:string; workRevision:string}|null;
  approvalId:string|null; budgetRefs:string[];
  providerKey:{key:string; endpointIdentity:string; accountRef:string; expiresAt:string}|null;
  compensatesOperationId:string|null;
};
type EffectState = 'prepared'|'dispatched'|'confirmed'|'failed-known'|'unknown';
type EffectEvidence = {
  schema:1; evidenceId:string; operationId:string; intentSha256:string;
  source:'device'|'runtime'|'resolver'|'human'; observedAt:string;
  outcome:'confirmed'|'failed-known'|'unknown'; receiptSha256:string;
  artifactRefs:string[]; reasonCode:string;
};
```

`definitionSha256` 为规范化参数/输出 schema、工具名和注册绑定摘要；实现身份另由 builtin 固定实现版本/发布摘要、native bundle、MCP connection version + endpoint identity + server tool schema 固定。**不**用函数 toString 或用户提供 version 证明代码；远端服务无法证明实现不可变时必须有受控服务的审核证据，否则保持 unknown。`permissions` 是权限需求，不是授权；摘要中只存账户引用，不能包含凭据。

序列化用对象键排序、保留数组顺序和原始值的严格 JSON；拒绝 undefined/非有限数字/不可序列化值。参数摘要不得使用 supervisor 的 UUID/字段消除算法。archive/UI 只存必要的脱敏参数摘要；原 dispatch payload 沿现有私有路径受访问限制保存。

| 转移 | 唯一有效证据与行为 |
| --- | --- |
| 无记录 → prepared | 当前身份/能力/权限/预算与参数校验，通过事务持久 intent，才允许下一步；提交不确定先按原 ID 查 SQL，不产生新 ID。 |
| prepared → dispatched | local 由已有 `/start` 单事务确认；external 由可信 adapter 持久 dispatch fence 后才发送；runtime 由 wrapper 在最后一次核对后提交。崩溃在 fence 与发送之间也保守 unknown。 |
| prepared → failed-known | 可信 admission 明确拒绝且确认没有派发；不能接受插件、stdout 或模型自报 notExecuted。 |
| dispatched → confirmed / failed-known | 可信结果验证器确认实际效果与后置条件；failed-known 可包含“部分效果已知”，不等于可重试。非零退出/isError 只是业务状态，不能独自决定效果状态。 |
| dispatched → unknown | 取消、超时、连接中断、租约丢失、证据验证失败；禁止自动重放变更、阻断依赖和恢复。 |
| unknown → confirmed / failed-known | 追加验证过的核对证据，通过 expected state/version CAS 更新投影；原 unknown 事件保留。证据不足仍 unknown。 |
| 重复/冲突 | 同 evidenceId+摘要重交幂等；同 ID 不同内容或与已决证据冲突返回 409 并记录冲突，冻结后续变更。不能“最后到达覆盖”。 |

通用 `provider-key` 只定义合同；没有真实服务 guarantee、有效期和 resolver 的具体能力不允许设置此值。JSON-RPC id、operationId 或同参数 hash 都不自动等于服务幂等键。首版未知变更没有自动重发策略；未来同 key 重试也须当前授权/预算有效，先查原请求，过期则保持 unknown。

## Task 1: 固定可信效果契约并接既有能力目录与批准快照

**Files:** 新增 `packages/contracts/tool-effects.ts`、`services/agent-runtime/tool-effects.mjs` / `.d.mts`、`apps/api/src/tool-effect-contracts.ts`、`tests/tool-effect-contracts.test.ts`、`services/agent-runtime/tool-effects.test.mjs`；修改 `apps/api/src/product-schema.ts`、`native-capabilities.ts`、`work-tools-browser.ts`、`execution-policy.ts`、`app.ts`、`services/agent-runtime/employee-capabilities.mjs`。

**Interfaces:** 新增 `validateEffectContract(value):EffectContract`、`effectDigest(value):string`；`snapshotEffectContracts(agents,nativeBindings,mcpGrants,db):Promise<EffectContract[]>`、`assertEffectContracts(snapshot,db):Promise<void>`。在批准 snapshot 增加 `effectContractVersion:1,effectContracts`，能力总摘要被 B2 `capabilityHash` 消费。

- [ ] 先写红灯测试：只有 readOnly/idempotent annotations、同名定义替换、bundle/连接账户变化、已撤回契约、缺审核证据、重复 namespace/tool、从 company 来源伪装 builtin、metered 缺 adapter、unknown 申请执行均拒绝；原批准固定旧摘要，新注册不进入旧员工目录。
- [ ] 运行 `node --test services/agent-runtime/tool-effects.test.mjs`、`node scripts/test-integration.mjs tests/tool-effect-contracts.test.ts`，确认红灯来自缺功能。
- [ ] 增量建 `tool_effect_contracts(digest PRIMARY KEY,contract jsonb,reviewed_by,reviewed_at,retired_at)`，语义不可更新；撤回只改 retired_at。这是目录审核元数据，不是 registry/执行器。builtin 审核清单随固定版本提供；native 引用已有 bundle；MCP 按连接版本+实际 tool schema 登记。变更生成新 digest，历史不可覆盖。
- [ ] `capability_search` 工具结果带已授权的效果/固定版本摘要；插件列表和 MCP 列表附契约状态。未审核能力可给管理员看，不能给员工可调用提示。Skill/知识继续各自版本机制，工具执行仍由 DSH registry 派发。
- [ ] 批准和 `assertRunAuthorization` 接契约当前状态。首批审核产品内建读取、workspace 写/终端及实际固定 native 文件插件；`terminal_test` 仍为 workspace，不因名字含 test 判只读。协作基础工具逐个绑定可信 runtime 契约，禁用 `agent_teams_` 前缀豁免；涉及任务/会话变更默认 retry never。
- [ ] 跑新增测试与 `tests/native-capability-store.test.ts`、`tests/company-capabilities.test.ts`、`tests/browser-mcp.test.ts`；通过标准是旧历史可读、未核验工具零派发、不同版本不串授权。

## Task 2: 在原 operation 行上落意图与核对状态

**Files:** 新增 `apps/api/src/tool-operations.ts`、`tests/tool-operations.test.ts`；修改 `apps/api/src/product-schema.ts`、`local-execution.ts`、`run-coordinator.ts`、`services/agent-runtime/product-runtime.mjs`。依赖 Task 1、B2 Task 1/3 接口稳定。

**Interfaces:** 新增 `ToolOperationService.prepare(input:EffectIntent,payload:any,signal?:AbortSignal):Promise<{operationId:string;version:number}>`、`markDispatched(operationId:string,expectedVersion:number,signal?:AbortSignal):Promise<void>`、`recordEvidence(evidence:EffectEvidence,verifiedReceipt:any,expectedVersion:number):Promise<void>`、`read(operationId:string):Promise<any>`、`listUnresolved(runIds:string[]):Promise<any[]>`。runtime 只接注入的服务回调，不能直接导入 pg。证据验证器和当前授权由服务实现调用，客户端不能自己选择 trusted source。

- [ ] 红灯测试覆盖 intent commit 前/后故障、同 callId 不同参数、跨 run/employee 重用 ID、重复 admission、失效 lease、并发 dispatch fence、伪造 notExecuted、同回执二次提交/内容冲突、子操作 unknown 父成功。断言实际 transport 计数及 SQL 行数，而非只测 reducer。
- [ ] 运行 `node scripts/test-integration.mjs tests/tool-operations.test.ts`。
- [ ] 扩展 `local_operations`：增加 `executor_kind(local|runtime|external)`、`effect_intent/effect_state/effect_version`、`parent_operation_id` 和 `evidence_records jsonb`，保留已有 result/late_result、transport status 和 B2 merge 字段。device_id/grant_id 仅非 local 可空，CHECK 强制 local 必有真实设备/grant；旧行默认 local。新增 C1 行以 prepared transport status 起步，仅 `enqueue` 将 local 行变 queued；非 local 行永不被 device poll 领取。
- [ ] 按 run_id、intent.principal.sessionId、callId 建可信调用身份的表达式唯一索引，并在冲突读取后比较完整 intent digest；同身份异参数/契约拒绝，不能换 contractSha256 创建第二次执行。system 初始化使用独立固定 callId。parent 必须同 run、有效祖先、不可循环；不能用 rootCallId 代替 parent 校验。
- [ ] 抽出既有 project→run→operation 锁帮助函数供 local/C1 共用，local 才加 device 锁；预算锁顺序保持原 `shareCostMaintenance` 协议。append-only evidence 数组在行锁下追加、bounded 分页公开；达到容量先停止新执行，不删除 unknown。SQL 是状态权威，archive sourceKey=`tool-effect:<operationId>:<version>` 可重投，不能由 archive 成功反推 DB 成功。
- [ ] local enqueue 填充已有 prepared 行、验证 operation 与 scope/approval 完全相符；保留 approval_id UNIQUE。不得同时由 wrapper 和 local service 记录两份物理操作。未升级旧行不按工具名称补可信效果，仅只读审计或保守未决。
- [ ] `RunCoordinator` 构造共享服务注入 `ProductDshRuntime`；重启启动前把原 dispatched 无已决证据标 unknown。无 worker 自动领取/重发 external operation，不新增队列。运行新增测试、原 `tests/product-flow.test.ts` 与 `npm run build`。

## Task 3: DSH guard、嵌套调用及实际工具 transport 接线

**Files:** 新增 `services/agent-runtime/tool-effect-runtime.mjs` / `.d.mts`、`services/agent-runtime/tool-effect-runtime.test.mjs`、`tests/tool-effect-flow.test.ts`；修改 `host.mjs`、`employee-hosts.mjs`、`employee-tool-access.mjs`、`product-tools.mjs`、`native-plugin-tools.mjs`、`employee-capabilities.mjs`、`product-runtime.mjs`、`apps/api/src/work-tools-browser.ts`、`local-execution.ts`。依赖 Task 2 与 B2 实际 wrapper 接线。

**Interfaces:** 新增 `installToolEffects(ctx,{snapshot,operationService,activeWork,...}):()=>void`、`operationFor(exec):EffectIntent`（内部 token 映射）；product/native 调用把已准备 ID 放入可信 context。扩展 `executeBrowserMcpTool(input)` 的 input 增加可信 `operationId/sessionId/callId/taskId/attemptId`，API 再查存储 intent，不信任传入 ID 即授权。

- [ ] 真 DSH 测试：动态 register、scope-local shadow、pre hook 替换参数、相同 schema 不同 definition、无 agent 后台调用、伪造 parent、两个并发 root、合法嵌套两层。断言未授权 body/HTTP/exec 计数为零；合法子调用每个一行，父 token 映射正确、没有共享可变全局“当前 operation”。
- [ ] 经真实 runtime→tool wrapper→服务→local 协议或 MCP HTTP fixture：合法文件读写/native 调用复用原 operation；MCP 自报 readOnly 的写工具被挡；已审核只读 schema 漂移被挡；原连接撤权在等待后被挡。wrapper 捕获插件 isError 不能把已发送 unknown 清掉。
- [ ] 运行 `node --test services/agent-runtime/tool-effect-runtime.test.mjs` 和 `node scripts/test-integration.mjs tests/tool-effect-flow.test.ts` 确认红灯。
- [ ] 双 Host 安装 guard + around wrapper；guard 同步拒绝身份/实际定义/契约不符，wrapper 异步固定权限、scope、意图并持久化后 `next()`。在实际 transport 前重查数据库授权、lease 和 immutable digest，封堵 guard 后等待/异步变更；协调/后台仅允许显式 system principal 与精确绑定工具，不能因无 agent 跳过检查。
- [ ] token→operation 使用每次 execution 独立 Map，绑定本 Host/run；parent token 不存在、结束后 reuse、跨 Host token 直接拒绝。DSH 提供 rootCallId 只作审计；可信 parent 决定嵌套链。子操作单独 intent/checkpoint 持久屏障；父 finalizer 不能覆盖子未知。插件不经过 DSH 而自己产生的副作用只能按整个插件操作保守核对，不能承诺捕获任意私有网络调用；不受控 Host 插件不准入。
- [ ] 保留 B2 顺序和 mutex：当前 assignment→prepareTask→scope→逐次批准→mutex 内重查→before-tool checkpoint→prepared intent→enqueue/start→verified result/merge→Handoff→checkpoint。wrapper 在 `next()` 前调用按可信 binding 选定的现有 product/native 预处理代码，完成 scope/approval 和 immutable intent；将获得的上下文传入原 body，移除 body 内重复审批/排队/mutex acquisition，避免死锁。未知 binding 没有预处理适配即拒绝。runtime/external 分支同样先持久 prepared 后才 next；`next()` 本身不是 device dispatched。
- [ ] MCP `listTools` 获取声明后核对审核 digest，调用前再次检查连接/人员授权；`tools/call` 前持久 dispatch，输出只由可信验证器产证据。browser_read 使用现有 origin 限制与浏览器入口，网络读取审核明确服务边界，不从 GET/名称推定绝对无效果。mcp_call_readonly 仍只允许已核验 read；新增写业务需走原插件接入并独立审核，不悄悄扩展这个工具语义。
- [ ] 将 `retryRead` 改为接受可信契约及每次尝试 callback：只对已核验 free read 有界重试（现有 maxReadRetries），每次传输尝试留证据、重查授权；不得生成另一业务操作来掩盖重试。metered 无预算适配器拒绝；provider-key 首版保持关闭。
- [ ] 跑新增测试、`employee-tool-access.test.mjs`、`product-tools.test.mjs`、`employee-capabilities.test.mjs`、`npm run test:handoff` 与 `npm run build`。必须证明从产品入口执行，不以 helper 单测替代。

## Task 4: 本地 durable journal、迟到证据与 B2 合并核对

**Files:** 新增 `tests/tool-effect-local-result.test.ts`、`tests/local-effect-journal.test.cjs`；修改 `apps/desktop/local-client.cjs`、`apps/api/src/local-execution.ts`、`tool-operations.ts`；仅通过 B2 `task-canonical.ts` 已有接口提交成果。依赖 Task 3/B2 Task 3。

- [ ] 红灯故障点：journal 临时写/fsync/rename/目录同步、`/start` 已提交但应答丢失、执行后 receipt 保存失败、result SQL 提交后 ACK 丢失、收到 ACK 本地更新失败、进程退出和重连。每例 operationId 不变、实际 command 次数≤1；starting/已确认 start 丢应答不能声明 notExecuted。
- [ ] 红灯结果：同回执重交、冲突回执、跨 scope/operation/claim、撤权后同原 claim 的有效迟到证据、device backend 配置已变；使用原 intent 的 backend 身份验真，不能用当前改过的 backend 替代。弱设备错误声明与真实后置验证不一致维持 unknown。
- [ ] 运行 `node --test tests/local-effect-journal.test.cjs`、`node scripts/test-integration.mjs tests/tool-effect-local-result.test.ts`。
- [ ] journal 增量 version 2：保存 operation/intent/claim/scope 摘要及完整 receipt；复用 `apps/desktop/openshell-executor.cjs:atomicJson` 已有的普通文件/硬链接拒绝、file fsync→rename→非 Windows directory fsync 模式，保留 local-client 的 Windows 有限 rename 重试（绝不重试命令）。持久屏障完成才进入下一阶段。Windows 不支持目录 fsync 时须明确能力边界并做平台断点/重启测试；不能记录为已证明断电持久。acknowledged 保留原证据与 ACK 摘要，不再只留 claim；旧格式只读兼容，不据缺失 receipt 重执行。
- [ ] `/result` 先原 claim/intent/backend/scope 验真，再区分证据接收与当前执行/merge 授权。已停用设备的原 key 仅可给原操作补证据；key 已真正失效则进入具备独立核对权限的证据导入流程，不能恢复 key 或给设备 poll 权限。DB result/late_result 与 effect evidence 在同事务持久化，冲突 failclosed。
- [ ] 迟到成功可证明原命令已执行，但撤权、lease 失效或 CAS 冲突时不调用 commitTaskResult。保留导出和拒绝原因；新的合并/补偿必须重新获准。命令 confirmed+merge unknown 仍是恢复/清理门禁；核对只查询 B2 原操作/原 sandbox/export/CAS head，不再运行 command。
- [ ] 运行新增测试、`node --test apps/desktop/local-executor.test.cjs tests/local-openshell-bootstrap.test.cjs` 及现有 `tests/product-flow.test.ts`、`tests/local-operation-heartbeat.test.ts`；在 B2 合并故障测试上增加 effect/merge 组合断言。两个状态维度不能相互“成功即清空”。

## Task 5: 逐操作核对、恢复门禁、保留与备份

**Files:** 新增 `apps/api/src/tool-reconciliation.ts`、`tests/tool-reconciliation.test.ts`、`tests/tool-effect-recovery.test.ts`；修改 `services/agent-runtime/recovery.mjs` / `.d.mts`、`step-checkpoints.mjs`、`apps/api/src/recovery-conditions.ts`、`step-checkpoint-recovery.ts`、`run-management.ts`、`app.ts`、`planning-execution-context.ts`、`storage-lifecycle.ts`、`storage-governance.ts`、`backup.ts`、`backup-checkpoints.ts`。

**Interfaces:** 新增 `reconcileOperation({operationId,expectedVersion,mode:'receipt'|'query'|'manual',evidenceRefs},principal,signal):Promise<any>`；`requireResolvedEffects(db,runIds):Promise<void>`。registry resolver 是服务代码中精确 `resolverId/version` 映射到审核过的读取适配器，不是用户可上传 JS 的插件系统；首版提供 local receipt/B2 merge 查询和 runtime 持久记录核对，external 未有服务适配器则 manual。

- [ ] 红灯：新工具不在静态集合、名称冒充 filesystem、父结束子未知、runtime/operation-finished 先于 merge unknown、源 run 未决但新 run 无事件、截断 checkpoint 丢后续写、布尔 acknowledgeUnknownOperations=true、撤权后恢复、伪造人工核对；恢复均拒绝且无新队列行。旧确切只读历史可展示，缺可信证据不追溯授予只读资格。
- [ ] 红灯：查询 resolver 参数越权、无权限/收费查询、查询超时、查询报不存在但存在最终一致窗口、只有当前文件 SHA 缺原命令结果、手工备注没有可验证证据；均不伪造 known。有效相同回执解除原 operation 未知，但不能解除独立 merge/费用 unknown。
- [ ] 运行 `node scripts/test-integration.mjs tests/tool-reconciliation.test.ts tests/tool-effect-recovery.test.ts` 确认红灯。
- [ ] 查询操作本身有独立子 operation、当前读取授权、固定 resolver 与结果摘要；只读已验证免费才能自动有界重试。manual 输入只接受当前有核对权限的人提交实际证据引用、对象/请求 ID 和判定理由，保存 human provenance，不能伪装 provider proof。证据不足显示“已查看，仍未知”，不改状态；可信审核者作人工最终判定时明确标人工核对及责任人，保留原冲突/unknown，不能修改费用记录。
- [ ] `unresolvedOperations(events)` 保留兼容签名与旧审计读取；C1 事件按 operationId/digest/version reducer 解释，不允许裸 tool/result 清未知。所有执行/恢复/维护 API 先从 SQL `requireResolvedEffects` 检查完整 ancestry，archive 丢事件则补投或拒绝；不能仅依赖事件投影判断安全。新 checkpoint 写 effect 操作引用/摘要和 B2 scope/merge 引用，不复制费用或重置状态。
- [ ] run-management 移除 C1 的布尔绕过；恢复只消费已核对的具体 operation+evidence 版本，并再次检查当前权限/方案/费用。兼容旧字段可返回指导核对的 409，不能产生新的默认重放通道。checkpoint 时间回退仍保留全 lineage 的外部操作/预算/审批。
- [ ] 扩展原维护 SQL 查询到 effect prepared/dispatched/unknown、冲突证据及 B2 pending/unknown merge；不能因 status=failed/cancelled 清理。backup 与 B2 同一版清单导出 effect contracts、原 operation/evidence 和引用对象；导入默认审计态，禁止将历史 prepared/started 重新加入设备 poll。旧备份可读，缺新引用的新备份验证失败。
- [ ] 跑新增测试、`tests/run-recovery-confirmation.test.ts`、`tests/recovery-conditions.test.ts`、`tests/checkpoint-branch.test.ts`、`tests/backup-checkpoints.test.ts`、`tests/storage-governance.test.ts`。所有未决分支无新执行，已确认分支不丢历史。

## Task 6: 网页核对入口与单独授权的补偿

**Files:** 新增 `apps/web/src/RunToolOperations.tsx`、`tests/tool-operations-ui.test.ts`、`tests/tool-compensation.test.ts`；修改 `apps/web/src/RunExtras.tsx`、`NativeCapabilities.tsx`、`BrowserMcpCenter.tsx`、`api.ts`、`apps/api/src/tool-reconciliation.ts`、`run-management.ts`、`run-coordinator.ts`、`app.ts`。依赖 Task 5、企业身份/资源授权已接线。

**HTTP 新增接口:** `GET /api/runs/:id/tool-operations?cursor=...`；`POST /api/runs/:id/tool-operations/:operation/reconcile` 请求 `{expectedVersion,mode,evidenceRefs}`；`POST .../:operation/compensation-preview`；`POST .../:operation/compensations` 请求 `{previewId,approvalId,requestKey}`。保留 `/local-operations` 兼容显示，统一列表中按 operationId 去重。所有读取/修改按 run/project 资源授权；身份与授权先于幂等响应缓存。

- [ ] 红灯 UI/API：跨部门枚举 operation、只读成员调用核对/补偿、CSRF、已撤权仍命中幂等缓存、重复点击、旧 expectedVersion、原批准套补偿、补偿参数/schema/目标版本变化、原效果未决、补偿已 unknown 再点击。断言 403/409、无第二次 transport，UI 显示原状态和可操作原因。
- [ ] 运行 `node scripts/test-integration.mjs tests/tool-compensation.test.ts`、`node --import tsx --test tests/tool-operations-ui.test.ts`。
- [ ] 操作卡显示员工/工具固定版本、效果、分派/结果/成果提交分开的状态、原请求/证据摘要、父子关系及核对历史；原始参数/回执按权限脱敏。unknown 没有“直接重跑”按钮；核对失败保留可见错误。目录显示“未审核/已核验/已撤回”、证据版本和员工可用原因，启用插件不会自动完成 effect 审核。
- [ ] 补偿 preview 仅从原 confirmed/failed-known 的确定效果、固定补偿契约和当前资源版本生成；没有真实已验证逆操作时返回“不支持自动补偿，请人工处理”，不得通用生成退款/删除。确认创建**新** operationId，`compensatesOperationId` 指向原操作，走原 tool_approvals 独立批准、当前权限/预算/运行租约，原 ID/批准/key 不可复用。保留原结果与独立补偿结果。
- [ ] 原 run 已终止时不得重新激活它或借核对接口直接调工具；通过已有批准方案/新运行流程建立有预算和任务合同的补偿工作，绑定原操作及 preview。首版没有经审核的实际业务补偿契约时，生产 UI 禁用执行按钮，仅本地受控 fixture 测其授权状态机，明确未验证实际业务逆操作。
- [ ] 浏览器验证原页面中完成“查看未知→核对原 receipt→看到新证据→恢复条件刷新”，并验证撤权时不展示他人正文。`npm run build`、新增测试及 `tests/run-extras-errors.test.ts` 通过；记录屏幕证据而非只静态搜索按钮文案。

## Task 7: 完整链路故障验收及发布门禁

**Files:** 新增 `scripts/validation/tool-effect-integration.ts`、`tests/tool-effect-validation.test.ts`、`docs/validation/tool-effect-integration-2026-10-20.md`。依赖全部前项及 B2 所需验证层。

- [ ] 验证 runner 先测拒绝生产 DB/现有项目、非本应用临时目录、配置或版本不符、未知上次执行；提供 check/run/reconcile 三模式，reconcile 只查询已知 ID。无模型费用、不开生产凭据。
- [ ] 使用实际 DSH 员工 Host、原内建工具、既有 native 文件插件、真实 HTTP MCP fixture、原设备协议和临时 PostgreSQL 走全链。fixture 的“外部写入成功后断开连接”由独立持久 store 计数，重启 worker/API 后 query 原 request 查得一次；另一个不支持查询的 fixture 持续 unknown，不能换 key。强调 fixture 是协议证据，不是某 SaaS 的保证。
- [ ] 真实 PG 验证两 worker 同时 admission/dispatch、同回执重复、相互冲突结果、撤权与迟到竞争；与 B2 CAS 并发测试复用临时 DB。PGlite 可做逻辑测试，不能代替真实行锁/事务隔离证据。
- [ ] JJ 在已授权隔离验收环境复用固定 OpenShell、已有 native 插件及 B2 scope：执行→结果断连→设备重启→原 receipt 核对→原 merge 状态读取，actual command count=1；撤权后 receipt 仍可留存，但 canonical 不再合并、恢复不准入。无生产访问授权则列受阻，不借工程测试访问真实凭据。
- [ ] 故障矩阵包含 intent、dispatch fence、设备 starting、结果持久化、archive 补投、核对 CAS、merge commit、补偿确认前后；每例保存 operation/root/parent/scope/contract/evidence IDs、SQL 状态、transport count、权限决定和费用行差异。固定 fixture 全程 usage/model_reservations 无新收费记录；实际收费业务另按授权门禁。
- [ ] 发布清单逐项标本地协议、真实 PostgreSQL、JJ OpenShell、实际插件、真实模型业务/外部服务。未安装/未审核的 plugin、provider-key 及实际补偿一律保留未验证/禁用，不泛称“任意插件已可自动恢复”。
- [ ] 回滚先停新 admission、排空或冻结未决，保留增量 schema/契约/证据；旧版本不能读取 C1 snapshot 后按旧布尔确认或静态列表恢复执行。启动前检查 profile/schema 支持，原 legacy 历史仍可浏览。备份/恢复演练验证核对数据及 B2 canonical 引用完整，未决操作不复活。

## 依赖、完成标准与当前状态

顺序：Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。B2 Task 1/3/4 是相应接线前置；真人身份完整接线是企业核对/补偿 API 发布前置。共享文件只串行修改，无双账本迁移、无并行 merge owner。每任务测试红灯→最小实现→绿灯；需要提交时由主执行者按用户授权办理，本计划编写不提交。

完成需同时满足：实际工具入口和目录绑定可信 contract；所有物理操作只有一个权威 ID；嵌套和迟到证据不丢；恢复/备份/清理都查同一未决事实；网页能查、核对、解释阻断；补偿只能独立获准；上述负面测试与必要 JJ 验证有可复查证据。只完成 types/helper/reducer 不算 C1 完成。

当前：**计划已形成，C1 实现与运行验证尚未开展。** 已做固定源码和 MCP 官方规范核对；未调用模型、未访问生产/凭据、未修改源代码。明确风险是共享 operation schema 与 B2 的交接、现有 journal 断电持久性、历史布尔恢复绕过及缺少真实外部服务查询/补偿保证；对应任务均以 failclosed 和验收证据收口。
