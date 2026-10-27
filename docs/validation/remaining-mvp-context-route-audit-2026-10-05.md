# 原 v6 剩余验收路线：上下文减负只读审计

结论：**尚无已验证的安全付费推进路径。** 可以避免把三个开发文件正文全部装进 QA 请求，但现有 filesystem 全文协议连必读的 acceptance.test.mjs 都使保护最低超出余额。重复 team goal 的减负有明确收益，却不足以覆盖前序真实费用及后续知识、测试、复审和经理。

依据：[实际 fresh native 预检](fresh-recovery-native-preflight-2026-10-05.md)、[本次纯数据投影 JSON](../test-evidence/remaining-route-context-projection-2026-10-05.json)。本次仅读取已关闭 capture、原停止运行的任务合同和源码；没有新 Host、prepare、模型、运行、数据库连接、服务操作或员工文件修改。19 个源码 SHA 与该 native capture 一致。投影数据不是未来产品已经实现或实际模型会选择的输入。

## 哪些证据必须保留

原项目 cap $0.48、recorded $0.3664174、unknown holds $0.0278694、net $0.0857132；v6 已用21/37，QA verify 已用4/14。Sol/Luna 角色与原费率、Sol 1400 输出上限均不变。

QA 合同要求：先真实运行开发 Todo 测试，再读取并最小修复自己的 acceptance.test.mjs；实际 search/read 固定共享及 QA 私有 v2；独立 spawn CLI 验证 HTTP CRUD/400/404、非法 JSON/null、有界超时和清理；真实运行两条测试。复审仍由 QA 独立运行两条 CLI、读取固定资料并给出结论；Luna 经理核对真实证据、只读共享资料、写 acceptance-report.md。不能把旧开发8/8、经理文字或本地固定工具响应当成这三阶段已完成。

合同没有要求模型完整阅读 server.mjs、todo.test.mjs、README.md 三份正文。`HandoffGate.begin/assertInputs` 已在宿主绑定并核对全部输入 SHA；测试工具可真实运行这些输入，README 的 CLI 行为也可从实际启动输出核对。**宿主读取并固定版本，与 LLM 必须看到每行代码是两个条件。** 但修改已有 acceptance 文件目前必须先 filesystem 读取，再带旧 SHA 写入，不能省掉该读或猜 SHA。来源：[HandoffGate](../../services/agent-runtime/handoff.mjs)、[产品工具](../../services/agent-runtime/product-tools.mjs)。

宿主命令证明绑定整个 workspace revision。QA 改了 acceptance 文件之后，先前 Todo 测试证明不能代替新版本证明；最终两条验证须在全部写入之后运行，此后不再改文件。合并工具调用也须保证写入完成后才执行验证，不能假定多个工具或审批一定按数组顺序结束。

## 已测与反事实金额

| 范围 | 最低 envelope | 原算法预留 | 证据性质 |
| --- | ---: | ---: | --- |
| 新 QA 首包 | 29,474 B | $0.074996 | 实际 native prepare 允许 |
| 原生 claim 后 | 32,358 B | $0.080764 | 实际审计驱动 native prepare；前序没有收费 |
| 四文件完整结果后 | 53,430 B | $0.122908 | 实际审计驱动 native prepare 拒绝 |
| 只读 acceptance 完整正文后 | 36,867 B | $0.089782 | 已有结果删去三个非必选读操作的纯反事实；没有实际执行 |
| 仅 acceptance + team-goal 引用 | 33,937 B | $0.083922 | 未实现 formatter 的反事实；不含知识、测试结果或前序费 |
| 上项再无损编码 citations | 33,833 B | $0.083714 | 未实现 typed codec 的反事实 |

即使不读其他三文件，当前全文协议仍缺 **$0.0040688**，而且此前费用按0计算。team-goal 引用后也仅容纳此前累计费用 **$0.0017912**；若再发生旧真实单次 $0.015542，将差 **$0.0137508**。这些金额是原字节公式的单请求下界，不能累加成项目完成费，也不是预测真实 usage。

## 具体重复与可借鉴边界

