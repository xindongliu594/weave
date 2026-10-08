# 为伍：长期研发部门的可靠性与现成组件调研

日期：2026-10-07（北京时间）。用户明确先做长期研发部门，要求先梳理、规划和调研，优先复用现成组件。本轮仅读取现有代码和官方文档、维护者仓库；没有安装、升级、迁移、修改业务代码、改变权限或预算、创建持续任务、调用模型或上传公司资料。以下架构和优先级是选型建议，不是已实现能力；候选在当前 Windows/DSH/中转站的兼容性及资源用量均未实测。

## 1. 产品目标与选型原则

部门长期维护一个指定项目，持续接收需求与缺陷、整理待办、开发、独立测试、验收和沉淀经验。部门在没有工作时待命；事件或计划产生实际工作后才调用模型。长时间在线不应等同于同一段对话无限增长。

先选择组织管理成品，再确定适配边界。现有实现可以保留为执行和审计底座，但不因已经投入开发就排除直接采用成品。任何候选都要核对：维护状态、实际版本、许可证、Windows/Node 适配、额外服务、权限和旧数据兼容性。SDK、产品插件、MCP 服务、托管平台和 Codex 中的插件不是同一种东西。

一个公司任务账本、一个执行准入和费用账本；外部监管平台只读取投影。若选择新管理层，应明确谁负责任务状态与授权，不能把 Paperclip、旧协调器和另一套队列都作为独立派发者。

## 2. 当前基础与真实缺口

| 领域 | 当前核对结果 | 下一阶段需要补的部分 |
| --- | --- | --- |
| 员工运行 | 固定 DSH 0.1.5-rc.1、AgentTeams 0.1.20；员工独立 Host/会话按 Run 创建和关闭 | 持续部门目标、业务收件箱与跨任务的项目记忆 |
| 上下文 | 已接入 TokenMeter、BasicCompactionEngine、EvidencePruner、JSONL 和官方 checkpoint policy | 长期摘要质量、任务切换、冲突记忆、恢复后来源一致性评测 |
| 调度 | queued Run 持久化，部门互斥、租约、并发和预算准入；定时模块事务去重、合并错过间隔 | 当前定时到期只建 DRAFT；未形成授权内自动执行的部门闭环 |
| 恢复 | 已有真实受控重启恢复与完成节点不重做的证据 | 连续多日业务、服务异常退出和自主接续仍需单独验收 |
| 公司知识 | Obsidian/Markdown、知识空间授权、文档版本/SHA、关键词及混合检索实现 | 当前真实验收使用关键词；语义模型未安装，不能声称混合召回质量已验证 |
| 经验 | 来源去重、知识候选、人工审查发布、规则评测历史 | 当前知识整理是确定性摘录；不是自动复盘、可靠经验提炼或员工自学习 |
| 数据 | 完整事件和模型请求保存；员工 JSONL 当前 compression=none；retentionDays 被固定为 0 | 日增长计量、去重、冷热归档、容量准入、可审查保留策略 |
| 监管 | 有审批、任务与尝试、文件版本、命令输出、费用和未知收据 | 部门级汇总及标准追踪平台适配；不是缺少所有日志 |
| 本机执行 | 工作区和命令审批已接通 | 当前本机执行器不是 OS 沙箱；夜间研发预授权需要独立隔离验收 |

本地证据：[运行器依赖](../../services/agent-runtime/package.json)、[员工 Host](../../services/agent-runtime/employee-hosts.mjs)、[上下文实现](../../services/agent-runtime/employee-context.mjs)、[运行协调器](../../apps/api/src/run-coordinator.ts)、[定时与监督](../../apps/api/src/automation-learning.ts)、[知识版本检索](../../apps/api/src/knowledge-store.ts)、[事件存储](../../services/agent-runtime/trace-store.mjs)、[模型请求追踪](../../services/agent-runtime/trace.mjs)、[设置约束](../../apps/api/src/product.ts)。历史背景见 [上下文说明](../context-management.md)、[自动化说明](../automation-learning.md)及[本轮真实 MVP 验收](../mvp-acceptance-2026-10-07.md)。

