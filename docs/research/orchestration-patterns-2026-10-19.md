# 为伍编排方式扩展调研与采纳结论

日期：2026-10-19。用户要求：调研五种以上编排方式，分析合理性，合理者纳入为伍。本文更新先前“只保留三类”的建议；不把新增名称当作已上线能力。

## 结论

首批纳入接入设计 **7 种多智能体协作模板**：顺序交接、并行协作、专业路由、主管拆分、评审返工、分片汇总、多方案评议。原有简单交付继续保留，但不计入这七种。它们不是七套执行引擎，也不是七种互斥的数学拓扑；模板可组合，差别体现在任务分配、信息流、完成条件和验收要求。

采用现有 DSH AgentTeams 执行底座。优先复用其任务依赖、暂存批准、成员会话、消息和受限返工；研究 Profile/recipe 的公共接口，不增加第二套调度器、账本或员工工具注册。官方框架的实现可以作为隔离对照，但不能把一个 LangGraph/AutoGen 示例称为可直接安装到为伍的 DSH 插件。

本次只读核对官方网页、维护者仓库、已安装代码及已有证据，编写接入设计；没有安装插件、升级 DSH、修改生产代码、连接 JJ 改配置或调用付费模型。

本地审计基准为提交 `8fac1e1`，固定包 AgentTeams `0.1.20` / DSH `0.1.5-rc.1`。关键接口：`services/agent-runtime/host.mjs` 的暂存/lockPlan/成员深度、`rework.mjs` 的返工准入、`apps/api/src/handoff-checkpoints.ts` 的恢复边界，以及 `apps/api/src/collaboration.ts` 的跨部门展平组队。未运行新的执行测试，源码可表达不等于真实验收已通过。

## 模式的合理性与边界

| 模式 / 设计 ID | 适用业务与不同之处 | 首批采用的范围 | 风险与必要核对 |
|---|---|---|---|
| 顺序交接 `pipeline` | 明确前后依赖，如实现→QA→交付 | 现有 DAG；补版本化模板与匹配 | 等待前置成果；检查当前文件版本，不能仅看员工文字结论 |
| 并行协作 `parallel` | 不同专业同时工作，如技术调研、成本分析后汇总 | 不相依节点并行，全部必需分支完成后汇总 | 并行可能缩短等待，但不会自动减少 Token；禁止多个无序作者写同一交付文件 |
| 专业路由 `router` | 根据需求把工作交给合适部门/专业流程 | **执行前路由**，选定分支随方案确认、封存；不匹配时明确说明 | 首期不宣称支持运行中任意条件边；错误分流须可回退，路由不授予新权限 |
| 主管拆分 `orchestrator_workers` | 新业务的任务数和分工事先未知，由规划者生成 | **执行前动态拆分**，绑定已授权员工，再交现有运行器 | 不解除 lockPlan；不是员工可随时创建子团队或增加成员；角色选择与验收必须一起生成 |
| 评审返工 `review_repair` | 根据具体缺陷改进产物 | 先接受文件合同约束的 implementation/repair→review 链，轮数沿用批准值 0～2 | 不按文件扩展名限制，但必须有范围、真实核验命令与独立审查；普通 work 自动修订尚未支持 |
| 分片汇总 `map_reduce` | 对多个同类输入分别使用同一方法，如逐份审阅资料，再归并 | 批次输入在确认前固定；有界任务展开，允许员工分批处理多个节点 | 与专业并行不同：需证明分片无遗漏/重复、结果全部归并；输入太多必须拒绝或另分批，不能静默截断 |
| 多方案评议 `proposal_review` | 技术选型、故障假设、方案比较，需要不同意见 | 两位提出者先独立提出方案，再一次交叉质疑，由经理依据证据裁定 | 固定轮数；同模型/同资料可能产生相关错误，多数票不能代替事实、测试或用户决策 |

