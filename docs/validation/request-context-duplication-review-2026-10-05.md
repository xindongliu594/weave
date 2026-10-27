# 请求上下文重复与批准前预检：独立只读审查

截至 2026-10-05 13:35（Asia/Shanghai），**有可减少的重复内容，但现有证据仍不能保证 $0.0857132 完成 QA、review 和经理验收。** 本次仅读当前源码、已经关闭的隔离请求捕获和公共 GET；只新增此报告，没有重跑 native、fake 模型或付费模型，没有创建产品 run、打开原 DB、读取/修改员工文件或操作服务。原额度 $0.48、已用 21/37 次、未知费用预留不变。后续业务修改归主代理/runtime agent，建议均未在本次实施。

## 账本与证据边界

两次 GET `http://127.0.0.1:4310/api/projects/dde78f91-2a99-4a63-a9fa-5cb7bab2b8f0/cost-readiness` 均 HTTP 200，时间为 13:25:28.169 和 13:35:13.212；完整 JSON 逐字段相同，包括两条收据 id、runId、amount、status。浮点原值是 reserved 0.027869400000000003、availableBudget 0.08571319999999998。

| 项目 | 开始 | 结束 |
| --- | ---: | ---: |
| 已登记金额 | $0.3664174 | $0.3664174 |
| 未知预留 | $0.0278694 | $0.0278694 |
| 原预算净额 | $0.0857132 | $0.0857132 |
| pending / uncertain | 0 / 2 | 0 / 2 |

两条未知仍为 `12ebc7bd-bc11-4948-9142-d778f0e22433` $0.0222384 与 `4319725c-c6aa-4401-834d-271fb06d4c9e` $0.005631。21 次历史调用、QA 4/14 次及原方案上限来自已关闭的 [源运行审计](../test-evidence/fresh-resume-budget-first-sol-claim-source-audit-2026-10-05.json) 和 [最终 compact 捕获](../test-evidence/fresh-resume-budget-first-sol-claim-compact-probe-final-2026-10-05.json)，没有把公共已结算 usage 行数等同于包括 unknown 的调用数。

本次读取原捕获的 `captured-first-sol-body.json` 与 `captured-second-sol-body.json`，重新对其 `JSON.stringify(body)` 求 SHA，分别准确匹配证据的 `7ee6a273ba5300dd6989e7d86d58d004f8f8d7a5da1529ae0d7124d4879495f9` 和 `fcb0729265cd9c5db8907625dfb58df5c7c3cc5ef20b7743eecbff94ea5681ad`。同时只读同一关闭 session seq 7 的 source section 提取字段，不输出完整需求或私有正文。捕获目录为 `.data/fresh-resume-budget-review/bd9da514-ad20-4365-abf8-caf584c57953`。原证据包含 fake usage，仅用于请求形状；本次没有用新的低费 fixture 证明可负担。

## 实际重复与增长来源

1. **旧 native snapshot 会增长，但不是当前精简后第二笔的最低费用主因。** 已安装 `dsh-agent-loop` 的 `RuntimeContextProjection.project` 在渲染文本改变时产生新 user snapshot；`step` 用 surface append 归档。每笔之后预算金额/次数变动会使文本变化。当前 adapter 的 `protectedWireIndexes` 仅保护最新、精确来源为 `@deepseek-ai/dsh-system-prompt` 且 section 为 `department:approved-context` 的 snapshot。旧快照仍留在追溯档案，但在有预算压力时作为完整旧组可移除：已保存首轮 37588B → 29095B（移除 1 组），次轮 54842B → 31952B（移除 2 组）。次轮实际 wire 只有 system、assistant claim、tool 回执、最新 user snapshot，已无旧 snapshot。拟合不是主动总是删除旧快照，余额充足时仍可能一起发送。

2. **完整 requirement 并没有重复两份。** 4627B 需求（SHA `839bed6bc6ef0efa722e577ff62376baa78c0d6996ef73c8501e31eb12b31de7`）在两份实际 wire 都只出现在最新 JSON snapshot 中一次，在 system 与 claim 回执出现 0 次。assignment 原始消息和 snapshot.source 元数据包含额外副本，但 assignment 已被拟合移除，source 不进入 wire；不能把原始追溯 JSON 的体积当成供应方请求体积。最新 canonical task JSON 1857B、recovery JSON 5336B、budget JSON 679B；这些当前唯一权威数据不能按“重复历史”删除。

