# 编排模板与自动匹配：开源实现源码调研

日期：2026-10-18。目的：回答“有没有做好的实现、怎样复用到为伍”。结论基于安装包、本次固定提交源码和官方文档；没有安装候选、运行候选插件、调用模型或更改 JJ 服务。此前的[对象关系与流程建议](orchestration-template-routing-2026-10-18.md)继续有效。

## 结论

存在可复用的实现，但本次没有找到经核验可直接覆盖“存储抽象编排 → 按任务匹配 → 绑定现有部门员工或临时团队 → 保留为伍权限、费用、恢复和验收”的完整插件。

建议保留已安装的 AgentTeams 执行机制；优先隔离核验其 Profile 接口，以及 team-gui 的配方定义/版本能力能否独立复用。Cortex 的历史策略匹配和效果回写是更接近用户设想的算法对照，但不能按默认阈值直接自动执行。LangGraph 与 CrewAI 可作为第二套对照，不为这一需求立即迁移运行框架。

“保存团队”“选模型”“按任务选择协作流程”是不同能力，README 的 dynamic/smart 不能直接证明第三项已完成。

## 候选比较

| 实现 | 源码或文档确认的能力 | 与需求的差距 | 当前建议 |
| --- | --- | --- | --- |
| [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams) | 已安装 0.1.20；命名 Profile、固定 seed 和 captain 动态任务图、原生团队调度 | Profile 是配置入口，不是公司模板搜索产品；种子任务无法承载完整为伍合同 | 执行底座直接沿用；隔离验证模板入口 |
| [dsh-agent-team-gui](https://github.com/toolclub/dsh-agent-team-gui) | 1.3.0；团队/成员定义、版本、recipe 导入、模型路线重映射、动态 DAG、适应性成员选用 | 当前自动会话入口先取得选中的 squad；不能据此认定有跨全模板库的自动匹配。原生 Web/storageDomain 依赖较多 | 优先调查定义和 recipe 组件的有限集成，不默认启用其第二套运行记录和账本 |
| [dsh-cortex](https://github.com/iguowz/dsh-cortex) | 0.3.0；任务特征、历史策略匹配、策略版本指标、生成下一任务的拆解建议；另有模型路由 | 自有任务、预算、模型池、治理及恢复体系；策略相似度不检查为伍授权。department 模式主要是治理探针，不等同于我们的长期部门员工 | 匹配和模板反馈的源码参考/隔离对照；不整包接管生产 |
| [LangGraph JS](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) | 结构化路由、条件边、并行及 orchestrator-workers | 提供编排构件，模板目录、公司组织映射和质量数据仍需产品实现 | 作为通用路由对照，暂不增加第二套执行器 |
| [CrewAI Flows](https://docs.crewai.com/v1.15.28/en/concepts/flows) | Python Flow 组合任务与 Crew，支持事件、状态、条件路由 | 不是 DSH 插件，迁移现有 TS 和已验证运行链成本更高；自动选模板不是装包后自然出现 | 参考 Flow/Team 分层，当前不迁移 |
| [dsh-workflow](https://raw.githubusercontent.com/ImMappyJ/dsh-workflow/main/package.json) | 搜索缓存描述 Workflow Template/Version；缓存包清单 0.1.6、MIT、含 postinstall 自动登记脚本 | 本次 GitHub 仓库页面、README 和实时 API 均返回 404，无法核实当前可获得源码；缓存不等于仍可安装 | 排除出首选，不能据缓存宣布可直接用 |

市场入口：[DSH Plugin Registry](https://dshplugin.app/plugins)。目录用于发现，选型以维护者源码和当前安装版本为准。没有通过星数或作者宣称推断“生产成熟”。

## 固定版本与源码证据

已下载到隔离研究缓存，只读审查，文件 SHA256 见[来源清单](evidence/orchestration-reuse-2026-10-18/source-manifest.json)。没有执行下载源码。

- team-gui：`9e952e0681d528975444568b70f3c554ac2984be`，包版本 1.3.0，MIT；官方 GitHub API 当时返回 archived=false。
- Cortex：`e2a9acacf7255678220dd927c4348db03851d6d7`，包版本 0.3.0，MIT；官方 GitHub API 当时返回 archived=false。
- AgentTeams：本地实际安装的 `services/agent-runtime/node_modules/@nanmicoder/dsh-agent-teams/package.json` 及 `lib/profiles.js` / `lib/types/profiles.d.ts`，版本 0.1.20。

### AgentTeams：现成执行模板接口

安装包提供 `profiles` 和 `taskPlanning: seed | captain`。每批 Profile 上限 16，每项种子任务上限 32。任务字段限定 id、subject、description、assignee、dependencies；必须保留为伍自身的完整合同校验和确认快照。现有 Host 尚未传入 profiles 配置，已通过原生 create_task 工具逐个暂存批准任务。

下一探针须验证 Profile 的选择/实例化能否接入原有暂存和批准流程，不能调用自动执行路径绕过用户确认。不能 deep-import 未公开导出的 profiles 内部文件作为长期接口。

### team-gui：保存/导入团队强，整库自动匹配未证实

- [入口源码](https://github.com/toolclub/dsh-agent-team-gui/blob/9e952e0681d528975444568b70f3c554ac2984be/src/index.ts)：根导出 AgentTeamService 与 recipe/record schemas；服务依赖 storageDomain、tools、subagents、llm、agents、sessions、systemPrompt。自动会话路径先读取 session/project 的 squad 选择，然后派发。
- [定义服务](https://github.com/toolclub/dsh-agent-team-gui/blob/9e952e0681d528975444568b70f3c554ac2984be/src/tools/application/definition-service.ts)：定义、版本和导入逻辑已从执行逻辑分层，但仍依赖 Cordis Service/KvTable；内部 DefinitionApplicationService 没有在根入口单独公开导出。
- [配方解析](https://github.com/toolclub/dsh-agent-team-gui/blob/9e952e0681d528975444568b70f3c554ac2984be/src/tools/recipes.ts)：具备 schema 校验、缺失/多余成员引用检查和路线重映射等可复用逻辑；同样不能把内部文件当作稳定公共模块。
- [包清单](https://github.com/toolclub/dsh-agent-team-gui/blob/9e952e0681d528975444568b70f3c554ac2984be/package.json)：声明的 DSH peer 范围覆盖 0.1.5-rc.1；这不是在为伍上的实际兼容证明。

可选接法：公共 schema/完整服务的受限集成，或在确认无稳定接口后保留 MIT 归属引用并有限复用定义模块。先验证成本，不预先承诺整包无适配可用。

### Cortex：最接近“按旧策略组织新任务”的候选

- [任务特征](https://github.com/iguowz/dsh-cortex/blob/e2a9acacf7255678220dd927c4348db03851d6d7/lib/engine/fingerprint.js)：按类型、领域、能力、复杂度、风险、语言和输入规模计算加权相似度；0.9/0.7 是作者设定的复用/轻校验门槛，不是实测准确率或置信概率。
- [服务源码](https://github.com/iguowz/dsh-cortex/blob/e2a9acacf7255678220dd927c4348db03851d6d7/lib/service.js)：`startTask` 调用 `matchStrategy`；后者扫描 active 且 enabled 的 policies，按相似度及版本效果择优。`buildSuggestedTree` 将历史一级拆解模式映射到新任务 ID，并返回任务树建议。因此确有流程复用，不能只把它归类成模型路由器。
- 同一源码同时包含任务、预算、模型、执行、治理和恢复；直接调用 startTask 会创建自身的运行记录，并可能从自身共享预算池分配额度。这与为伍现有审批/费用边界不同。
- [存储源码](https://github.com/iguowz/dsh-cortex/blob/e2a9acacf7255678220dd927c4348db03851d6d7/lib/engine/store.js)使用 JSONL 和内存索引维护策略版本等对象。策略匹配源码仍对全部有效策略打分；不能称为大型模板库检索性能已经验证。

两个需要验证的匹配边界：

1. 匹配函数对空画像的 unknown、空能力集合及默认数值会产生相等项；静态推导两个空画像可得到满分。这里指函数输入边界，未验证所有工具入口是否另行拦截。因此为伍适配层必须拒绝缺关键特征的自动复用。
2. `matchStrategy` 的候选过滤只有 active/enabled，不能代替部门/知识/工具授权、预算适用性、模型能力和运行器拓扑检查。部分旧目标与输出契约由 suggested_tree 原样返回，实例化时仍须按新目标重审，不能连同旧完成状态或权限直接复制。

## 具体实现建议

复用路线：**现有 DSH 调度和 Profile + 可复用定义/导入组件 + 公司已有检索与版本机制 + 必要的任务匹配/员工绑定。**

1. **模板保存**：先保存有限的经过审核的定义，含用途、排除条件、角色槽位、流程依赖、交接/验收合同和版本；与部门实例解耦。Profile/recipe 内容保留来源格式，产品约束存为独立元数据，不污染插件格式。
2. **候选选择**：程序先过滤授权和实际可执行性，复用现有检索缩小候选；在原有规划调用中选择模板/说明不匹配原因。Cortex 特征评分仅作为待测排序对照，低证据和缺特征必须回退。
3. **实例化和确认**：将角色映射到已有员工，对新需求生成具体任务和资源方案；沿用原 validatePlan、确认和封存流程。模板命中本身没有执行权限。
4. **执行与反馈**：继续调用原生团队工具，沿用现有恢复和交付链。将本次结果绑定模板版本，记录成功/失败、耗时、规划及执行 Token、费用、返工；修订先形成候选，不覆盖旧版本。

先支持已有部门；临时团队和跨部门按独立阶段验证。任何新模式都必须声明当前运行器是否支持，不能自动改写为另一个模式却显示“匹配成功”。

## 下一步隔离验证范围

本轮没有进行下列验证，以下为建议顺序：

1. 固定安装版 AgentTeams 用 2 个不同 Profile，在临时目录检查选择、暂存、依赖和批准接口；用本地无副作用测试工具，不调用模型。
2. 检查 team-gui 公共 schema/recipe 是否能单独接入我们的定义存储。若必须启动第二套执行器才可用，停止该接法，记录缺口再选最小适配。
3. 准备至少 24 条人工标注任务，覆盖研发、办公、调研、无匹配、歧义、缺权限、缺画像和不支持拓扑；比较简单规则、现有检索、Cortex 特征评分。报告候选召回、误选、回退和延迟，不先承诺提升。
4. 只有隔离合同与路由评估通过后，才在现有金额和项目授权内安排真实员工的小任务。超出既有项目授权则准备具体提案，不把剩余累计额度视为所有新实验的自动授权。

验收重点：模板版本固定；授权撤销后缓存失效；新任务不继承旧成功状态；独立 QA 不与作者混同；恢复保留原版本/员工/DAG/预算；模板导入不携带凭据；不适配时明确拒绝或回退。

## 状态

- **已核对**：固定安装版接口、两个候选的指定提交源码、MIT 声明、官方框架路由能力。
- **未验证**：候选运行兼容性、真实匹配质量/速度、模板复用节省量和完整网页流程。
- **外部受阻**：dsh-workflow 实时仓库返回 404，只保留线索，不重试安装。
- **本轮改动**：研究报告与来源清单；没有产品代码、依赖、服务或费用变更。
