# 原 v6 剩余预算与恢复准入：只读审计

2026-10-05 14:50（Asia/Shanghai）。**当前没有已证实能在固定 $0.48、原 v6 全合同、Sol 输出 1400 和完整独有证据下完成 QA→review→经理的费用路径。首笔可预留不等于整链可付；也不能由此宣布所有合法员工路径数学上不可能。** 本次仅公共 GET、源码与已保存闭合捕获只读，没有模型请求、新 run、原 DB、凭据、员工文件或服务操作。研究任务接续前先保存此结论。

## 当前权威状态

14:41:44.220 与 14:50:28.344 GET `/api/projects/dde78f91-2a99-4a63-a9fa-5cb7bab2b8f0/cost-readiness` 均 200，金额与两条收据逐字段相同：recorded $0.3664174、held $0.0278694、net $0.0857132、pending 0 / uncertain 2。默认恢复仍 COST_PENDING；先前明确 opt-in 的 retained unknown 路径只能扣住上述全部金额，不能转为 0 或已结算。

14:42 与 14:47 GET `/api/runs/5114bb4f-7ac4-413d-a80f-aceeace8bdec` 确认最新运行 failed、integrity ok、111 事件，方案 v6：
- 唯一 actual wire seq 60：28777B，reservation $0.073602，Sol max_tokens 1400。
- 唯一新 usage seq 89：input 7501 / output 54，$0.015542，收据 `7f882dba-d0c9-40e8-9c14-da54c52b349f`。
- 第二笔仅 raw model/request seq 101；run/finished seq 111 是 BUDGET_CONTEXT_LIMIT，精简前 67271B/$0.150590，输出仍 1400。没有第二笔 wire。
- 已恢复 dev completed（seq 30），t2 QA failed、t3 review pending、t4 manager pending；0 QA tool approvals、0 新 quality/handoff accepted。唯一 runtime operation-start 为 `local_workspace` 准备，不能写成“完全无操作”或员工执行了测试。
- snapshot.budgetHistory.calls=20 是批准时的入场前历史，加本运行 1 次后当前 21/37；QA 当前 4/14。不能把入场 snapshot 的 20 当成当前调用数。
- 全 approved task SHA：`2400dcdda46c68bf92f20f3df4e9a5475935a8f5d77ad39b35510db1d9256649`；完整 requirement SHA：`839bed6bc6ef0efa722e577ff62376baa78c0d6996ef73c8501e31eb12b31de7`；snapshot SHA：`bc177fc10da8a4617bd897780f2756a9f8c9d97416e345af85d1584fa775c4b9`。四个 task 均无显式 maxOutputTokens，原 pinned Sol route 为 1400，Luna 为 4600。新支持此字段不会自动给旧合同添加低 cap。

已关闭 [source audit](../test-evidence/fresh-resume-budget-first-sol-claim-source-audit-2026-10-05.json)、[compact probe](../test-evidence/fresh-resume-budget-first-sol-claim-compact-probe-final-2026-10-05.json) 和 [旧费用敏感性](../test-evidence/fresh-resume-budget-first-sol-claim-compact-source-fee-final-2026-10-05.json) 保留。compact 后原 1400 首笔 29095B/$0.074238；claim 后保护最低 31954B/$0.079956。在旧真实 $0.015542 的条件下新净额 $0.0701712，仍拒绝；小 fake usage 通过仅验证形状，不能证明预算。更完整重复分析见 [前次只读报告](request-context-duplication-review-2026-10-05.md)。

## “恢复最新会话”是否使用新源码

产品 `POST /runs/:id/retry` 克隆旧批准 snapshot，核对原档案完整性、unknown operations、handoff seals/实际文件版本，重建 checkpoint context 与当前费用/调用历史，然后创建**新 child run**。ProductDshRuntime 使用新 run 目录，createCaptain、新建 team、当前 teamTaskPlan mapper，再 restore completed checkpoints；不调用 resumeCaptain，不复制旧 QA 原生会话表面来续跑。若再次从 1e6 恢复，幂等分支会返回已有 5114；要建立新的 child 必须以最新 5114 为源。

在**已加载新源码的进程**中，fresh child 能使用当前 host、mapper、adapter、工具过滤；同时保留原合同与原 route cap。直接 cold-resume 旧 native session 则打开旧 JSONL，并保留旧 system/history/task records；新代码中的 mapper不会自动重写旧 team/task.description。最新旧 t2 已 failed，原 run 已停止且不存在可用于新 reserve 的原有效租约，所以直接续旧 session 不能当成合法、便宜的产品恢复替代。

本地 launcher `scripts/local.mjs` 用 `node --import tsx scripts/local-api.ts`，没有 watch；local-api 与 coordinator 静态/一次 import runtime，同 URL 的 ESM/plugin 动态 import 也会缓存。修改磁盘源码、新建 run 或 Vite 刷新网页都不能证明 API 内存用了新版本。GET /api/health 仅报告 version 0.2.0 和 ready，无 loaded source SHA。主代理需以受控启动记录/实际 loaded source 指纹证明加载；本次没有重启或将磁盘 SHA冒充服务 loaded SHA。

## 零付费 prepare/preflight 必须覆盖