3. **当前任务字段存在精确重复。** QA objective 835B 在首轮 system Team goal 与最新 canonical task 中各一次；次轮在 claim `task_details` 又出现一次。subject 28B 同样由两份增至三份。四条 acceptance、输入/输出文件 JSON 在次轮 tool 回执和最新 task 中各一次。完整 Team goal 3153B（SHA `dd9cd9387bf4bdd74737574425086e0053f87f6fa24e5892cd119872712a453f`）还含其他任务目标；不能因其中有重复就直接删整段原生系统、团队说明、合同或权限。当前 compact claim 2445B 已消除了原 taskPrompt/旧规划重复；现存重复来自 native renderer 重述 typed contract，而 typed contract 本身必须完整保留。

4. **工具证据保护会累计。** `pinnedEvidence` 检出 path+64 位 SHA，或 documentId+version+SHA；knowledge_search/read 按原调用 id 对应工具名全部保护。拟合把 assistant 和其连续 tool responses 作为整体组，因此只要一个结果需保护，整个组及 assistant 工具实参都会保留。完整 filesystem 内容受到 EvidencePruner 保护；成功 artifact_write 的 path+SHA 结果也会使包含完整写入 content 的 assistant 组受保护。之后再次读取同版本文件，会新增另一份完整内容。当前函数没有按 path/SHA、doc/version/chunk/SHA 去重，也不会自动淘汰旧文件版本。这是后续增长的具体代码风险；本次关闭两步捕获尚未读取/写入文件，不把这项静态发现冒充新的真实 QA 复现。

最小的安全证据去重只能先针对**严格同一批准范围内的重复只读结果**：同 path+SHA+完整 content，或同 doc/version/chunk/SHA+完整片段；保存完整归档、当前 input seals/知识授权/引用版本，保留最新完整版本，并且整个被移除组不能还有唯一结果、未核对副作用或其他唯一信息。不同版本、不同查询结果和单有相同 SHA 的不完整文本不能视为等价。默认所有证据仍保护；没有这种宿主证明的结果不得移除。这项改动必须新增真实本地 DSH/adapter 回归，当前未实施。

## 最小产品限定方案与量化

优先做可证明的产品限定描述引用，而不改已安装 native plugin 的通用系统指令：在 production mapper 同样的严格 `assertApprovedTaskContext` 条件下，生成简短 Team goal/DAG 提示；全部原 typed task fields、输入/输出 JSON、完整需求、当前任务合同、恢复与权限仍由最新受保护宿主 section 和原 native task state 承载，旧全说明仍归档。callback 缺失、false、异常、Promise、当前 task/employee/attempt 无法确认时必须拒绝或回到原完整说明，不得启用 compact。若减少其他节点目标，要证明其完整合同仍在批准/native task 状态中，经理可获得完整验收范围，不能仅凭“看起来重复”删除。

本次只对保存请求做**内存算术**：把 system Team goal 内唯一一份 835B 当前 objective 换为 79B 的“当前任务目标完整见最新 department:approved-context.task.objective。”，其他所有字符、消息、工具和输出上限保持。没有写入 native/session，没有实际执行这种产品路径。

| 保存场景 | 旧 envelope / 预留 | 仅减少此重复副本 | 减少 |
| --- | ---: | ---: | ---: |
| 首轮 | 29095B / $0.074238 | 28339B / $0.072726 | 756B / $0.001512 |
| claim 后次轮 | 31952B / $0.079952 | 31196B / $0.078440 | 756B / $0.001512 |

费率保持输入 2/输出 10，输出 1400，`JSON.stringify({messages,tools})` 字节加 1024 的原预留公式不变。仍不足以覆盖旧真实首轮 $0.015542 后的第二笔：净额只剩 $0.0701712，而这里仅减少重复副本的次轮预留仍约 $0.07844。这个结论只说明该窄候选不足，不证明所有新员工路径都不可完成；也没有用旧真实费用预测未来响应。