## 3. 上下文：把模型可见内容与业务事实分开

| 内容 | 权威存储 | 员工每轮如何使用 |
| --- | --- | --- |
| 部门目标、岗位、授权 | 已批准配置和版本 | 系统构造固定约束，不让摘要改变权限 |
| 当前任务、状态、预算 | 任务/执行数据库 | 读取结构化真实状态，不能靠模型回忆完成情况 |
| 文件和测试证据 | 对应版本的文件、SHA、命令回执 | 当前任务按需读取；验收绑定实际版本 |
| 公司知识 | 原文及不可变版本、授权索引 | 先按员工权限过滤，再检索相关片段 |
| 项目记忆与经验 | 有来源、版本、适用范围的记录 | 仅取相关、有效记录；冲突时回查原证据 |
| 临时对话 | 会话日志和可重建摘要 | 近期完整，旧内容压缩；原文仍可查 |

每次工作单元使用有界上下文：岗位与授权 + 当前任务合同 + 必要状态 + 相关知识/经验 + 最近有效工具往返。不能把全部公司资料、所有历史任务和所有工具 schema 都塞进去。用已安装组件做计量、工具结果裁剪和摘要，不另写压缩引擎。

摘要是导航信息，不是事实或验收凭证。记录摘要覆盖的事件范围、资料版本和来源；变更文件后重新核对当前版本。关键任务要求、未完成动作、来源标识以及工具调用/结果配对需要受到保护。摘要不够容纳时停止并重新组织任务，不能静默丢合同来继续。

