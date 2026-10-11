# 为伍：工具发现与复用选型

日期：2026-10-11。范围：先调研员工自主发现公司知识、Skill 和工具，以及外部新能力的来源。未安装依赖、未改产品代码、未调用中转站模型、未改 JJ 服务或生产数据。本文是选型结论，不是候选集成验收。

## 结论

有可直接复用的组件，但本轮没有找到一个成熟插件能完整覆盖为伍的公司授权、固定版本、断点恢复、实际采用记录和经验发布闭环。

推荐保留现有 DSH Skill 注册/加载、知识检索与 MCP 连接；增加薄的公司能力目录连接。外部发现复用 DSH 社区目录、MCP 官方 Registry、Vercel Skills。工具目录明显增大时，隔离验证 FastMCP Tool Search；目前不为八个产品基础工具引入独立网关。IBM ContextForge 留作以后集中管理多个外部 MCP 服务的候选。

## tool_research 与 tool_search

用户所说的 `tool_research` 可以理解为“判断有没有现成能力可复用”的工作流程。它包括查公司目录、查外部候选、阅读维护者文档、检查适用性并提交接入建议。

`tool_search` 则通常指“在已经启用的工具目录中检索匹配工具”的机制，不等于互联网调研，也不等于安装权限。

本轮检查为伍的 `PRODUCT_TOOL_NAMES` 和运行时源码：已有 `knowledge_search`、`knowledge_read`、`browser_read`、`mcp_call_readonly` 等八个产品基础工具，以及批准 Skill 的 `skill` 加载器；没有名为 `tool_research` 的员工工具。不能把 Codex 本轮网页调研当成产品员工已经具备外部能力发现。

## 候选比较