**冗余 claim 是实际多花一轮的候选，但不能直接跳过协议。** 原生 scheduler 已将任务置 claimed 并生成 attemptId，最新宿主快照也提供此凭证；真实 `5114bb4f-7ac4-413d-a80f-aceeace8bdec` 首个响应只调用 claim，native 工具返回同一已持有 attempt。已安装 `memberPersona` 的 Working rule 1 仍要求分派后先 claim，rule 7 仅对已有 open attempt 后收到 mail 免再次 claim。当前行为符合此指令。一个任意额外 prompt 叫模型忽略 rule 1 会制造矛盾。产品限定改善必须在官方 persona/执行指引入口，明确由宿主已完成本次 admission 的分支，并保留任务负责人、原生 taskId/attemptId、in_progress → complete 的状态门禁、stale attempt 拒绝、报告与权限规则；没有已持有当前 attempt 时仍照旧 claim。如果原生没有可替换此分支的公开 hook，先保留协议，只引导将合法 claim 与必要只读动作合并，不能移除原生工具或硬改已安装插件来节省一轮。模型是否实际合并仍需后续真实验证。

## 批准前零请求预检的可行边界

现有 `onRequest` 不是安全的只读预检入口：它发生在同步 `budget.reserve`、内存调用数增加以及产品 `beforeRequest` 费用登记之后。`ProductDshRuntime.start/execute` 也会创建归档、准备 executor、恢复工作区和启动运行；不应为了估算调用后再撤销。

最小实现是从 adapter 抽出双方共享的纯 packet prepare：输入真实 native 已 admission 的 options、固定 route、权限过滤后的工具 schema、只读预算视图与批准 task 输出上限，输出拟合后的 body、原/拟合 envelope 字节、保护组与原因、保守预留及 hash。正式 stream 仍紧接此函数同步 reserve；预检在 reserve、beforeRequest、onRequest、fetch 前停止，不能改变账本、费用/调用数、pending/uncertain 或真正运行状态。身份/run/task/90% retry/turn 等原规则仍需检查；纯预检不能用会 emit/warnings 修改活预算对象的 `ExecutionBudget.available`，应在隔离只读拷贝上调用，或抽取同源纯 admission 判定。

首轮 native preflight 可在新随机 scratch 构建**真实批准候选** team/任务，并用生产同一 mapper、admission refresh、工具过滤与上下文 policy。在 llm options 已包含当前员工+attempt 的 durable native snapshot 后，以硬阻断 fetch 的 adapter 只 prepare 一次并关闭 scratch；不需要 fake 回复，不注册产品收据、不启动真实 executor，也不复用本机执行 grants 做操作。必须核对完整 requirement SHA、全部 canonical task fields（包括新批准字段）、恢复来源/四文件 SHA、授权知识版本、最新费用/剩余调用数、source section 与 scratch session 持久化一致。初步等待任务分派的 snapshot 不能当成首轮通过。

首轮可以精确检查**候选已准备包**的输入与约束：messages、过滤后 10 工具 JSON schema、max_tokens、模型/费率、输出路径与验收 contract、保护文本及 SHA、预留金额。不同未来 run/team/attempt ID、审批前费用变化或配置版本变化，会使真实批准包不同；批准时必须重建或复用已固定候选并核对相同版本，现有实际 reserve 仍是最终门禁。不能将一次 scratch 的 body hash 承诺为所有未来实际请求的字节相同。

预检不能知道供应方实际 token、模型会选 claim/读取/写入还是测试、输出是否完整、测试结果、QA/review/经理费用。后续工具读取和写入必须完整真实内容，不能以短占位响应/低 fake fee 制造连续可行。后续本地检查应将旧真实 $0.015542 只列为敏感性场景，准确展示不可预留步骤及条件，不把全部风险隐藏在“首轮通过”。

主代理正在并行接入 `task.maxOutputTokens`。这会改变候选合同、budget feedback、请求 max_tokens 与预留；需等新的批准字段与 runtime 代码冻结后重新做**新 phase** 的零 fetch 首轮检查。本报告 1400 量化来自旧闭合捕获，不能冒充新 cap 验收。不能把任务累计 estimatedOutputTokens 当作单次 cap，也不能为了预检通过缩小允许生成完整文件所需的输出。

## 源码版本与未验证项

13:25～13:35，14 项前后哈希中的 12 项相同；adapter 与 budget-context 因其他代理正在接入批准单次输出上限而改变。这两项最新代码仍保留最新 snapshot/完整工具组保护和同步 fit→reserve，变化后的输出 cap 未在本次重新 native 捕获。app.ts 同样在并行修改，下面为 13:35 观察，不声明整体工作区冻结。

