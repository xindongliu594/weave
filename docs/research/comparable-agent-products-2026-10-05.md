# 三个同型开源方案：对“为伍”MVP 的可借鉴范围

核验日期：2026-10-05。范围限定为 OpenHands、LangGraph JS、CrewAI 三个候选，使用官方仓库、许可证和官方文档。本次没有安装、克隆仓库、创建运行、读取凭据或发送模型请求；Windows 运行、中转站工具调用兼容和中断恢复均未在这些产品上实测。下文“已核实”指来源内容已核实，“适配成本”是基于当前 Node/TypeScript/DSH/PGlite 架构的工程判断。

结论：**需要可单独使用的代码执行网页，优先隔离评估 OpenHands Agent Canvas；需要在现有架构内借鉴可靠 DAG 恢复，优先 LangGraph JS 的 checkpoint/interrupt 设计。CrewAI 值得参考员工与经理编排，但引入 Python 服务和新的恢复契约，迁移成本更高。没有找到这三个候选可直接作为现有 DSH 插件安装的官方声明。** 不能把换框架作为原项目剩余费用可完成的证据。

## 形态与许可证

| 候选 | 已核实形态 | 许可证范围 | 与当前项目的关系（工程判断） |
| --- | --- | --- | --- |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 当前主仓库是 Agent Canvas，本地网页控制中心；执行层为独立 [Software Agent SDK](https://github.com/OpenHands/software-agent-sdk) / Agent Server。Canvas 自己有插件目录 | [Canvas MIT](https://github.com/OpenHands/OpenHands/blob/main/LICENSE)、[SDK MIT](https://github.com/OpenHands/software-agent-sdk/blob/main/LICENSE) | 独立产品可先隔离体验；通过 REST/事件接口接入“为伍”则需明确员工、合同、审批、账本与产物映射。属于较高成本集成，不是装一个 DSH 插件 |
| [LangGraph JS](https://github.com/langchain-ai/langgraphjs) | JS/TS 编排框架；checkpointer 为可安装库；官方另有 [Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui) | [核心 MIT](https://github.com/langchain-ai/langgraphjs/blob/main/LICENSE)；Agent Chat UI 仓库也标 MIT。不能由此推导托管服务和全部附属组件采用同一条款 | 与现有 TS 栈接近；借鉴 checkpoint 模型成本较低，替换 coordinator/runtime、迁移旧运行与账本仍是较高成本工作 |
| [CrewAI](https://github.com/crewAIInc/crewAI) | Python 多 agent 框架，Crews 负责角色协作，Flows 负责事件流程；AMP 为另行提供的商业控制平面 | [开源框架 MIT](https://github.com/crewAIInc/crewAI/blob/main/LICENSE)；AMP 不能当成此 MIT 仓库内的本地成品 | 角色和经理语义接近；需要 Python 桥接、产品 API、网页与旧数据恢复适配，成本较高 |

以上许可证只核查对应文件，复用时保留各仓库版权及许可通知，并另核对实际选定依赖。商业控制平面与开源框架的区分来自 [CrewAI 官方 README](https://github.com/crewAIInc/crewAI)。

## OpenHands：最接近独立网页产品，但当前版本边界必须区分

**Windows 与网页已核实。** 当前官方 Windows 指南提供 Docker Desktop + PowerShell 的单容器路径；按会话单独创建容器的方式要求在 WSL2/Linux 内运行 Canvas，该模式明确不支持原生 Windows host。当前主仓库 README 展示 Canvas 1.24.0 镜像和本地 Node 24+/uv 安装路径。旧 `openhands serve` GUI、CLI 网页和当前 Canvas 是不同入口，不能混用旧镜像教程。来源：[Windows 指南](https://github.com/OpenHands/OpenHands/blob/main/README.windows.md)、[当前仓库](https://github.com/OpenHands/OpenHands)。本机未验证上述安装。

**中转站配置入口已核实。** Canvas 的 LLM Profile Advanced 页允许填写模型 ID、base URL 和 Key；OpenAI-compatible 示例使用 `openai/<served-model-id>`。URL 必须从后端可达，Docker 内的 localhost 与 Windows 主机不是同一网络地址。该能力说明可配置兼容入口，不保证本项目现有中转站的所有模型、usage、缓存计费和请求 ID 均兼容。来源：[当前 LLM Profiles](https://docs.openhands.dev/openhands/usage/agent-canvas/llm-profiles)。

**审批与恢复已核实。** SDK 提供 AlwaysConfirm、NeverConfirm、ConfirmRisky，以及等待确认和拒绝 pending actions 的接口。持久化使用 conversation ID + persistence directory，保存 base state、增量事件、工具结果和使用统计，并可在另一个进程重建会话。来源：[行动确认](https://docs.openhands.dev/sdk/guides/security)、[Conversation 持久化](https://docs.openhands.dev/sdk/guides/convo-persistence)。这些会话能力尚不能证明“为伍”批准合同、完整 DAG、四文件版本、部门预算和未知外部操作在迁移后全部成立。

**员工执行与插件已核实。** SDK 的 Terminal/FileEditor 等工具可执行软件工作；TaskToolSet 可创建专用子 agent、保存其对话并以 task ID 恢复，但该工具的语义是顺序阻塞委派，不能据此称它自动实现本项目 DAG 的并发及已完成节点去重。Canvas 插件 UI 管理技能、MCP、hooks、commands 和 agent definitions，插件作用域属于其后端。来源：[SDK 仓库](https://github.com/OpenHands/software-agent-sdk)、[TaskToolSet](https://docs.openhands.dev/sdk/guides/task-tool-set)、[Canvas 插件](https://docs.openhands.dev/openhands/usage/agent-canvas/plugins)。OpenHands 的插件机制不等同于 DSH 插件 ABI。

**最小借鉴范围（判断）：** 借其动作确认预览、会话事件/状态分离、后端工作区隔离和子 agent 履历展示。若以独立产品试用，应使用新的隔离工作区和独立验收计划；不得把现有原数据目录挂载为实验写入目标。对当前 MVP 不建议在费用已紧张时直接替换执行器。

## LangGraph JS：最值得参考的持久流程语义

**本地与网页已核实到框架层。** 官方 JS 安装页提供 npm 包；框架本身不是开箱即用的部门项目网页。Agent Chat UI 是可本地运行的 Next.js 界面，连接具有 messages state 的 LangGraph server。它仍需后端、graph ID、权限和产品视图；“已有聊天 UI”不能当作“为伍”主流程已实现。来源：[JS 安装](https://docs.langchain.com/oss/javascript/langgraph/install)、[Agent Chat UI](https://github.com/langchain-ai/agent-chat-ui)。Windows 原生沙箱、路径及所选 SQLite 驱动未实测，不能仅凭 JS 宣称全部 Windows 支持已验收。

**模型兼容配置已核实。** LangGraph 不限定单一模型提供商；对应 JS ChatOpenAI 集成允许 `configuration.baseURL`，并针对不支持 streaming usage 参数的代理提供 `streamUsage:false`。来源：[JS ChatOpenAI 集成](https://docs.langchain.com/oss/javascript/integrations/chat/openai)。模型 Key、请求 ID、安全过滤、精确账单匹配及保守预留仍需宿主负责；本次未连接本项目中转站。

**恢复机制已核实。** 持久 checkpointer 配合 thread_id/checkpoint_id 保存每个 super-step 的状态；同一 super-step 中其他成功节点的 pending writes 可在一个节点失败后保留，恢复不重跑这些成功节点。官方有独立的 `@langchain/langgraph-checkpoint-sqlite`、Postgres 等实现；MemorySaver 只在 RAM 中，进程重启后丢失。`durability:"sync"` 在进入下一步前等待 checkpoint 写入。来源：[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Persistence 的重启说明](https://docs.langchain.com/oss/javascript/langgraph/persistence)。应选择持久实现并进行断电/重启和旧版本迁移测试，而非用 MemorySaver 演示代替。

**审批与重放边界已核实。** interrupt 可暂停，Command resume 传回用户决定；恢复会从发生 interrupt 的节点开头再执行。官方明确要求 interrupt 之前的副作用具备幂等性，或拆到批准后的独立节点。子图也有相同重入边界。来源：[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)。所以“有 checkpoint”并不证明一次费用不明模型请求或 terminal 外部操作不会重发。

**最小借鉴范围（判断）：** 把开发、独立测试、复审、经理验收视为小而明确的节点，将批准节点与执行副作用分开；状态保存 canonical 合同、已完成 checkpoint、输入/产物 SHA、知识版本和 ledger 引用，由宿主按需构造请求。可先对照现有 coordinator 做局部持久化检查，不必新增一套运行引擎。若真正引入，必须避免 PGlite 与新 checkpointer 双写后产生两个互相矛盾的真相来源。

## CrewAI / Flows：团队语义相近，当前已有真正 checkpoint

**Windows、模型和团队已核实。** 官方安装页提供 Windows uv 路径，要求 Python >=3.10 且 <3.14，并列出部分 Windows 编译依赖问题。LLM 可设 base_url 连接 OpenAI-compatible 服务。Hierarchical process 可由 manager 分配任务、校验结果，工具可按员工或任务配置。来源：[安装](https://docs.crewai.com/v1.15.23/en/installation)、[LLM 连接](https://docs.crewai.com/v1.15.23/en/learn/llm-connections)、[经理流程](https://docs.crewai.com/v1.15.23/en/learn/hierarchical-process)。这些是框架接口，不是本机实际测试。

**工具执行有具体范围。** `allow_code_execution` 默认关闭；启用后文档示例主要通过 CodeInterpreterTool 执行 Python，需要 crewai_tools。不能把此开关直接等同于 Windows 上创建并运行本项目 Node Todo API。来源：[Coding Agents](https://docs.crewai.com/v1.15.23/en/learn/coding-agents)。本项目的 Node CLI、文件权限、网络与进程退出证据仍需专用工具适配。

**恢复不能只参考旧 @persist 教程。** 当前 v1.15.23 官方文档提供 CheckpointConfig/from_checkpoint，说明恢复完整运行状态、跳过 completed tasks、复用其输出；有 JsonProvider 和 SqliteProvider，可选择 task_completed 或更细事件。自动事件触发写入失败时会记录错误并继续运行，手动 checkpoint 调用则抛出失败。来源：[当前 Checkpointing](https://docs.crewai.com/v1.15.23/en/concepts/checkpointing)。对于“下一节点只能在数据安全落盘后执行”的验收标准，需要宿主强制持久化成功；不能仅开启 checkpoint=True 就声明达到。

@persist Flow state 的 hydrate/fork 与 from_checkpoint 是两个状态系统，不能混用；官方示例展示加载旧 counter 后再次执行 start 方法，缺少目标 state 时可回落默认行为。来源：[Flow State Management](https://docs.crewai.com/v1.15.23/en/guides/flows/mastering-flow-state)。应锁定实际安装版本并核验恢复语义，不能把状态值存在 SQLite 当成已完成工作必然不重跑。

**网页审批需要应用接入。** human_feedback 默认等控制台输入；非阻塞 provider 可保存 pending context，随后 from_pending/resume，经应用 API 接收用户反馈。使用 emit 将自由文本转为批准/拒绝时，文档会调用 LLM 解释反馈；“为伍”的明确确认按钮应映射为确定性的用户决定，避免另一次付费解释。来源：[Human Feedback](https://docs.crewai.com/v1.15.23/en/learn/human-feedback-in-flows)。官方文档索引列出 CopilotKit/AG-UI 前端接入，但本次该 overview 正文抓取失败，**前端细节未核实**，也没有本机安装验收。来源：[官方索引](https://docs.crewai.com/llms.txt)。AMP 是另行商业控制平面，不能据此声称开源仓库自带完整本地网页。

**最小借鉴范围（判断）：** 借员工/经理角色、确定性 Flow 事件路由和 task_completed checkpoint 展示。为了当前 Node/DSH/PGlite 主流程增加 Python sidecar，收益尚不足以抵消维护、权限和恢复映射成本，不建议作为这一轮 MVP 的直接切换。

## 三者都不能替代的本项目边界

下列是产品验收要求及本次来源覆盖范围判断，不是宣称这些框架无法自定义实现：

1. **不明费用核对。** 已持久化供应方 request ID、原收据 history、已结算费用和 unknown hold 必须仍由产品账本负责。框架 usage/metrics 或剩余额度差不能单独证明某条超时请求收费为 0；本次来源未提供可直接适配 New API 的单请求账单核对保证。
2. **未知外部操作。** checkpoint 无法与第三方写入形成跨系统原子事务。恢复前须保留 operation ID、已知结果和未明结果；明确未执行才能重放，或者使用供应方支持的幂等键与查询，不能靠模型再次回答来“确认”。LangGraph 的官方重入规则尤其说明此边界。
3. **批准版本与证据。** 用户确认后的 canonical 团队/DAG、员工工具权限、四文件 SHA、知识授权/版本、独立测试与经理接受事件属于“为伍”契约，不能由通用会话导入或未验证的自动摘要取代。所有历史运行与失败记录继续保留。
4. **原预算。** 当前原项目 $0.48 cap、截至 14:50 的 recorded $0.3664174 / unknown holds $0.0278694 / net $0.0857132 见 [只读预算审计](../validation/original-v6-safe-budget-path-audit-2026-10-05.md)。三个产品的存在都不能证明余款足以完成 QA→review→经理；同样不能用更低 fake usage、丢证据、缩减原 1400 输出限制或重新建项目清空费用来证明完成。

## 建议下一步与未验证项

当前最小行动是保留现有运行器与账本，从 LangGraph 的持久写入/interrupt 规则和 OpenHands 的确认预览借鉴局部设计；继续把无付费 prepare/preflight 作为原合同下具体请求的检查，而非整条交付链的费用承诺。若另开独立成品比较，优先 OpenHands 的 Windows Docker/WSL 隔离评估，使用新的目录和明确的预算/审批测试，不迁移原数据。

本次仅完成资料调研：三者的 Windows 安装、中转站真实工具调用、突然终止后文件/费用/节点恢复、敏感信息过滤、独立 QA/经理验收和备份恢复全部**未实测**。未安装任何插件，也未修改业务源码或服务。DSH 自身插件市场属于主代理的另一个调研分工；本报告不把其他产品的 MCP/skill/package 目录冒充 DSH 市场。

## 追加：两个 DSH 插件（2026-10-05）

按用户后续调研范围补充以下维护者源码检查。它们是 DSH 插件，不是前三个成品/框架的替代名称。本节版本来自仓库当前 manifest，**未核验 npm 实际发布包，未安装、调用模型或修改原数据**。

| 项目 | 核实版本与许可 | 主机要求及当前适配判断 |
| --- | --- | --- |
| dsh-cost-meter | 仓库 manifest 1.8.11，MIT | 声明 DSH >=0.1.0-rc.5、Node >=20、win32 支持；客户端平台为 web。声明范围可覆盖当前 DSH 版本，但尚未验证“为伍”自定义主机及 React 网页接入。 |
| @mstar-harness/dsh | DSH 包 manifest 3.11.2，MIT | 关键 DSH peers 要求 ^0.2.0-rc.2、Bun >=1.4.0，并注入 DSH Web 会话、连接和侧栏服务；与本仓库固定 0.1.5-rc.1 不一致，不能直接认定兼容。 |

版本和许可来源：[cost-meter manifest](https://raw.githubusercontent.com/Han-1413141/dsh-cost-meter/master/package.json)、[cost-meter MIT](https://raw.githubusercontent.com/Han-1413141/dsh-cost-meter/master/LICENSE)、[mstar DSH manifest](https://raw.githubusercontent.com/btspoony/mstar-harness/main/packages/dsh/package.json)、[mstar MIT](https://github.com/btspoony/mstar-harness/blob/main/LICENSE)。本地版本核对仅读取 [agent-runtime/package.json](../../services/agent-runtime/package.json)，没有读取正在使用的凭据或数据库。

### dsh-cost-meter：usage 记账与余额展示，不能替代金额硬门禁

维护者将它定位为 DSH Web 会话费用插件，提供价格配置、预算进度、缓存费用和余额查询；安装进入 `web` profile，主机重启后加载。它的插件侧栏不会自动成为“为伍”现有费用页。来源：[README](https://github.com/Han-1413141/dsh-cost-meter)。

**实际调用链不提供预调用金额冻结。** `createLlmStreamBilling` 先调用下游 `next()`，结束时仅在收到 usage 的情况下执行 account。预算计算用于状态展示；本次检查的调用链没有 reserve/hold 或金额不足拒绝。缺少 usage 的失败流不能因此证明没有扣费。来源：[billing-stream.js](https://github.com/Han-1413141/dsh-cost-meter/blob/master/lib/billing-stream.js)、[index.js](https://github.com/Han-1413141/dsh-cost-meter/blob/master/lib/index.js)。

**余额差也不是单请求核对。** `reconcileBalanceDelta` 对照每日余额基线与当天已记费用，输出 drift 等状态，没有把某个供应方 request ID 对上原收据。其 New API 模板使用 token usage 接口与可配置 quota 除数；不能把模板默认换算率当成本中转站已经核实的价格单位。判断：可借鉴费用展示和可配置余额提取，原产品账本、unknown hold、请求编号与人工/供应方核对仍须保留。来源：[余额实现](https://github.com/Han-1413141/dsh-cost-meter/blob/master/lib/store.js)、[余额与 New API 配置](https://github.com/Han-1413141/dsh-cost-meter)。

### mstar-harness：有执行门禁，独立 QA 与恢复仍需明确接入

它包含 TypeScript 工作流引擎、宿主适配器和判断型 skills。DSH 实现注册文件写入与 `tools/pre-execute` 门禁，可返回 deny；**默认 warn/advisory，hard enforcement 需要显式配置**。默认 dispatch 工具名是 subagent/subagent_fork，本项目原生团队工具还需对应绑定，不能只装包便声称权限门禁覆盖。来源：[DSH 实现](https://github.com/btspoony/mstar-harness/blob/main/packages/dsh/src/index.ts)、[项目说明](https://github.com/btspoony/mstar-harness)。

**独立 QA 不是所有路径的必选结果。** QC 是代码/证据审查，维护者明确把运行测试交给实现者和 QA 层；QA 层可以配置 mandatory qa-engineer，也可走 PM acceptance。因此应选择独立 QA 路径并核验真实 CLI 输出，不能把 tri-review 或 PM 接受当成已执行测试。来源：[QC/QA 分工](https://github.com/btspoony/mstar-harness/blob/main/skills/mstar-review-qc/SKILL.md)。

**恢复有具体机制，但没有本项目所需的完整验收证据。** 维护者提供文件化执行状态、lease、session handoff、显式 resume/reconcile；本地 dashboard 是只读展示。所查契约没有直接供应 New API 单请求未知费用核对，也没有替本项目固定知识版本、文件 SHA、DAG 和费用历史做转换。判断：可借鉴状态转换与持久化证据门禁，仍需隔离测试突然中断、completed 不重派及未知外部操作不重放。来源：[架构、恢复与测试边界](https://github.com/btspoony/mstar-harness)。

安装还涉及**机器级 DSH profile**，项目 scope 不会隔离该 profile；默认初始化另装 llm-fallbacks，可能影响原批准路由。维护者给出 Bun >=1.4.0，Node-only CLI 路径要求 Node >=24.18.0；本次工具终端 Node 为 v24.15.0，未据此推断主服务版本，Bun 路径未验证。判断：直接集成成本较高，先借鉴门禁设计；若将来安装，应在独立主机/profile 和固定包版本中验证，不改当前主机来试。来源：[安装与 profile 边界](https://github.com/btspoony/mstar-harness/blob/main/INSTALL.md)。

两者都未提供当前原预算下 QA→review→经理必然完成的证明。本节没有完成 Windows 安装、真实中转站、网页全流程或重启恢复实测，也没有扩大预算、替换批准合同或自动结算不明费用。
