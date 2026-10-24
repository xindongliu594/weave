# C1 生产组合与 runtime 操作接线 Implementation Plan

> **For agentic workers:** Use executing-plans and test-driven-development。此文是既有企业功能授权范围内只读核对后的下一片方案，尚未实施；实施前串行交接共享文件，不必对已授权的常规实现重复请求确认。本次研究没有安装、模型调用、生产访问、CUA 或提交。

**Goal:** 管理员能审核固定生产组合的基础工具；批准快照和真实员工调用使用同一合同，并使一个知识任务从协作建立到正式交接走通持久操作链。

**Architecture:** 复用固定 DSH registry/guard/execute、原知识服务、Skill provider、AgentTeams、现有合同 service 与 local_operations。新增的是固定生产组合的少量绑定规则及现有操作表的 runtime 分支，不增加插件引擎、可上传审核代码、ALS 或通用 attestation 框架。

**Tech Stack:** DSH 0.1.5-rc.1、Cordis 4.0.2、AgentTeams 0.1.20、现有 PostgreSQL、ArchiveWriter、预算和 OpenShell/B2 接口。

**Spec:** `2026-10-20-tool-effect-integration.md` Task 1–3；`2026-10-24-tool-effect-contract-authority.md`；`2026-10-24-tool-effect-source-inventory.md`。本片先打通 runtime 操作；原计划 local transport/外部服务后续仍需完成，不以 runtime 回执替代设备结果。

## 已核对的实际生产来源

| 实际位置 | 已有注入/调用 | 可证明的效果及最小绑定 |
|---|---|---|
| `apps/api/src/run-coordinator.ts:37` → `product-runtime.mjs:46,218` → `host.mjs:290,414` | 直接导入 `knowledge-store.queryKnowledge`，没有模型生成的查询 callback | 固定函数引用与发布摘要一起绑定；不用传入的字符串版本或函数 toString。自定义 callback 不继承该合同 |
| `knowledge-store.ts:100` | read/skill 只核对固定 manifest、SELECT 固定 revisions/chunks；keyword search 只查询/排序 | 在固定生产组合中可审核 read/free。free 表示没有额外收费服务调用，不表示无本机 CPU/DB 成本；引用审计仍由原 archive 记录 |
| `knowledge-vector.ts:18` | hybrid search 调 `vectorCandidates`，缺索引会 `indexChunks INSERT`；`embedding/local.mjs` 只允许本地固定模型 | hybrid 是 workspace 状态写，不能沿用 keyword 的 read 合同。快照必须绑定 retrieval mode/embedding version；首次闭环限定 keyword，hybrid 明确要求 workspace intent 支持，不静默降级或强改现有设置 |
| `approved-skills.mjs:42`、`employee-hosts.mjs:252` | 原 `installApprovedSkills` 注册 runInputs 与 weiwu-company provider，get 再调用同一 queryKnowledge 并校验内容 hash | 固定 installer、原 DSH skill/tool-skill 与生产 query adapter 共同构成 read/free 来源；只允许该组合加载的批准目录。额外 provider/自定义 loader 不继承资格。Skill 文本不能授予工具权限 |
| `employee-capabilities.mjs:26,38` | search 调知识/skills/catalog；use 校验已读取证据后 append capability/adopted（原 sourceKey 去重） | keyword discovery 可 read/free；capability_use 是 workspace/runtime 写，复用原采用记录去重并新增 operation 身份，不能借已有 sourceKey 声称所有调用 exactly-once |
| `host.mjs:315,459,532`、AgentTeams `lib/tools.js:1855` | 原插件 + 现有 host 策略；captain status 会 `scheduler.kickTeam`，create/approve/claim/update/message 修改团队/邮箱并可能唤醒成员 | 基础协作按 workspace/runtime，retry never。其直接状态操作不产生独立 SaaS 收费；唤醒的模型请求必须继续经过原 `beforeRequest → RunCoordinator.reserve`、次数/金额/unknown 费用链，工具合同不能豁免或增加预算 |
| `run-coordinator.ts:37` → `LocalRunExecutor` → `local-execution.ts:172` → `openshell-executor.cjs:297` → `native-plugin-worker.cjs:3` | 真实 native callback 是受限设备 transport；bundle 校验、Node permission、OpenShell、临时工作副本、B2成果核对已存在 | native source 必须同时绑定 manifestId 与可信执行器/设备 backend profile；文件声明不证明语义。继续 unknown 到 exact bundle 审核 + 同一个 local operationId 接线，不能只凭无 writePaths 标 read/free |
| `run-coordinator.ts:37` → `work-tools-browser.executeBrowserMcpTool` | 现有 HTTP MCP initialize/list/call 和固定连接版本；当前仍用 readOnlyHint 作检查 | annotations 不构成效果审核。具体 endpoint/account引用/version/tool schema 仍需独立合同与 intent；本片不开放 browser/MCP 或伪造 free |

