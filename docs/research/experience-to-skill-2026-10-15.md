# 工作经验自动提炼为 Skill 的开源实现调研

日期：2026-10-15。范围是工作轨迹、纠错与验收反馈如何形成可复用方法，以及后续员工如何发现和加载。本轮核查维护者文档、实际源码、固定提交和依赖清单；未安装插件、未修改生产环境、未调用模型。

结论：已有可复用实现。Hermes 的产品行为最接近“做过一次复杂工作后主动保存 Skill”；MemOS 提供 TypeScript 提炼与生命周期组件及 DSH 适配，是为伍优先隔离评估的候选。SkillX 适合作为独立离线提炼对照；ReMe 主要解决经验知识的整理与检索；ACE 主要沉淀策略。尚无证据证明任何一个能直接接管为伍的部门授权、预算、不可变引用和中断恢复。

## 主要候选

| 项目 | 已核实的实现 | 为伍可复用的部分 | 当前限制 |
| --- | --- | --- | --- |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | 前台及后台复盘可创建、修订 Skill，按需读取正文；写入可暂存待审 | 从调试、纠错中提炼步骤，优先更新已有方法，控制技能文件增长 | Python 完整 Agent，后台复盘与自身运行器耦合，不是直接插入 DSH 的提炼插件 |
| [MemOS local plugin](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin) | 轨迹→策略→Skill 草稿、证据校验、试用反馈及退役；已有 DSH 适配 | 提炼器、候选生命周期、来源关联、失败降级 | 当前适配版本与为伍须实测；轻量模式不代表启用完整演化；异步捕获有崩溃缺口 |
| [SkillX](https://github.com/zjunlp/SkillX) | 从成功轨迹提取规划、功能和原子技能，过滤、聚类合并、更新并保存检查点 | 批量轨迹到结构化经验的提炼与去重 | Python 研究管线，格式不等于标准 SKILL.md；多阶段 API 和重试需受预算控制 |
| [ReMe](https://github.com/agentscope-ai/ReMe) | 来源记录→daily→digest/procedure，自动归纳及修订经验；提供 HTTP/MCP 和 DSH 插件 | 公司经验节点、来源、链接和检索 | 程序性知识不等于自动生成可发布 Skill；当前 DSH 插件依赖高于为伍锁定版本 |
| [ACE / Agentic Context Engine](https://github.com/kayba-ai/agentic-context-engine) | 从已有轨迹与反馈提炼、增量维护 Skillbook 策略 | 经验反思、局部更新、避免整份经验反复重写 | Skillbook 不是标准 Skill 包；递归分析可能执行 Python，需受现有沙箱与授权约束 |

以上适用性排序为本轮工程判断，不是兼容性或效果实测结论。可查看下方对应的一手源码。

## Hermes 是最接近目标的产品参照

Hermes 明确区分常驻的小型记忆与按需加载的程序性 Skill。遇到值得重复的多步工作、绕过错误找到正确路径、被用户纠正时，员工可调用 `skill_manage` 创建或修订方法。支持有针对性的 patch，优先归入已有主题；方法正文与 references 应描述通用规则，而非为每次会话新增一篇事故日志。[Skill 文档](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/website/docs/user-guide/features/skills.md)

`skills.write_approval` 可把技能写入暂存为待审变更，跨重启保留，再批准或拒绝；默认自由写入，需要显式开启门禁。后台复盘本身调用模型，可选择辅助模型，不是免费规则功能。[后台复盘文档](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/website/docs/user-guide/features/memory.md)、[实际后台实现](https://github.com/NousResearch/hermes-agent/blob/7bda2a3368024f7ae1c70cef16583e7c2c891674/agent/background_review.py)

这说明首次有价值工作可以先起草候选；多次成功可用于提高可信度，不必把“达到三次”作为所有新经验登记的前置条件。为伍当前默认三工作门槛属于已有自动推荐规则，本轮未修改它。借鉴 Hermes 不要求替换现有 DSH 运行器。

## MemOS 有提炼核心 但不能安装即视为完成

`core/skill` 接收策略和相关轨迹证据，调用 LLM 形成结构化步骤、参数和示例，检查命令与证据的覆盖，再保存为试用状态。试用成功、失败和反馈会影响可靠度及状态。其启发式校验不是业务测试或独立 QA 的替代。[组件说明](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/skill/README.md)、[提炼实现](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/skill/crystallize.ts)、[生命周期](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/skill/lifecycle.ts)

固定提交的包清单为 `2.0.16-beta.1`，子包声明 MIT；根仓库为 Apache-2.0，实际分发前需保留相关许可与声明。适配文档的初始测试目标是 DSH rc.5/rc.6，为伍是 `0.1.5-rc.1`、Cordis `4.0.2`；宽泛 peer 范围不能证明预发布版本兼容。[包清单](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/package.json)

文档明确：只由直接用户 turn 自动召回；员工任务交接不一定触发；轻量模式不运行完整的奖励/演化恢复；强制退出可能留下未捕获 turn。插件在可信后端进程运行，不能把它视作受员工沙箱约束的工具。辅助模型接入 DSH 也不自动接入为伍预算。[DSH 边界与限制](https://github.com/MemTensor/MemOS/blob/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/adapters/deepseek-harness/README.md)

优先试验提炼组件与可注入的 LLM 接口，输入为伍已经封存且允许共享的证据，输出写入原待审候选。是否能直接调用打包产物、需带入多少组件依赖，应由隔离加载验证决定；当前没有宣称它是零适配的独立 npm 提炼 SDK。

## SkillX 是较完整的离线提炼对照

已实际定位 `pipeline.py`、`core/skill.py`，不能因为 README 的旧发布预告就认为没有代码。管线筛选成功轨迹，提炼计划与技能，再过滤、聚类合并并保存检查点；不需要先训练员工模型。[实际管线](https://github.com/zjunlp/SkillX/blob/b0047c848dbbcf019363d6d56eef8c558f69aefc/pipeline.py)

LLM 客户端支持 `base_url`，可以评估使用已有云端模型 API；默认输出与最多十次重试不能直接照搬到为伍。其输出为结构化技能库，还需映射成原候选与 DSH 方法。过滤和多次模型判定不等于隔离执行测试；真实重试及费用须经为伍统一入口。[LLM 客户端](https://github.com/zjunlp/SkillX/blob/b0047c848dbbcf019363d6d56eef8c558f69aefc/llm/client.py)

## ReMe 和 ACE 的定位

ReMe 的 `auto_memory` 整理来源，`auto_dream` 把 daily 归纳到 digest，其中包括 procedure。更接近公司知识库里的可读经验节点，而非自动发布标准 Skill。文件是事实来源，索引可重建。[记忆层次](https://github.com/agentscope-ai/ReMe/blob/d865776eddb9e116055624ed8b51e6338964ae57/docs/en/memory_as_file.md)

DSH 插件 `0.1.1` 当前固定 `0.1.7-rc.2` 和 Cordis `~4.0.4`，不能忽略依赖强装到现有 Host；可另外评估 HTTP/MCP 接口。当前只核对能力，不新增另一套知识主存储。[插件清单](https://github.com/agentscope-ai/ReMe/blob/d865776eddb9e116055624ed8b51e6338964ae57/integrations/dsh/package.json)、[集成说明](https://github.com/agentscope-ai/ReMe/blob/d865776eddb9e116055624ed8b51e6338964ae57/integrations/dsh/README.md)

ACE 的 `TraceAnalyser` 可消费已有轨迹，不要求重跑原工作；反思者与 SkillManager 增量更新 Skillbook，支持 API 模型，无需微调。当前 Kayba 实现的 Recursive Reflector 会编写、执行 Python；不能脱离原沙箱直接处理生产数据。它更适合策略整理，标准 Skill 包与业务审批仍需连接。[维护者说明](https://github.com/kayba-ai/agentic-context-engine)、[架构](https://github.com/kayba-ai/agentic-context-engine/blob/3a319831785ede6ba4a3a4002756233095c59e17/docs/design/ACE_ARCHITECTURE.md)

ACE 有多个同名实现，本轮主候选明确为 Kayba 的 `agentic-context-engine`，不把社区复现当作论文作者仓库。

## 暂不作为主选

- [SkillRL](https://github.com/aiming-lab/SkillRL)有经验蒸馏和动态技能库，但整体是 SFT/RL 训练路线，包含 vLLM、FlashAttention 等。可参考蒸馏结构，不在 JJ 部署整套训练或本地大语言模型。
- [SkillLoop](https://github.com/lamenting-hawthorn/SkillLoop)有轨迹→候选→人工审核的状态机，但维护者明确当前评估器是启发式、蒸馏仍基础，未接 LLM judge。适合参考可监管流程，暂不认为它解决了高质量语义提炼。
- [pskoett self-improvement](https://github.com/pskoett/pskoett-ai-skills/blob/5a836dc7163da6799fe34ed4283da6d7f0358f14/skills/self-improvement/SKILL.md)记录错误、纠正和经验，提供抽取脚手架；流程仍要求填写方法正文、再验证，不能把模板生成称为完整自动提炼。GitHub API未识别该仓库许可，复用前还须核对授权。

## 为伍的建议与试验顺序

1. 保留现有 DSH、运行档案、知识主存储、版本和候选发布入口。先对 MemOS 固定版本做隔离加载和接口试验，以 SkillX 作为离线提炼对照；Hermes 用于核对生成、修订及按需加载行为。此项尚未开始安装或开发。
2. 仅取已获准共享的工作证据：目标、工具输入输出、交付版本、真实 QA/经理反馈及采用说明。原始档案保留；提炼结果不能修改原工作是否成功。
3. 提炼器只输出待审方法：触发条件、步骤、边界、反例、验证方法及来源。先匹配已有方法，优先更新，防止每次任务生成一个重复 Skill。新增模型请求必须接现有预算、收据及未知费用规则，不开放插件自行直连 Key 的第二条计费路径。
4. 使用小样本检查：成功工作能提炼；失败能形成警示但不变成通过；无依据步骤被拒绝；同一恢复任务不重复产出；未授权资料不被纳入。新方法先经独立验证，再通过原发布门禁。
5. 后续员工继续通过 `capability_search`、`knowledge_read`、官方 `skill` 自主选择与按需加载；采用声明加真实任务验收才计成功。固定版本与恢复规则不变。记录耗时、Token、费用与相同条件基线；没有实际对照，不引用上游百分比作为为伍收益。

以上是建议的后续试验，不是已经完成的集成或用户批准的新预算。学习推理使用现有模型 API，JJ 只运行软件与轻量组件；不安装或训练本地大型语言模型。

## 调研快照与验证边界

[仓库固定提交与许可](evidence/experience-to-skill-2026-10-15/repositories.json)、[已读取源码哈希](evidence/experience-to-skill-2026-10-15/source-manifest.json)。源文件只读副本放在 `.data/experience-skill-research-20261015`，没有执行外部代码。未验证实际安装、对现有 DSH 的兼容性、提炼质量、费用、速度和断电恢复；没有以源码里的测试目录或上游性能报告代替本项目实测。
