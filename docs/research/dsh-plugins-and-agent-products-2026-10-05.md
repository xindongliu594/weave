# 为伍：DSH 插件与同类开源产品调研

日期：2026-10-05。范围：Windows 本机网页、确认后组队、真实代码执行与 QA、恢复、知识授权和费用。只使用维护者仓库、包清单和官方文档核对能力；没有安装或升级候选，没有调用中转站模型，没有迁移或覆盖原数据。下面的集成成本与优先级是结合本项目代码作出的判断，不能当作本机验收结果。

## 结论与现有底座

有值得复用的插件，也有非常接近的成品。近期最合适的路线是保留现有 DSH 运行器和产品账本，评估持久化策略、借鉴上下文面板与有界交接；产品组织和费用交互重点参考 Paperclip，开发执行与确认界面参考 OpenHands。这次查到的资料没有证明某个插件可以直接完成我们的全部六项验收。

本项目实际固定的依赖为 DSH `0.1.5-rc.1`、Cordis `4.0.2`、`@nanmicoder/dsh-agent-teams` `0.1.20`（[运行器包清单](../../services/agent-runtime/package.json)）。自己的网页用 React `19.1.1`，另有 Express API、PGlite、审批、费用预留和交付文件版本（[根包清单](../../package.json)）。运行 Host 已挂载 JSONL 持久化、Token meter、基础压缩和工具结果剪枝；没有显式挂载 checkpoint-policy（[Host](../../services/agent-runtime/host.mjs)、[员工 Host](../../services/agent-runtime/employee-hosts.mjs)）。这不是一套未经封装的 DSH 原生 Web profile。

## 市场入口