| 候选 | 能解决什么 | 对为伍的判断 |
| --- | --- | --- |
| [DSH skill / tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md) | 目录摘要、员工按名称加载完整 Skill、目录变化记录 | 第一优先。现有批准 Skill 已接入；把获授权公司方法接入同一注册器，不另造 Skill 加载器。它不负责经验提炼、成功采用统计或公司权限。 |
| [DSH mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) | 将外部 MCP 工具接入 Harness | 沿用现有版本与产品白名单。当前安装的 0.1.5-rc.1 README 明确仅桥接 tools，并说明工具定义占请求上下文；不把最新版其他包的能力算进当前产品。 |
| [FastMCP Tool Search](https://gofastmcp.com/servers/transforms/tool-search) | 把大量工具定义收敛为 `search_tools` 与 `call_tool`；Regex 或 BM25 检索；限制返回数量 | 最贴合“员工自主找工具、按需取定义”的现成组件。BM25 不需要额外模型排序调用；新增 Python 服务及适配成本，先作为目录扩大的试验候选。搜索隐藏不构成访问授权。 |
| [MCP 官方 Registry](https://github.com/modelcontextprotocol/registry) | MCP Server 元数据发现、版本与发布命名空间来源 | 外部 MCP 候选来源。读取现有 API 即可，不必自托管整个目录。维护者 README 仍保留 preview 与 v0.1 API freeze 的说明；命名空间验证不证明工具安全、费用合理或适合当前任务。 |
| [Vercel Skills CLI](https://github.com/vercel-labs/skills) | `skills find` 搜索方法；列出、获取、管理 SKILL.md 包 | 外部 Skill 获取优先候选。只读发现后固定来源提交，接入为伍已有加载器；不让员工直接安装到宿主机全局目录。需关闭默认遥测，私有公司任务不送入公共搜索。 |
| [dsh-market](https://github.com/dsh-market/dsh-market) / [DSH 社区目录](https://github.com/dshplugin-app/deepseek-harness-plugins) | 插件搜索、来源信息、兼容性提示；市场提供原生 DSH Web 安装界面 | 用作发现来源，不整套搬入为伍网页。为伍是自有 React/Express 网页与定制员工 Host，原生 Web profile 插件安装不会自动成为为伍功能。市场声明的兼容性不是我们的实测。 |
| [AwesomeHou/dsh-plugin-marketplace](https://github.com/AwesomeHou/dsh-plugin-marketplace) | 维护者描述包含 `market_search` / `market_install` 员工工具 | 可作为员工外部搜索入口的进一步源码候选，成熟度与当前 Host 兼容性未验证。发现和安装要分开，不能直接授予 `market_install`。 |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) | 集中 MCP 网关、RBAC、观测、管理界面 | 组织规模扩大后的候选。是完整服务，生产部署有数据库等运营成本；当前 MVP 已有授权和连接管理，暂不引入第二套组织权限账本。[权限设计](https://github.com/IBM/mcp-context-forge/blob/main/docs/docs/manage/rbac.md) |

这些项目不是同一种工具。DSH 负责员工执行能力的装配；FastMCP 负责已启用工具的按需发现；市场和 Registry 负责外部候选发现；记忆插件负责内容整理与召回。任何一个单独安装都不会自动完成工作沉淀。

## 版本与成熟度依据

以下是读取到的源码 manifest，不是 npm/PyPI 最新发布或安装成功证明：

- 为伍本地：DSH `0.1.5-rc.1`、Cordis `4.0.2`。`approved-skills.mjs` 已挂载官方注册器/加载器，并记录 `skill/catalog` 与 `skill/loaded`；现阶段来源仍是批准的运行资料。
- [dsh-market main manifest](https://raw.githubusercontent.com/dsh-market/dsh-market/main/package.json)：`1.66.15`、MIT，Cordis peer `^4.0.1`；另有 DSH settings peer 与原生 Web UI 依赖。不能仅凭 Cordis 匹配就宣称整包兼容。
- [Vercel Skills main manifest](https://raw.githubusercontent.com/vercel-labs/skills/main/package.json)：`1.7.2`、MIT；仓库提供测试、CLI 和多种 Agent 目标。具体 Skill 包仍有各自许可证与适用条件。
- [FastMCP main manifest](https://raw.githubusercontent.com/PrefectHQ/fastmcp/main/pyproject.toml)：Apache-2.0、Python ≥3.10，版本动态生成。Tool Search 文档区分 Regex/BM25 与实验性 Jev；本次建议只评估不需要额外模型 API 的前两种。
- [AwesomeHou master manifest](https://raw.githubusercontent.com/AwesomeHou/dsh-plugin-marketplace/master/package.json)：`0.3.1`、MIT；未做安装与接口稳定性验证。

选择成熟度以维护者接口文档、测试与发布机制、部署依赖、权限边界和当前版本适配为依据，不以目录排名、星数或插件数量替代兼容性验收。DSH 仍是开发预览；优先采用现有已验收组件，避免为了新插件整体升级 Harness。

## 推荐的为伍流程

1. 员工拿到固定目标和验收标准，先检索其获授权的公司知识、Skill、工具摘要目录。
2. 员工判断完全适用、部分适用或未找到；选择后读取具体方法或工具定义，固定版本。
3. 执行时仍通过原有工具权限、预算、沙箱和审批。工具搜索或通用 `call_tool` 不能绕过底层工具的逐项授权。
4. 记录检索命中、读取、实际采用、验证结果四类事件。读取或工具调用不能直接计为成功经验；同一任务恢复不能重复计数。
5. 未命中时按现有流程完成新工作并登记。只有确实缺少工具时才触发外部 research，查询公共用途描述，避免发送公司私有材料。
6. 外部候选保存来源、固定版本、许可证、依赖、权限、费用与兼容性证据；隔离验证通过后进入公司目录。员工负责发现与建议，后台安装代码的授权沿用产品既有规则。
7. 多个不同任务真实成功复用后形成经验/Skill/工具候选；独立 QA 和经理审核发布。为伍主库保留工作与证据关系，避免再复制整套原始会话。

[DSH 官方 plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md)提供 profile 级插件管理，模型工具在 Creator 模式使用；它会改变宿主组合和依赖，适合管理入口，不直接授予普通员工。源码最新版存在，不表示当前锁定版本已经安装或启用了它。

Vercel CLI 的 [遥测开关](https://github.com/vercel-labs/skills#environment-variables)支持 `DISABLE_TELEMETRY=1` / `DO_NOT_TRACK=1`；试验中同时关闭遥测与公共源安全审计请求，内部授权仍由为伍保证。

## 下一步最小验证范围

先验证既有 DSH 注册器/加载器和现有知识、MCP 接口能否完成公司目录发现，之后才决定是否增加 FastMCP。优先使用虚构资料和本地协议回归，不消耗模型预算。

| 验证 | 必须观察到的结果 |
| --- | --- |
| 找到已有方法或工具 | 员工可自行选用，来源和固定版本可追溯 |
| 部分适用或无结果 | 可继续原任务，不被迫采用最接近但错误的工具 |
| 两名权限不同员工检索 | 无权目录、正文和工具执行均不能获取 |
| 修改目录后恢复旧任务 | 沿用旧批准版本，禁止静默升级或重放未知操作 |
| 读取但没有采用 | 仅记读取，不增加成功复用次数 |
| 实际采用并重启补记 | 采用与真实测试关联，持久记录不重复 |
| 大目录按需加载 | 对比每次请求的工具定义 Token、检索耗时、总调用成本；不预先承诺提速 |
| 外部候选不可用 | 保存失败理由，原任务走可用方案，不循环安装或反复搜索同一失败路径 |

公司授权、工作采用关系、恢复幂等和审核发布属于为伍产品业务连接，仍需少量实现。沿用 [工作沉淀需求](../knowledge-learning-loop.md) 与 [此前记忆插件调研](knowledge-memory-plugin-reuse-2026-10-09.md)，本轮不重复引入 MemOS、dsh-mnemon 或图数据库。

## 本轮未验证事项

候选的真实安装、当前 Host 兼容、员工自主选择质量、中文检索效果、实际 Token/速度收益均未验证。没有新的模型调用、安装、运行任务或沙箱操作；仅新增这份调研记录。外部目录访问失败与公共 API 变化需在后续适配中显式处理。