1. **old assignment/snapshots 已被处理。** 首包 full envelope 37,969 B，当前 prepare 已删除8,495 B旧 assignment 整组。第三包的最低也已移除可删旧组。只清理旧快照或 claim 历史不能进一步降低这些已测保护下界。
2. **team goal 仍重复。** 原生 member persona 包含3,153 B全团队目标，其中当前 QA objective 又完整存在于受保护合同。仅把这段目标改成237 B的批准上下文引用，纯投影省约2,930 wire B/$0.00586；原生成员身份、10条工作规则、claim/attempt/in_progress/权限规则全部保留。引用尚未实现、更未原生验收。来源：[产品 team description](../../services/agent-runtime/product-runtime.mjs)、[固定版本原生 persona](../../services/agent-runtime/node_modules/@nanmicoder/dsh-agent-teams/lib/members.js)。
3. **claim/status 可做确定性输出视图。** claim 仍必须实际执行；当前原生协议要求 claim 返回 attempt，不能简单跳过。若已证实当前合同及依赖证据完整出现在本次批准上下文，可让模型视图保留 task/actor/attempt/status、合同与版本 SHA、必要依赖结果，重复文字用明确引用代替。status 可投影角色所需节点状态与审批/失败字段。原完整返回仍须归档，宿主/网页和内部消费者保持原语义；不能在 adapter 中静默改写正文。这可降低某些中间请求，**不能消除当前必读文件后的最低**。
4. **citations 不宜盲合并。** 当前恢复7项引用有6个不同 document/version/title/SHA 元组。按完整元组做无损字典、可精确往返后，才只省104 wire B/$0.000208。只按 documentId 去重会丢不同版本或内容；这项收益很小。
5. **唯一批准需求/合同不可删。** department section 13,723 B，其中需求4,627 B、合同1,857 B、恢复5,336 B。完整需求没有另一份位于当前 system，不能拿“重复上下文”名义删掉。固定知识版本、私有授权、四文件 seals、未知费用和当前预算必须继续明确可核对。

## 最小修复顺序（建议，未实施）

**产品限定 team-goal formatter 仅列为后续建议。** 仿照现有 compact teamTaskPlan，只有宿主能证明最新完整需求、当前合同、权限及恢复信息已绑定并将持久化时，才使用引用；显式启用却缺少断言、返回 false 或 Promise 时必须拒绝，未启用则保持原默认，不改通用 DSH persona。新增 native 首轮、恢复、经理/QA隔离和 archive==model input 回归，重新做零费用 prepare。它是局部低风险优化，但目前不能独自解决剩余路线。本轮未实现该 formatter 或下面的范围读/patch。

**再评估同名工具的显式范围读与 CAS patch。** filesystem 可选择有限行区间，明确 full-file SHA、实际范围和 `complete:false`，不得冒充全文；artifact_write 可支持唯一匹配的局部 patch，仍只允许原声明输出 acceptance.test.mjs、员工原权限、已读版本和预期 SHA。保留完整旧文件/操作档案；版本冲突、匹配不唯一或结果未知时拒绝，不盲重放。这样员工能真实修原测试，输出也无需重复整份5877 B文件，1400输出不变。不能用 terminal_test 暗中写文件绕过写工具或把省略正文标成完整读。

这需要 native 工具 schema、输入绑定、LocalRunExecutor/设备端、镜像版本、恢复和审计共同测试。它保持原文件授权范围，但当前并未实现；新增字段也增加 schema 字节。必须先用隔离原生首包及最小必选 QA 序列验证真实输入，再考虑付费；仅凭合成短 packet 不能放行。

原四文件整批读取失败路径不应再尝试。即使上述优化通过，知识读取、当前 CLI 结果、员工修复、独立复审及经理仍会消耗金额和次数；目前不能宣称原余款足以完成全 MVP。

## 本轮转向：候选规划必须保留什么

本轮先修规划入口：GET 只读核对精确预留，POST 只生成待确认候选，用户确认后才保存方案。已补独立[只读历史模块](../../apps/api/src/planning-execution-context.ts)与[11/11 隔离回归日志](planning-execution-context-2026-10-05.txt)；根代理负责接入规划输入及真实 GET 验证。本模块不改原计划，也不自动迁移检查点。