这些机制降低失误并让错误可检测、可恢复，不能保证模型永远不犯错。需要专门测试多次摘要、任务切换、资料互相矛盾、版本变更和重启。DSH 官方基础见 [维护者仓库](https://github.com/deepseek-ai/deepseek-harness)；本机挂载和版本以本地代码为准，上游 master 不能冒充已安装能力。

## 4. 数据增长：上下文缩短不等于日志变小

建议采用可审查的数据分层，先计量后决定限额：

| 数据类别 | 建议策略 |
| --- | --- |
| 活动任务、恢复检查点、待核对操作 | 保留可恢复原件和完整索引，不按通用 TTL 清理 |
| 交付物、批准版本、验收和费用凭证 | 保留版本与关联；同内容按哈希引用，归档后仍可核验 |
| 完整模型/工具日志 | 活跃 Run 可读；结束后压缩归档；管理页面主要读取摘要与索引 |
| 大文件与完整工具输出 | 文件或对象存储保存一份，日志记录引用、SHA、必要片段 |
| 缓存、临时副本 | 有容量和生命周期，可重建；与原始证据严格区分 |
| 公司知识与经验 | 内容哈希去重、增量索引、有效性审查；已有授权版本不能因新内容覆盖 |

设置单次输出大小、单 Run/部门存储配额、每日新增字节统计和磁盘水位。容量不够时停止接收新工作，先完成安全落盘；不能在断点恢复需要读原件时发现已被清掉。使用分页、流式读取及后台归档，避免界面或恢复流程一次读取无限日志。

永久保留全部原始日志与固定容量磁盘不能同时无限满足。保留期限、归档位置和删除规则需要明确选择。本轮不删除旧日志，也不改变现有 retentionDays=0。备份次数和保留期同样要计量；需要实际隔离恢复证明归档未破坏引用。

### 4.1 开发现场文件：临时、旧版本、依赖、构建与测试

用户进一步明确：不仅是数据库与日志，还要控制员工开发/测试中的临时文件和旧文件。该要求属于长期运行的核心可靠性，不能用偶尔人工清理代替。

| 类别 | 建议保留与回收规则 |
| --- | --- |
| 正式源码与版本 | 一个项目仓库，变更由 Git 记录；不用每次复制整个项目作历史。Git 对象库和分支也需计量，不能无限添加不再使用的备份/引用 |
| 员工活动工作区 | 独立 worktree/工作目录，记录所属 Run、任务、尝试和租约；开发与 QA 不共用任意可写目录 |
| 临时测试数据、下载、解压 | 每个尝试的专用临时目录；把子进程 TMP/TEMP 和工具输出指向它；确认进程结束且无恢复依赖后按已批准规则回收 |
| dist、coverage、构建缓存 | 原则上可重建；归档需要的验收结果与发布产物后回收可重建副本 |
| node_modules 与下载缓存 | 优先复用 npm 缓存或固定依赖镜像；每个失败尝试不另留完整依赖副本。不同锁文件/平台/Node ABI 必须分开核对，不能共用可写依赖目录 |
| 被验收的交付版本 | 保存需要交付/恢复的源码、报告及清单；同内容哈希引用，旧版本压缩归档；不把所有历史依赖、构建缓存重复装进源码包 |
| 失败现场 | 保留定位和恢复需要的原件，设置显式保留期限/人工冻结状态；尚未提交代码、未知操作、审批等待和活动节点不进入自动回收 |

工作区注册记录建议包含 owner/run/task/attempt、绝对根目录、状态、字节数、文件数量、进程/租约、保留原因、被引用版本及清理状态。文件数量与字节数都要限制，大量小文件也能拖垮扫描、备份和界面。

收尾流程由程序负责：停止对应工具和子进程 → 核验输出与实际测试 → 固化交付/恢复清单 → 标记可回收范围 → 清理可重建文件 → 保存回收结果。服务重启补检孤儿工作区，先核对所有权、进程与引用，再回收；不能仅凭目录日期、名称包含 tmp 或模型说无用来删除。

Windows 清理必须核对解析后的绝对路径在被管理根目录内，拒绝越界和意外重解析点；不能通过 Junction/Symlink 递归到用户原目录。清理与任务恢复必须有互斥门禁；原件保存与 SHA 清单核对成功后才释放对应副本。主仓库、用户导入原目录、当前原数据目录不作为回收目标。

仅靠 TMP/TEMP、扫描监控或定期删除不能形成硬磁盘边界：应用可能绕过默认临时目录，监控间隔中也可能写入大量文件。自动执行需要可靠隔离和平台可用的容量约束，再配合应用配额；当前普通 Windows 用户权限执行不能被描述为已保证不写出工作区。

直接复用的机制与限制：

- **Git worktree**：共享仓库对象并支持独立分支工作目录及移除流程；不会自动复用 node_modules，也不会自动清理全部构建文件。回收前保存必要修改和未跟踪/忽略的交付文件，不能强制删掉未验收成果。[官方 worktree](https://git-scm.com/docs/git-worktree)。
- **npm cache**：已有基于内容地址和完整性校验的缓存，避免我们另写包缓存；官方明确缓存会增长，verify 不是固定容量保留承诺。它是可重建缓存，不是离线恢复的唯一依赖来源。[官方 npm-cache](https://docs.npmjs.com/cli/v11/commands/npm-cache/)。
- **一次性容器**：适合隔离开发/测试环境。--rm 删除退出容器及匿名卷，命名卷、宿主挂载和构建缓存仍须分别治理；先落盘必须保留的报告和恢复材料再退出，不靠“容器退出了”判断文件已全清理。[Docker 清理边界](https://docs.docker.com/reference/cli/docker/container/run/)。
- **GitHub-hosted CI runner**：普通托管 runner 按 job 提供新 VM，适合复用现有 CI 承担真实测试而减少本机长期残留；单 CPU runner 是容器例外。上传的 artifacts/caches 有另行的保留策略，自托管 runner 不享有相同环境生命周期保证。[托管 runner](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)。使用涉及代码外发/服务额度，需沿用明确授权。

验证应覆盖数百个离线失败/重试工作单元后活动目录、旧 worktree、依赖副本、缓存与临时文件的数量/字节有界；杀进程或重启后孤儿能识别；必要失败证据和恢复文件不丢；磁盘不足时拒绝新任务；清理不能越界且不可与恢复竞争。没有这些证据不能声称长期文件增长已受控。

## 5. Token 与费用：先减少无效工作

1. 事件驱动优先。空队列/租约/健康检测使用程序，不发模型请求。十名员工每五分钟调用一次就是每天 2,880 次，即使没有任务也会消耗；这是机制示例，不是当前系统的收费统计。
2. 一次事件只形成一个工作项，重复通知去重；停机补检合并或限量补发，不能恢复后批量派发旧任务。
3. 员工只拿必要资料和当前岗位工具；大结果用引用和片段，文件只读需要部分；交接传结论、证据和未解决项。
4. 不为简单工作固定开启全员协作。只在已批准模型池内路由；复杂判断与机械执行采用经过评测的不同配置。
5. 部门长期预算和单工作预算分开；推理、摘要、经验提炼、远程 embedding 与付费 eval 一起统计。重试、持续无进展和错误达到边界后退避或转待决策。
6. 度量每个被实际验收任务的 Token、已知费用、未知预留、时长和人工介入，不只看模型单价。

缓存是额外优化，不能承诺中转站自动支持相同语义或折扣。保持可缓存前缀稳定，并核对供应方实际 usage。摘要可能改变前缀，是否划算要比较总输入成本。[官方 OpenAI 缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching)。

首页需求对话的新规则仍是“不做本地金额预留和执行预算拦截”，实际调用由中转站收费并另记历史；项目经理咨询、运行和后续付费评测不能因此绕过执行账本。未知 usage 或账单继续待核对，不填零。供应方支持幂等与查询时利用它们；余额差不能单独定位每条请求。

## 6. 公司知识与员工经验

公司知识是资料事实，经验是经过验证的工作方法，任务状态是当前业务事实。三者不能混成一个模糊的“长期记忆”。现有 Obsidian/Markdown 作为可审阅正文，现有数据库保存索引、授权、版本及来源。先把现有检索和增量索引做好，未证明需要新向量库前不引入第二套存储。

每个新任务固定其知识清单和文档版本；之后目录更新可供新任务选择，旧运行恢复仍使用原批准版本。检索缓存键必须包含资料版本和授权范围，不能把某员工的私有检索结果复用给别人。检索无结果应显示不足；资料中的文字不具有提升权限的效力。

建议经验流程：实际执行与验收 → 自动生成待审候选 → QA/经理核对来源和适用范围 → 授权审查后发布 SOP/经验 → 在新任务检索使用 → 用固定案例评测 → 失效标记或版本回退。

经验记录至少包括：问题/触发条件、适用项目与版本、处理步骤、验证证据、局限、来源 Run/文件/测试标识、知识权限、审查人、发布日期及有效状态。模型提出的原因尚未验证时明确标为假设。失败经验也有价值，但失败过程不能被总结成成功方法。

员工不能靠复盘自动扩大权限、增加预算或修改自己系统提示。优先复用现有知识候选、版本保存和人工发布链；它目前只做摘录，需要补业务复盘和评测适配。

## 7. MCP 与研发工具

MCP 是工具协议，不提供完整的业务权限、隔离和质量保证。优先接维护者服务，使用现有 DSH MCP client 或官方 SDK 作为协议层，再映射产品员工/部门授权。不要为每个服务重写 JSON-RPC、OAuth 和传输。

第一批研发工具建议：GitHub 指定仓库的 Issues、代码、PR 和 Actions 查询；现有知识检索；受限项目目录的文件操作；经过批准的测试执行。创建 PR、推送、评论、合并和部署另定义操作范围与审批，不因为启用 MCP 就全部授权。

通过岗位筛选暴露工具；参数/结果 schema、目标仓库/分支/路径、超时、最大结果、限流和审计都由服务端核对。读工具的标记只是声明，不代替真正的权限校验。[MCP 工具规范](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。结果不明的写入保存 operation/request ID，优先查询结果或用明确幂等键；不能自动重放。

GitHub 官方 MCP 服务可直接作为集成候选；旧 MCP 示例仓库不是生产认证，旧 GitHub 参考服务也不应代替现维护者服务。[GitHub MCP](https://github.com/github/github-mcp-server)、[参考服务边界](https://github.com/modelcontextprotocol/servers)。现有产品 MCP 自动调用只接明确授权的只读范围，写入扩展尚未验收。

研发交付尽量复用 GitHub 的 Issue → 独立分支/PR → Actions 测试 → 人工合并。核对指定 commit 的真实检查结果，不用自己再造 CI。GitHub 定时 workflow 可能延迟，不能当作唯一部门心跳。[Actions 触发边界](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

## 8. 监管与 Eval

用户层主要显示：部门目标、当前工作、今日成果、阻塞、待决策、预算和下一次检查。追踪详情提供员工、任务、尝试、工具、资料版本、实际命令结果、文件 SHA 和恢复来源。管理动作包括暂停部门、撤销授权、拒绝操作、恢复条件检查和配置回退；正常信息不需要每一步通知用户。

建议用 OpenTelemetry 兼容的追踪投影，关联 runId/taskId/attemptId/employeeId/requestId 和恢复父子关系。默认导出白名单元数据与脱敏统计，不把 Key、私有知识全文和完整代码复制到追踪平台。现有脱敏只覆盖有限模式，不能声称自动识别所有敏感业务文字。追踪不需要收集或展示模型的完整隐藏思维链。

| Eval 层次 | 方法与验收对象 |
| --- | --- |
| 硬规则 | 实际 CLI/HTTP 测试、退出码、schema、权限、文件版本、预算和操作回执 |
| 语义质量 | 需求理解、知识引用、经验适用性、经理报告一致性；人工标注和有界模型 judge |
| 长期可靠性 | 多任务/多次摘要、空闲、重复事件、重启、审批等待、知识更新、服务故障、容量不足 |

将现有正常/失败/恢复证据脱敏后转为固定回归集：不重复已完成节点，不重放未知写入，不接受失败测试为通过，不用未授权资料，恢复知识版本不漂移，经理报告与实际回执一致。冻结案例和期望，不在改实现之后顺手改标准。

先离线评测已有输出和硬规则，再用小额、独立核准的真实模型评测。评测目标模型、judge、重试和数据传输都纳入成本及授权；工具直接连中转站不能绕过产品账本。语义分数和 Trace 都不能替代真实 QA。

## 9. 候选比较与采用顺序

| 候选 | 核实的能力/许可与负担 | 对本项目的建议 |
| --- | --- | --- |
| 已装 DSH / AgentTeams | 官方 DSH 与社区 AgentTeams，MIT；本机版本和挂载已核对 | 继续复用，先不升级/替换员工执行器 |
| Paperclip | Node/React 公司、Agent、任务、审批、预算、routines；MIT | **优先验证成品管理层是否可直接采用**，不先自研同等功能；[维护者](https://github.com/paperclipai/paperclip)、[routines](https://docs.paperclip.ing/guides/projects-workflow/routines/) |
| MCP TypeScript SDK / GitHub MCP | 官方协议 SDK 和 GitHub 服务；SDK 当前存在新 Apache-2.0 与历史 MIT 代码，GitHub 服务 MIT | 固定兼容版本，复用协议/服务，保留产品授权；[SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[GitHub 服务](https://github.com/github/github-mcp-server) |
| Promptfoo | npm CLI、断言、模型对比、CI、OpenAI-compatible；MIT；当前 Node 要求≥22.22、推荐24 | 优先作为离线评测接入候选，不需常驻服务；[安装](https://www.promptfoo.dev/docs/installation/)、[断言](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、[中转接口](https://www.promptfoo.dev/docs/providers/openai/)、[许可](https://github.com/promptfoo/promptfoo/blob/main/LICENSE) |
| Langfuse | TS/OTel、数据集、实验、追踪和人工标注；核心 MIT，企业治理另许可；默认 Docker Compose 多服务 | 需要集中监管时再验证；不为单部门先强制安装全套；[SDK](https://langfuse.com/docs/observability/sdk/overview)、[eval](https://langfuse.com/docs/evaluation/overview)、[部署](https://langfuse.com/self-hosting/deployment/docker-compose)、[许可](https://github.com/langfuse/langfuse/blob/main/LICENSE) |
| Phoenix | OTel/OpenInference、数据集/eval；SQLite 单实例或 Postgres；主仓 ELv2 | Langfuse 替代选项；内部自托管与对外提供托管服务的许可边界不同，不能简单写 MIT/Apache；[架构](https://arize.com/docs/phoenix/self-hosting/architecture)、[许可](https://github.com/Arize-ai/phoenix/blob/main/LICENSE) |
| DeepEval | 语义/Agent/RAG 指标，Apache-2.0；已有 TS/Vitest，Python 功能更完整 | 需要更丰富指标再评估，不与 Promptfoo 同时起步；[TS差异](https://github.com/confident-ai/deepeval/tree/main/typescript)、[许可](https://github.com/confident-ai/deepeval/blob/main/LICENSE.md) |
| BullMQ | Node/TS、MIT；默认 Redis，现已有可选 Postgres 后端，要求真实 PG13+等 | 规模扩大再评估；未证明兼容本机 PGlite，不先换队列；[Postgres](https://docs.bullmq.io/guide/postgresql)、[许可与源码](https://github.com/taskforcesh/bullmq)、[幂等要求](https://docs.bullmq.io/patterns/idempotent-jobs) |
| Temporal | TS SDK/服务 MIT，多日持久 workflow；Windows CLI 可用，另需 Service、存储和 Worker | 长跨服务流程再评估；不是未知模型/工具请求的自动恢复器；[TS设置](https://docs.temporal.io/develop/typescript/set-up-your-local-typescript)、[服务](https://docs.temporal.io/self-hosted-guide)、[Activity语义](https://docs.temporal.io/activities) |
| LiteLLM | OSS 已有代理、虚拟 Key、预算和路由；企业治理另许可 | 暂缓，现有中转站和账本已覆盖主要入口；多提供商需求明确后再选；[功能分界](https://docs.litellm.ai/docs/enterprise) |
| WinSW | Windows 服务包装器，MIT | 作为后台服务管理候选，不自写进程守护；需验证当前用户凭据、工作目录、日志轮转和优雅关闭；[维护者](https://github.com/winsw/winsw) |
| Mem0 TS OSS | Apache-2.0，Node 记忆提取/检索；默认示例含外部模型/embedding及需配置持久化的向量存储 | 偏好/跨任务记忆确有缺口后再试，不以 metadata 过滤取代授权；[Node 入门](https://github.com/mem0ai/mem0/blob/main/docs/open-source/node-quickstart.mdx)、[TS依赖](https://github.com/mem0ai/mem0/blob/main/mem0-ts/package.json)、[许可](https://github.com/mem0ai/mem0/blob/main/LICENSE) |
| Letta 当前实现 | Apache-2.0（品牌例外另列）；当前入口转向 Letta Code/App Server、Node/TS及Windows支持，旧Python V1在archive | 长期记忆独立试点候选，会重复部分DSH执行职责；不能照旧Python教程选型或假设反思免费/无人审核；[当前入口](https://github.com/letta-ai/letta)、[当前实现](https://github.com/letta-ai/letta-code)、[许可](https://github.com/letta-ai/letta-code/blob/main/LICENSE) |

### 不能忽略的适配差异

- Paperclip 预算按已记录支出执行，usage 延迟及在途请求会影响停机时点；不能据此删除原预留/未知收据。它的内置服务管理目前面向 macOS/Linux，不支持 Windows，需单独解决后台管理。[预算说明所在 README](https://github.com/paperclipai/paperclip)、[服务平台边界](https://docs.paperclip.ing/reference/cli/service/)。
- Paperclip 的 HTTP adapter 默认拒绝私网/localhost，须显式精确 origin allowlist；还不能从网页下拉框直接选。不能直接填旧工作台 localhost URL 就声称集成完成。[HTTP adapter](https://docs.paperclip.ing/reference/adapters/http/)。
- Langfuse 自动 Data Retention 自托管属于企业功能，默认无限保留；装它不会自动解决我们原始日志增长。[Data Retention](https://langfuse.com/docs/administration/data-retention)。
- DSH 社区市场可能导入角色/skills/MCP，但其角色 tools/disallowedTools 不一定真正执行。内容市场不能作为员工权限的安全边界。[市场维护者](https://github.com/Sivan757/dsh-agent-plugins-market)、[轻量桥](https://github.com/yyqrc/dsh-agent-plugins)。
- installed DSH 0.1.5 的 Windows ACL 隔离有明确范围；上游 master 的实现已经改变，不能套用成当前能力。当前产品本机执行不是 OS 沙箱。[上游 Windows 后端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md)。
- LlamaIndexTS 在 2026-04-30 被维护者归档并标弃用，不能按旧选型推荐作为新主依赖。[维护者当前状态](https://github.com/run-llama/LlamaIndexTS)。

## 10. 选型与验证计划（尚未执行）

1. **冻结第一部门职责和数据模型。** 一个研发项目、明确工作来源与验收标准；列出部门目标、任务事实、公司知识、经验、日志、预算各自的权威存储。输出可评审的范围与授权表。
2. **先做成品管理层验证。** 在隔离目录/独立数据中验证 Paperclip 的研发部门、事件/routine、审批、现有 DSH 执行适配和账本归属。若关键要求满足则直接采用；若不满足，逐条记录阻塞并优先复用现有管理模块，不凭感觉另造完整控制台。原数据与历史 Run 不迁移覆盖。
3. **离线可靠性与容量基线。** 使用现有测试/脱敏输出，验证摘要多轮、权限/版本、去重、未知操作不重放、Token/输出上限、归档与恢复；反复失败/重试产生的临时目录、旧工作区和依赖副本也纳入生命周期验收。确定每日数据/文件数量增长、每个验收任务 Token/已知费用及人工介入基线。
4. **最小工具与 Eval 集成验证。** 固定官方 MCP/GitHub 工具集、现有真实测试与 Promptfoo；验证失败报告、权限拒绝和结果一致性。需要监管后台时只选 Langfuse 或 Phoenix 一套，先测资源负担与脱敏投影。
5. **真实持续试点。** 明确预算后先 72 小时，再 7 天；覆盖空闲、新需求、缺陷、重复通知、知识更新、测试失败、审批等待、停服/重启及容量告警。离线虚拟时钟只能辅助，不能代替真实耐久验收。

必须有证据的判据：空闲不产生推理请求；重复事件不重复派工；完成节点不重做；未知写入/费用不自动按成功或零处理；摘要/恢复后的任务合同与知识版本一致；未经授权资料和写操作被阻断；未通过测试不被接受；成本/数据增长在批准范围内；用户通过部门页面找到成果、阻塞和需要决策的事项。

候选安装、实际 Windows 运行、资源占用、真实中转站模型适配、生产数据迁移和连续 7 天试点均未验证。本轮调研完成不等于这些功能已经接通，也不自动批准新的付费试验。