`host.mjs:137` 的 bindActiveWork 是原任务绑定，knowledge 调用也可能先记录 assignment/scope；它是可信前置控制状态，必须保留，不能为了 read 分类跳过。业务读取语义不消除会话、授权、任务绑定和审计写入。

## 固定官方实现可以复用到哪里

- `services/agent-runtime/node_modules/@deepseek-ai/dsh-base/node_modules/@deepseek-ai/dsh-session-checkpoint-policy/lib/index.js:66`：已实际挂入 EmployeeHost；顶层工具前 `sessions.flush`，nested 复用外层屏障。继续直接复用，不重写会话 checkpoint。官方[说明](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/session/session-checkpoint-policy/README.md)也明确不保证 exactly-once；已安装 0.1.5-rc.1 的源码才是本片依据。
- 同 base 嵌套目录下 `dsh-session-persistence-jsonl/lib/index.js`：原 flush/append/fsync 与平台持久化实现继续使用。会话日志不是 SQL operation 状态或外部效果回执。
- `services/agent-runtime/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js:131`：已有 approval/asked + decided，仅 allowed-once；[官方说明](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/interaction/user-approval/README.md)。不能替换为伍原 tool_approvals 的精确参数、预算、设备与审批绑定。
- `@nanmicoder/dsh-agent-teams/lib/state.js:35,241,574`：原 withTeamLock、team.json、mailbox delivery lease；`tools.js:1421` 的 claim 局部幂等可复用。没有通用 callId→intent→receipt SQL 索引；atomicWriteText 还有 Windows direct-overwrite fallback，不能宣称具备通用断电效果事务。保留[原插件](https://github.com/NanmiCoder/dsh-agent-teams)业务状态与调度，不复制队列。

上游链接仅用于确认职责边界；没有将 master 新 API 当作安装能力。未发现固定插件可直接提供为伍跨 run/权限/预算/B2 的完整操作事实，因此只补缺失的数据库关联和接线。

## 下一片边界与接口

**必须一起交付的真实链路：** 管理员在现有能力页审核基础合同 → 批准一个 keyword 知识任务（outputs=[]）→ 原队长 create/approve/status → 员工 claim、knowledge_read/skill、capability_use、正式 update_task → 原宿主验收。只要求这条链路的工具进入 snapshot；未选择的 native/MCP/terminal 不因目录中 unknown 阻断它，C1 运行也不允许未列工具退回 legacy 执行。

1. **固定生产绑定**：新增 `apps/api/src/tool-effect-production.ts` 与测试；它直接导入 queryKnowledge，创建固定 source/authority 与运行服务绑定，不接受 HTTP 自报 callback/语义。修改 `tool-effect-sources.ts` 增加明确、有限的生产 profile（keyword/hybrid 分别绑定），保持未绑定任意 source 的原 unknown 行为。`RunCoordinator` 使用同一 factory 返回的 callback/authority；Host 注册前核对绑定的确切 callback 引用、固定注册函数、插件集合及发布摘要。自定义 createExecutor 不能冒充 native 来源。发布 fingerprint 必须补入此次实际使用的 checkpoint/persistence/预算及设备适配器实现，避免只核 product wrapper。
2. **原操作表 runtime 分支**：新增 `apps/api/src/tool-operations.ts`（含独立 migrateToolOperations）和 `tests/tool-operations.test.ts`。按原 Task 2 扩展 local_operations 的 executor_kind/effect_intent/effect_state/effect_version/parent_operation_id/evidence_records；local 仍要求真实 device/grant，runtime 允许空设备。runtime 不进入 queued/claimed，不被设备 poll 领取。旧 local 行与 B2 merge 列不动，不新建第二张物理操作主表。
3. **实际调用门禁**：新增 `services/agent-runtime/tool-effect-runtime.mjs/.d.mts/.test.mjs`；修改 employee-hosts、host、product-runtime 的小接口。沿原 guard 与 tools/execute 链：原身份/定义核对 → session checkpoint → 持久 prepared → 当前授权/lease/合同再次核对并持久 dispatched → 原 next/body → 固定 runtime 证据持久化。每个调用独立 token→operation map，嵌套 parent 必须来自本 Host 的活跃映射。无 ALS。原 forward 只对应同一次 operation，不再生成第二行。
4. **串行挂载**：父/A2 收口 app/catalog/批准事务、run-management；B2 交接 local-execution 前不修改它。本片只启用 runtime 传输；原 local prepare/bind 状态继续走 B2，不预占/伪造设备 operation。合同 service 增加 `snapshotIn(client,keys)` / `assertContractIn(client,contract)` 供同一批准/admission事务使用；runtime workspace admission 必须同时有已提交 operation fence，缺失仍 TOOL_EFFECT_INTENT_REQUIRED。保留现有 read withAdmission 的取消/drain 行为，不让新的 workspace 分支借空参数跳过 intent。

**可现在独立并行落地的模块（需父授权后）：** 仅 `tool-operations.ts`、新 tests、必要 tool-effects intent/evidence 校验；不改 app/product-schema/local-execution。外部提供已锁定 client 的接口：

```ts
migrateToolOperations(db): Promise<void>
prepareIn(client, {run, owner, intent, contract}): Promise<StoredOperation>
dispatchIn(client, {operationId, expectedVersion, owner}): Promise<DispatchFence>
recordEvidenceIn(client, {operationId, expectedVersion, intentSha256, evidence}): Promise<StoredOperation>
markUnknownIn(client, {operationId, expectedVersion, reasonCode}): Promise<StoredOperation>
requireResolvedEffectsIn(client, runIds): Promise<void>
```

这些不是信任任意参数的 reducer：模块复查 DB run/lease、固定合同、principal/call/scope摘要；dispatch 只从 prepared 原行 CAS 一次。`(run_id,sessionId,callId)` 唯一，碰撞比较完整 intent，同身份异参数拒绝。操作参数只存摘要和必要受权限保护的 payload；证据有字节/数量上限、追加不可覆盖，达到上限停止新执行。receipt/effect 与 B2 merge 状态保持正交。

## 锁顺序、预算与失败语义

- 沿已有 ArchiveWriter ownership → shareCostMaintenance → project → run → source/contract（排序）→ operation → device（仅后续 local）→ audit。没有持SQL锁等待 plugin body、网络、模型或成员完成；prepared/dispatch/receipt 各为短事务。运行 lease、取消、当前员工权限、合同退役在 dispatch 同事务再查；已提交 dispatch 后退役阻止新调用，不能将旧调用说成未执行。
- callback 取消/超时后保留并等待原 invoke，复用 task close/drain；先标 unknown，晚到结果追加原 operation 的 evidence。COMMIT应答丢失/rollback失败 discard连接并保留首错，未确认dispatch不能自动再进body。
- 协作调度产生的后续模型请求依旧逐次 reserve，测试必须证明零剩余额度时没有请求。操作层不复制、不核销模型预算账本。team status 是 workspace 调度入口，绝不按名字/展示卡片标 read。
- runtime 成功证据只确认当前 body 的结果与原 session/team/capability 记录，不确认它唤醒的成员已成功；未决子操作不能被父成功清除。原插件错误可能发生在部分状态写后，默认 unknown；只有调用前拒绝的可信事实可以 failed-known。
- 启用这条 C1 链路前，run启动/恢复和维护清理必须调用同一 `requireResolvedEffectsIn`；旧布尔 acknowledgeUnknownOperations 对C1无效。仅添加新表字段但未接这些门禁时不能宣称链路完成或全局启用。

## 实施顺序与故障验收

- [ ] **RED：固定生产绑定**。真实 queryKnowledge + 隔离 DB 测 keyword不写、hybrid确实补写、skill固定hash；替换同schema callback、额外provider、改retrieval mode、未知native/MCP不能继承合同。写最小factory/profile后GREEN。
- [ ] **RED：operation持久模块**。同call异参数、两个worker dispatch、退役/取消/lease失效、重复/冲突/迟到evidence、COMMIT与ROLLBACK故障；真实PG验证竞争，PGlite只验逻辑。再实施新模块，断言实际body计数≤1与SQL原行保持。
- [ ] **RED：真实DSH接线**。用已安装插件和临时archive，无付费模型：flush失败body=0，prepared失败body=0，dispatch已提交回包丢失不重发，body完成后receipt失败保留unknown；超时后原promise迟到成功仍只写原行。先扩workspace authority接口再接原Host，不放宽identity/definition/budget门禁。
- [ ] **RED：一个完整产品链路**。原createApp/批准HTTP/RunCoordinator/EmployeeHost + 确定性模型适配器，仅模型响应替身；真实queryKnowledge、Skill、AgentTeams、SQL/archive。走“审核→批准→员工读取→采用→正式交接”，检查contract digest/operation IDs/receipt、原调用次数与金额路径。追加当前权限撤回、合同退役、source drift、原unknown后恢复/清理全部拒绝。不得只用helper调用代替这个门槛。
- [ ] 完成上述链路后运行相关原产品回归、tsc/build；记录协议、原生PG与实际模型业务三种证据层次。没有真实模型/生产授权时不宣称实际业务验收。

最短实施决策：先授权独立 operation 模块并与父接生产 factory/路由并行，B2共享文件继续冻结；随后一次串行接Host与批准/恢复门禁。不要再扩展纯候选盘点，也不在本片做通用MCP幂等、外部补偿、后台重试worker或发布性能缓存。

### Production activation ruling (2026-10-24)

Enterprise approvals must freeze reviewed effects. Existing legacy runs remain unchanged; a legacy approval can explicitly request `requireReviewedTools: true` through the project page. This makes the new audited knowledge workflow usable without silently upgrading old snapshots or breaking existing native-plugin projects whose effects are still unreviewed. No selected tool may fall back after C1 is requested. Enterprise B2 execution remains blocked by its original profile gate until that chain is implemented. This is staged activation, not a claim that all enterprise work is enabled.

The fixed production composition needs one atomic per-run pair `{effectAuthority, queryKnowledge}` because a coordinator handles both execution variants and retrieval modes. Reuse the same factory for source review, same-transaction snapshot, and that pair. Do not use a mutable global callback or copy DSH's registry.

### 2026-10-24 第六片补充

原 API→DSH/AgentTeams→知识/Skill→交接→回执协议已接通；运行时只审核实际选用工具和固定协作入口，未选中的 unknown 不阻断知识任务，选中的 unknown 不能静默省略。原 prepared 未派发永久阻塞经独立反例修复为可信 CAS `failed-known` 终态；未知派发/提交仍不可自动解封。原生 PostgreSQL 14/14、DSH/边界 51/51、完整批准执行和旧运行保护 2/2、恢复/维护 3/3、独立原反例修复 1/1（不同层次分别记录，不相加为业务成功率）。当前只完成免费内建 read/workspace 接线；hybrid 实际嵌入、外部/native/MCP 收据查询/补偿、完整权限撤回和企业 B2 profile 仍未完成。相关独立复审及证据索引见 docs/validation/enterprise-plugin-foundations-2026-10-24.md，未调用真实模型、未发布生产。