1. **产品准入**：最新源/归档 integrity、原 project+version+全任务合同 hash；无其他 active run；完成节点/全 DAG/文件 handoff seals；unknown native 副作用门禁；授权 device/grant 和模型配置 fingerprint；pending 始终阻断；uncertain 显式保留原 hold；当前 ledger/原预算/每任务金额与调用历史、90% retry、daily/department caps。纯 API preview 不能替代批准事务或最终 reserve 租约。
2. **原生准入**：durable team/member 存在并活跃、当前 employee/task/attempt 真实绑定、claimed/in_progress、依赖节点完成；等待分派/已移除/failed/stale attempt/错误 cwd 不能作为首轮候选；完整最新 host context 必须在 await native admission 后刷新并合法归档。
3. **请求形状**：真实 native assembly 与持久化 section、原 requirement、canonical task、固定 recovery 来源/四文件 SHA、知识版本权限、正确路由/工具白名单和完整 schemas；当前 snapshot+latest assistant/tool group、checkpoint、唯一文件与知识证据保护；max_tokens=min(options,route,批准 task cap)，旧 v6 仍 1400；原 UTF-8 JSON+1024 和费率不变。
4. **副作用边界**：prepare 发生在 budget.reserve、product beforeRequest、onRequest 和 fetch 前；不得创建真实 run/receipt、增加 calls/reserved、改变 unknown、执行员工工具或复用 grants。新 budget.peekAvailable 已是同源无 emit 判定，可用于隔离 preview；它不是 admission ticket。正式 prepare→reserve 必须仍同步，不允许预检通过后绕过实际重新核对。
5. **证明能力**：只能证明具体冻结候选首笔 body/保护内容/输出约束与预留；新 run/team/attempt ID、并行账单或配置变化需重核。首笔预检无法预测实际模型响应、连续 full-file/tool groups、真实测试/复审/经理成本，也不能采用占位工具文本或假低 usage 承诺完成。

## 下一步选择

首选：在当前源码冻结并确认服务加载后做共享纯 prepare 的**新 phase、零 fetch** 首笔检查及真实工具内容的有界本地敏感性；保存完整合同/权限/最新 session vs trace vs candidate hash。不得为同一已知 claim 失败路径再付费。准确核对历史 unknown 可以释放被证明未发生的额度，但不能自行当 0，亦不能清除调用历史。

产品限定去重可作为开发方向：只去除已被完整当前合同覆盖的重复说明；严格同版本、完整内容、同授权的重复只读工具组才可候选移除，其他 unique/versioned evidence 均保留。原生 claim/状态/权限协议不能被随意剪掉。这项尚无新的生产连续 QA 验证。

若零请求验证仍不能在当前净额支付下一步，保持运行停止并交付准确未完成状态；需用户重新选择合同/预算方案的事情单独说明，不能在原 v6 静默变化。本次没有请求提高预算、降低 1400 或改合同，也没有将未完成写成验收通过。

## 观察源码 SHA（14:46，磁盘版本）

源码正在由其他代理并行完善 prepare/output cap，以下为实际只读观察，不是整体 freeze 或已加载服务承诺。
- apps/api/src/run-management.ts: `34b19cebdfa6eb38044b560631bc1f46c88bff3b462b814e8fc0dc0abc919b0c`
- apps/api/src/run-coordinator.ts: `8398bba0859a8e40639bc7dfc67fc5d1f7b6818defed9ebf308c2db855eaf7d9`
- apps/api/src/app.ts: `70c84281e46c0a0dcdb7bc333fad53c025961f8a3a1aef1536d6c51f3dcde3b6`
- scripts/local.mjs: `b08683b2d6e1d890cce7752e1055633b24ff39702b45db84edcc4c55a0a92d6d`
- scripts/local-api.ts: `967a0856c617d002318c205c2ac2edba2eb34577bd4a198458ed603b487b9d6f`
- services/agent-runtime/product-runtime.mjs: `f41ecc91e051800c8a8ff0b8b8fe5e8eacc879f1942ec624c2101687c22caad5`
- services/agent-runtime/host.mjs: `f3b31b02808b90d3d889eed2800c3042052a8c5d6c418099238757c59fc7988e`
- services/agent-runtime/employee-hosts.mjs: `4465d26a2dcb1afb0a1d6af371c9e8aa1e033c0088f65ac3b405861be097ce84`
- services/agent-runtime/openai-compatible.mjs: `ad22a7a548d52d79063388291a3d7d90d95409819ef8e2f600a7e8662ef9800a`
- services/agent-runtime/budget.mjs: `561d6d662dcb7b5f3bd5639c58a92d80c9a352d51250fd48175a9e22992b7e83`
- services/agent-runtime/limits.mjs: `35b77fdda0df1d0076686079cf9c98fbe8f488cd852dae7eefc3731aa054a57e`
- services/agent-runtime/checkpoint-context.mjs: `fb82cd7d16405f2a7bfc21a8efa46a7b9b22358d22282dd618be4dde4ad400a3`
- services/agent-runtime/handoff.mjs: `3ac6a06abc854b6073b2ed236a6c58564716e9cc823e5c13fd08c51d067a2787`
- services/agent-runtime/employee-context.mjs: `c5a35c1f52d7023b83a6ee3dc54ad11e3281242d9ac3cff7d44c23b7b98db8f2`
- services/agent-runtime/budget-context.mjs: `d1ad3d0ccdea2863402e3fc6d0a49071ec998fac620495e998ada5b369c78c05`