实际冻结 DAG 为：

| 节点 | 归属与前置 | 候选/预算修订必须保留 |
| --- | --- | --- |
| dev | Luna 开发，前置空；已验收完成，已用14/14 | 三份员工文件、真实 Todo 测试证据、接受的 attempt 与 SHA；不能再次分派或仅因文件存在就标完成 |
| qa_verify | Sol 独立 QA，前置 dev；未完成，已用4/14 | 先真实开发测试、只修 acceptance.test.mjs、固定共享和私有 v2 search/read、真实 CLI CRUD/400/404 与异常/超时/清理、两条验证命令 |
| qa_review | Sol 独立 QA，前置 dev、qa_verify；reviewedTaskId=dev | 独立复审及两条真实 CLI、固定资料引用、客观 pass/fail；不能并入开发或用文字跳过 |
| manager | Luna 经理，前置 qa_review | 从最终文件/宿主交接/真实终端证据写 acceptance-report.md；只读共享资料，不授予 QA 私有资料 |

每条保存合同的 objective、acceptanceCriteria、dependencies、assigneeId、kind、inputs/producerTaskId/SHA、outputs、inScope/outOfScope、verify、reviewedTaskId、返工绑定/上限及全部原限额字段都须完整保留。独立模块按当前 `taskSchema.shape` 的全部字段比较，只忽略生成的 runtime taskPrompt/assignee；完整需求必须另外传入，不能以恢复摘要替代。若候选改变合同、角色/模型/权限、知识固定版本或需要新增交付，网页应列出差异并再次确认，不能借“预算修订”静默修改已批准 v6。

规划输入同时传入当前保存方案、最新闭合运行身份、已核实完成节点、当前四文件 seals、21/37 真实调用数、QA $0.08356/4 次、全部原项目费用与两笔未知预留。按 taskId 无法归属的费用/调用须单独标明，不猜归属；旧 v5 费用仍占原 $0.48，不能因新候选/新版本重置。原 v6 无显式 task.maxOutputTokens，仍保留 Sol 路线1400。AI 的预计 token 数是估计，不能自行编造任务硬上限来宣称预算足够。

候选确认事务须核对原项目版本/需求/完整计划指纹，重新读取最新费用状态与执行校验；候选生成已消费的金额也要扣除。费用变化不能当成获得更多预算，旧 quote 不是预留凭证。保存新方案不是恢复执行，跨版本复用已完成开发必须另有宿主检查点校验及明确批准；当前模块只提供证据，**没有实现跨版本自动继承**。缺失/坏档案明确 unavailable；可另做完整新计划，但不得声称旧完成已迁移。原成果、版本与账单历史继续保留。

原运行完整目录：`C:/Users/JJ/Desktop/la/agent_department/.data/local/runs/5114bb4f-7ac4-413d-a80f-aceeace8bdec/`。下列 SHA 来自[真实只读预检 JSON](../test-evidence/fresh-recovery-native-preflight-compact-fresh-with-readonly-results-2026-10-05.json)，均在 `artifacts/`：

| 文件 | SHA256 |
| --- | --- |
| acceptance.test.mjs（固定输入，尚未完成验收） | 509af23a1d5b21f2e8b7f80551a95caee6345b3124c9f686f5b1f4d68905df92 |
| README.md（已验收开发产物） | a29cbd3ab39b804579e8d527b7b329b5220819235039f80f4298d5f97335e1f1 |
| server.mjs（已验收开发产物） | 109f638d709e33dc3fc2c59b52c9baf3e764bc6e1cee320b38cc1cdda9996708 |
| todo.test.mjs（已验收开发产物） | c9f014721736b476abd2a0433b511242f442d132bce52c45aafb147a37b0f90e |

只读首包 $0.074996 以及单独 acceptance 完整结果后的 $0.089782 下限，都只描述一个具体请求。后者还是反事实子集而非实际运行，当前已超原净额；两者均未覆盖后续费用或保证 QA→复审→经理完成。真实 v6 本轮不再发送请求。