| 文件 | 13:35 SHA-256 | 本次边界 |
| --- | --- | --- |
| runtime/host.mjs | `f3b31b02808b90d3d889eed2800c3042052a8c5d6c418099238757c59fc7988e` | 前后相同 |
| runtime/employee-hosts.mjs | `4465d26a2dcb1afb0a1d6af371c9e8aa1e033c0088f65ac3b405861be097ce84` | 前后相同 |
| runtime/openai-compatible.mjs | `ad22a7a548d52d79063388291a3d7d90d95409819ef8e2f600a7e8662ef9800a` | 并行变更，见说明 |
| runtime/limits.mjs | `35b77fdda0df1d0076686079cf9c98fbe8f488cd852dae7eefc3731aa054a57e` | 前后相同 |
| runtime/budget.mjs | `780123a17a6cddda9e45ee4716434594deb01d193849dc9490401b8e710a35ad` | 前后相同 |
| runtime/budget-context.mjs | `51bfdc2dc1de81405ab689b8a1b652b6c0e012c8bbf0fa8e77f1e2252593588f` | 并行变更，见说明 |
| runtime/handoff.mjs | `3ac6a06abc854b6073b2ed236a6c58564716e9cc823e5c13fd08c51d067a2787` | 前后相同 |
| runtime/product-runtime.mjs | `f41ecc91e051800c8a8ff0b8b8fe5e8eacc879f1942ec624c2101687c22caad5` | 前后相同 |
| runtime/checkpoint-context.mjs | `fb82cd7d16405f2a7bfc21a8efa46a7b9b22358d22282dd618be4dde4ad400a3` | 前后相同 |
| runtime/product-tools.mjs | `6fd0e59c8cf3320640b23840da0c7944e4afcfa209441472e73501f81d9510a8` | 前后相同 |
| node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js | `257eb83c00a05ee068e9f4ba80ca71ab94e3a1275d24b7a0cf5038ff23dd0fd8` | 前后相同 |
| node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js | `c55121dd92e88783adc37a5f92e6c410304bae39796d1e67218b5fab8712bafc` | 前后相同 |
| node_modules/@nanmicoder/dsh-agent-teams/lib/scheduler.js | `421c012e6cdf6b8beb5562ef5439426538054d46f5aee8a5876fb9238bcfa515` | 前后相同 |
| node_modules/@nanmicoder/dsh-agent-teams/lib/tools.js | `2855e94e16859292e67bc41587963c0977d5cb4fd807ef4d0e7e18aed2eb058c` | 前后相同 |
| apps/api/src/app.ts | `70c84281e46c0a0dcdb7bc333fad53c025961f8a3a1aef1536d6c51f3dcde3b6` | 单次观察 |
| apps/api/src/execution-prompt.ts | `a1e7a96d0140910db5e8d36d53a4caa29c4430deaedefdd52381eec0cf3ac66e` | 单次观察 |
| runtime/employee-context.mjs | `c5a35c1f52d7023b83a6ee3dc54ad11e3281242d9ac3cff7d44c23b7b98db8f2` | 单次观察 |
| node_modules/@nanmicoder/dsh-agent-teams/lib/members.js | `11913193ef56d05faa9ef2660d89a92ca804679776e0515c5fa1d89865e86525` | 单次观察 |

adapter 开始 SHA 为 `74a261af64a95db9f25783c6a8f38144429c71e413befb6fa68c817e8383efb5`，budget-context 开始 SHA 为 `c64265f09350ea4ad6292072247180d4e5b9f228adc39a90f572f7a6eb856bff`；它们也是引用闭合捕获中实际旧 1400 量化来源。最终代码及构建由主代理另行验证。

已验证：保存请求 body SHA、上述精确字符串次数与字节、公共账本前后一致、已存在费用拟合的旧快照移除行为。静态发现：重复证据组累计和 persona 冗余 claim 指引。未实施/未验证：新的 Team goal callback、persona 分支、证据去重、产品批准前 preflight、新 task 输出上限 native 捕获。**真实 QA、review、经理与当前中转站端到端完成均未证明。** 最低风险下一步是完成共享只读首笔预检和产品限定引用的本地回归，再以完整真实输入和准确账本判断能否继续；本次不建议为了验证同一已知窄失败路径再支付请求。