- [DSH Plugin Registry](https://dshplugin.app/plugins)及其[来源目录](https://github.com/dshplugin-app/deepseek-harness-plugins)：独立社区目录，提供分类、安装来源和兼容性证据。目录收录不等于在“为伍”验证通过。
- [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：另一个社区精选目录，适合发现候选。
- [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)：官方底座和插件加载机制。项目仍处于开发预览期，核对精确版本比直接安装 latest 更重要。

不需要给“为伍”的普通用户增加一个插件市场操作步骤；我们可在开发时选定、适配并固定依赖。

## DSH 候选与落点

| 候选 | 来源核实的能力 | 对为伍的用途与接入判断 | 关键边界 |
| --- | --- | --- | --- |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 团队、依赖任务、持久消息；当前 `0.1.22` 文档有先草案后批准和可选质量任务 | **已经在用，优先保留。** 在隔离环境比较 `0.1.20 → 0.1.22`，判断哪些自定义逻辑可以收敛 | 最新文档不是当前安装版的验收。升级必须覆盖我们的原合同、权限和旧运行恢复；插件本身不等于 OS 沙箱 |
| [session-checkpoint-policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md) | 模型发送前、工具副作用前及下一步前强制落盘；落盘失败阻止执行；中断工具恢复为未知结果 | **可复用的 Host 层插件候选。** 先核对 `0.1.5-rc.1` 可用版本，再与现有 archive/JSONL 门禁做隔离组合测试 | 持久化意图不保证外部操作恰好执行一次；不能代替未知扣费核对 |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 上下文组成、请求变化、压缩/剪枝事件、文件活动和团队视图 | **优先参考数据投影与面板。** 用我们的运行记录展示系统提示、工具定义、历史、文件与知识分别占多少 | 可观测性不会自动减少上下文；其金额来自 models.dev 价格估算，不能作为中转站账单 |
| [dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | 可复用多模型团队、动态 DAG、有界结构化交接、运行中心、质量回合、成功任务复用 | **最接近团队产品的 DSH 插件。** 优先借鉴交接契约和运行交互，不直接替换现有团队状态 | 使用软 Token 预算；依赖 DSH 原生网页服务。未知结果、金额预留和严格测试验收仍需宿主负责 |
| [DSH-RAG](https://github.com/imkelt/DSH-RAG) | 显式授权本地资料，按会话选择知识库，离线 BM25，PDF/Word/PPT 解析与可追溯来源卡片 | **适配成本中等。** 优先复用解析和来源呈现，保留当前员工授权、版本 SHA 和恢复快照 | 作者目前只声明实测 DSH `0.1.1-rc.2`；会话范围不能自动等同员工授权和历史版本固定 |
| [Windows ACL sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md) | 原生 Windows 的受限写入 token、工作区和私有临时目录；提供可嵌入的 AclSandbox | **执行隔离候选。** 可与本机执行器做独立适配实验 | 读权限及网络不在此边界内；不是容器。实际子进程、退出清理与目录权限均需 Windows 验证 |
| [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) | usage 记账、缓存价格、预算展示和余额差提示 | **借鉴展示及余额解析。** 原费用预留与收据系统继续负责执行门禁 | [调用实现](https://github.com/Han-1413141/dsh-cost-meter/blob/master/lib/billing-stream.js)在返回 usage 后记账，没有预调用金额冻结；每日余额差不能精确核对单请求 |
| [mstar-harness](https://github.com/btspoony/mstar-harness) | TypeScript 状态/派发/写入门禁和多角色质量流程 | **借鉴代码级状态转换，直接集成成本较高。** 要明确启用 hard enforcement 和独立 QA | [DSH 包清单](https://raw.githubusercontent.com/btspoony/mstar-harness/main/packages/dsh/package.json)要求 `^0.2.0-rc.2`；与当前固定版本不一致。默认 warn，QA 也存在 PM acceptance 路径 |

许可和兼容性核对：agent-teams 仓库为 MIT；其[兼容矩阵](https://github.com/NanmiCoder/dsh-agent-teams/blob/main/compatibility.json)包含旧 `0.1.5` 系列，但这不证明我们的封装可直接升级。`dsh-context` [包清单](https://raw.githubusercontent.com/bowenliang123/dsh-context/main/package.json)为 `0.63.0`、Apache-2.0，声明支持 `0.1.5-rc.1`；网页 peer 为 React 18。team-gui [包清单](https://raw.githubusercontent.com/toolclub/dsh-agent-team-gui/main/package.json)为 `1.3.0`、MIT，范围为 `>=0.1.5-rc.1 <0.1.6-0`，同样使用 React 18 和 DSH Connection/session/storage 服务。DSH-RAG [包清单](https://raw.githubusercontent.com/imkelt/DSH-RAG/main/package.json)为 `0.1.2`、MIT。官方 DSH 组件遵循其[仓库许可](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。

因此“可以安装到 DSH”与“可以直接装进为伍网页”是两回事。Host 组件较易组合，原生 UI 插件通常需要数据/RPC/组件适配。避免为一个面板同时升级整个 DSH 和网页 React。

费用和质量插件的维护者源码检查、仓库版本与许可见[子报告追加部分](comparable-agent-products-2026-10-05.md)。cost-meter 当前 manifest 为 `1.8.11`，mstar DSH manifest 为 `3.11.2`，两者标 MIT；未核验 npm 实际发布包。mstar 安装会修改机器级 Web profile，默认另装 fallback 插件，不能让它在当前批准路由里自行扩大备用模型范围（[安装说明](https://github.com/btspoony/mstar-harness/blob/main/INSTALL.md)）。

## 同类成品和框架

**Paperclip 是这次调研中，组织管理语义最接近为伍的成品。** 它围绕 agent、组织层级、任务和审批展开，开源仓库为 MIT，适合参考员工页面和管理入口（[维护者仓库](https://github.com/paperclipai/paperclip)）。其费用界面包含项目总额上限、预算事件和暂停/调整后继续，也区分估算与账单来源（[官方费用文档](https://docs.paperclip.ing/guides/day-to-day/costs/)）。

它通过 adapter 接入执行器；当前 `http` 和 `process` 可以在运行时使用，但网页选择仍标 Coming soon，需 API 或导入配置（[adapter 文档](https://docs.paperclip.ing/reference/adapters/overview/)）。因此不是填入我们中转站 URL 后，就已证明能独立完成当前网页流程。其 Windows 本机适配未实测。**判断：作为产品设计参考优先级高，替换当前系统的迁移成本高。**

**OpenHands 更接近代码开发与执行的网页成品。** 当前 Agent Canvas 与 software-agent-sdk 已分为不同入口；官方 Windows 路径包含 Docker Desktop/PowerShell，而按会话创建独立容器的方式需 WSL2（[当前仓库](https://github.com/OpenHands/OpenHands)、[Windows 指南](https://github.com/OpenHands/OpenHands/blob/main/README.windows.md)）。可参考命令确认、会话事件、工作区和交付界面；不能混用旧版本 GUI 教程。**判断：可在隔离环境作为独立成品比较，接入为伍员工/DAG/审批/账本仍需明显改造。**

**LangGraph JS 更适合借鉴持久流程语义。** 持久 checkpointer 可保留节点状态及成功的 pending writes；MemorySaver 重启会丢失。interrupt 恢复会重入所在节点，副作用需要幂等或拆成独立节点（[Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers)、[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)）。**判断：与现有 TS 栈接近，值得对照恢复设计；本轮不用增加第二套状态引擎。**

**CrewAI 可参考员工/经理编排。** 当前真正的 checkpoint 可跳过 completed tasks，但自动保存失败可以只记录错误继续运行，需要另外落实强制持久化边界（[官方 checkpoint 文档](https://docs.crewai.com/v1.15.23/en/concepts/checkpointing)）。它是 Python 框架，AMP 商业控制平面不能当作 MIT 仓库自带的本机网页。更多版本、模型接口和限制见[同类产品子报告](comparable-agent-products-2026-10-05.md)。

## 具体优先级与验收办法

1. **恢复可靠性：** 对照官方 checkpoint-policy 核查现有写入门禁；隔离断开模型/工具之后立即终止进程，确认 intent 已落盘，未知结果保留且不自动重放。使用本地工具 fixture 验证机制，随后再做真实模型项目验收。
2. **上下文和交接：** 参考 dsh-context 显示组成，参考 team-gui 将任务结果整理成有限的交接信息，保留原始文件与完整历史。不把裁掉必须文件、压缩后遗漏引用或调低原输出上限当成通过。
3. **预算方案：** 参考 Paperclip 的预算事件交互；由 Astra 提议项目/任务额度与 QA、经理阶段预算，用户确认后按原上限执行。Token 观测与估算和中转站实际扣费分别展示。新框架不能证明现有余款够完成全部剩余节点。
4. **资料和隔离：** 在现有私有/共享知识授权及版本恢复通过的基础上，评估 DSH-RAG 解析/来源卡片；Windows ACL 或 OpenHands 的隔离执行另做针对性实验，不把 Host/会话隔离称为 OS 沙箱。

这个顺序围绕当前主流程，先做较小组合或借鉴，再考虑替换底座。正常完成、受控中断、已完成节点不重复、历史费用继承、知识固定和隔离恢复仍由为伍实际验收。所有新候选的安装、真实中转站调用和故障恢复在本次调研中均为**未验证**。