前五项的构件来自 [Anthropic 的工作流归纳](https://www.anthropic.com/engineering/building-effective-agents)。路由的业务边界参考 [LangChain Router](https://docs.langchain.com/oss/javascript/langchain/multi-agent/router)。分片展开参考 [LangGraph JS 的 Send 与工作节点](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)。多方案评议参考 [AutoGen 多智能体辩论示例](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/multi-agent-debate.html)；我们采用有界提案与复核，不照搬无限对话。

这里的适用性、成本风险和采用范围是针对为伍的工程判断，不是上游对我们产品质量的保证。Map-Reduce 是并行的一种专门结构，多方案评议也是可组合模板；保留单独名称是因为其输入和质量规则不同，不宣称互斥或穷尽所有模式。

## 暂缓成为默认执行方式

| 候选 | 为什么有价值 | 暂缓原因 / 开放前条件 |
|---|---|---|
| 多层主管 / 子团队 | 跨领域大项目可按层管理 | 当前恰好一名经理、最多六人、memberMaxDepth=0；先设计父子任务的权限、费用归属和恢复，不能把扁平跨部门借人称为递归团队 |
| 自主交接 / Swarm | 客服、工单可以随状态转交专业员工 | 需要明确唯一控制权、上下文交接、授权重新校验及停止条件；首期专业路由只在执行前完成，不冒充运行中交接 |
| 事件驱动 / 黑板 / 自由群聊 | 运维告警、长期协作可按事件唤醒 | 需要事件去重、游标、背压、唤醒预算和租约；现有消息/知识表不自动构成可靠事件执行器。事件触发属于另一维度，不强塞进本次七类模板 |

这些候选保留在后续目录，不因“有开源实现”自动开启。参考 [LangChain Handoffs](https://docs.langchain.com/oss/javascript/langchain/multi-agent/handoffs)、[AutoGen Swarm](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/swarm.html) 及 [Google ADK 多智能体](https://adk.dev/agents/multi-agents/)。

## 开源复用选择

| 来源 | 本次确认的内容 | 为伍的处理 |
|---|---|---|
| [DSH 插件市场](https://dshplugin.app/plugins) | 发现 AgentTeams、team-gui、Cortex，以及群聊/旁路审查线索；目录的 Manifest Valid 不是我们的集成验收 | 发现候选后回到作者仓库和安装包验证，不按目录标签承诺可用 |
| [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams) | 本地固定 0.1.20；命名 Profile、seed/captain、依赖调度、批准和原生返工。网页当前 README 已指向插件 0.1.25 与 Harness 0.2.1-rc.2 | 继续固定本地版本；逐项核对，不能把新版说明当安装版功能或静默升级 |
| [team-gui](https://github.com/toolclub/dsh-agent-team-gui) | recipe/团队定义、版本及有界调度；公开服务被维护者标为 developer-preview | 优先隔离验证公共 recipe/schema；版本管理可参考，整包调度不接管为伍现有运行链 |
| [Cortex](https://github.com/iguowz/dsh-cortex) | 之前固定 0.3.0 源码与隔离试验已记录；有策略匹配，但自带预算、执行与恢复体系 | 匹配结果只能当候选；不直接调用其 startTask 代替现有授权执行。本次未重跑其模型试验 |
| [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) | 顺序、路由、并行、动态工作节点和评估循环 | TypeScript 参考/对照实现；若 DSH 公共接口能完成则直接复用 DSH，不先加第二执行器 |
| [Google ADK JS](https://github.com/google/adk-js) | 有正式 TypeScript SDK；顺序、并行、循环和路由是可参考构件 | 不是 DSH 插件；仅对照必要行为，不同时接入另一套会话与运行生命周期 |
| [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/) | 官方提供顺序、并发、交接、群聊、Magentic；[编排 1.0 公告](https://devblogs.microsoft.com/agent-framework/agent-frameworks-orchestration-patterns-reach-1-0/)说明 Python/.NET 稳定接口 | 优先于已归档 AutoGen 作为后续语义参考，但不为增加模式迁移当前 Node/DSH 运行器 |
| [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html) | 图组件仍注明 experimental；[仓库 README 顶部](https://github.com/microsoft/autogen)本次明确写已归档、不再由 Microsoft 提供修复，与下部旧 maintenance 文案不一致 | 按顶部维护声明保守处理；只保留示例参考，不新增生产依赖 |
| [dsh-attention-group](https://github.com/cilarx/dsh-attention-group) | 有持久群消息、先路由后显式唤醒；README 验证版本为 DSH 0.2.1-rc.2，尚无 npm 发布 | 有价值的新线索，但当前 0.1.5-rc.1 不在所述验证范围；只登记，不安装或升级来迁就它 |
| [dsh-advisor](https://github.com/omdsh-dev/dsh-advisor) | 辅助模型观察每轮并给建议；当前配置/网页接口涉及 DSH ≥0.1.7-rc.1 | 可做未来旁路监督候选，不替代独立 QA；所有额外模型调用仍须接入现有费用链。尚未审查安装兼容性 |

上游网页是本次访问时状态；既有固定源码研究中的 team-gui 1.3.0、Cortex 0.3.0 不代表上游当前最新版本。个别固定提交 GitHub 页面本次返回工具读取错误，未把此前的静态审计描述为本次重新运行。未下载或执行这些仓库的代码。

[LangChain4j 黑板示例](https://docs.langchain4j.dev/tutorials/agents/#blackboard-agentic-pattern)说明共享中间结果与冲突选择的实现方向，但其 agentic 模块标为 experimental，且为 Java。它不构成为伍已有事件去重、持久唤醒或安全共享资料的证据。

安装版审计还确认：跨部门借用员工已经支持，其结果展平为同一 team；这与递归组织不同。当前返工恢复只接受独立复验通过的稳定检查点（`apps/api/src/handoff-checkpoints.ts`），半完成 repair/review 会拒绝恢复，不能承诺任意循环中途续跑。受控重启测试必须覆盖可恢复边界与不安全边界的明确拒绝。

## 接入顺序和验收

1. 建立七类版本化模板定义、适用/排除条件、运行器能力标记和依据；现有 simple/single 保留。每项区分设计采纳、隔离测试通过、真实验收通过，未通过不出现在可执行推荐中。
2. 在现有组织规划调用内检索和选择模板，再绑定具体员工与合同；确定性的 ID/引用由程序生成或校验。不能依赖一句“JSON mode”保证语义正确，也不能凭模板命中增加权限。
3. 先落地能展开成现有 DAG 的顺序、专业并行、固定分片、多方案评议，以及执行前路由/主管拆分；评审返工只接已支持的文件合同闭环。无法执行的通用循环、条件边与嵌套团队显示缺口。
4. 通过离线匹配、拓扑、权限、交付覆盖、文件冲突、版本和恢复验证后，再对每个开放模板做真实小任务。不能用固定模型响应测试代替真实方案与员工验收。
5. 以具体模板版本统计有效方案率、匹配正确率、错误执行次数、交付通过率、规划/执行各自耗时、Token、费用与返工。允许多种正确方案，不以唯一模板 ID 当真理；暂不承诺提速或省 Token。

真实验收前核对项目级预算授权。已有累计 $3.41 不是新实验随意分配的额度；本轮真实调用为 0。完整设计见 [七类编排模板接入设计](../superpowers/specs/2026-10-19-orchestration-pattern-library-design.md)。

## 当前状态

- 已完成：官方资料与当前代码调研、七类采纳/三类暂缓的分析、接入边界与验收设计。
- 未完成：新增模式的产品登记、页面、匹配与真实运行；当前生产枚举仍为 single/pipeline/parallel。
- 已有实测沿用原报告：2026-10-19 Word 顺序交接及受控重启通过，三类需求首次规划有效候选 0/3；本研究不修改该结论。
