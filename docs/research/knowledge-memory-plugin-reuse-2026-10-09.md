# 为伍知识沉淀和长期运行插件选型

日期：2026-10-09。为伍已有 DSH 员工执行、OpenShell 隔离、知识授权与版本固定；下一阶段需要工作关联、容量治理、经验审核和能力复用。优先复用官方上下文、持久化、Skill 和工具服务，记忆候选重点比较 MemOS local plugin 与 dsh-mnemon。部门删除转交、证据保护和公司权限仍由为伍负责。

本轮状态为只读调研与本地依赖检查。没有安装或升级候选，没有调用中转站模型，没有启用遥测或修改生产数据。下面的可接入程度是选型判断，集成验收仍待完成。

## 市场入口与当前版本

[DSH 社区插件目录](https://github.com/dshplugin-app/deepseek-harness-plugins)用于发现候选，实际能力与依赖以维护者源码为准。[DSH 官方仓库](https://github.com/deepseek-ai/deepseek-harness)仍标开发预览并提示兼容性变化。

为伍固定 DSH `0.1.5-rc.1`、Cordis `4.0.2`，网页使用 React `19.1.1`。产品是自有 React/Express 网页和定制员工 Host；安装到 DSH 原生 Web profile 的插件不会自动成为为伍功能。

本地实际解析了 11 个官方组件，它们都是 `0.1.5-rc.1`、MIT。Token 测量、压缩及工具缩减在 `employee-context.mjs` 中接入，持久化及检查点在 `employee-hosts.mjs` 中接入。其余包能从当前依赖解析，不表示已经挂载或通过产品验收。

## 可复用的 DSH 组件

| 需求 | 现成组件 | 对为伍的落点及边界 |
| --- | --- | --- |
| 长上下文 | [compaction-basic](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-basic/README.md)、[tool-result-pruner](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/compaction/compaction-tool-result-pruner/README.md) | 已接入员工上下文；继续保留预算和原始证据保护。摘要调用收费，工具缩减本身不调用模型；缩减不清除原始日志。 |
| 中断持久化 | [session-checkpoint-policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md)、JSONL persistence、session-query | 已接入员工 Host；保留为伍的 DAG、费用和文件版本恢复。中断操作结果未知，不自动重放。 |
| 大工具输出 | [spill-policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/spill/spill-policy/README.md)、[spill-local](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/spill/spill-local/README.md)、[output-retention](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/util/output-retention/README.md) | 可以复用预览与全文引用。output-retention 是库，不是可挂载插件。spill-local 只在启动时按文件年龄清理自己的输出文件，不管理整个项目磁盘。 |
| Skill 加载 | [skill-filesystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md)、[tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md) | 已在依赖中；复用目录发现、目录摘要和按需读取，补部门授权、审核发布及批准版本绑定。插件提供加载机制，不等于已经自动提炼经验。 |
| MCP 工具 | [mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) | 已在依赖中；接外部工具时保留为伍的白名单和审批。当前包桥接 tools，未提供 resources/prompts；工具定义也占上下文。 |
| 历史搜索 | [session-query-sqlite](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-query-sqlite/README.md) | 可选 FTS5 派生索引和分页历史查询；不能替代知识授权或不可变文档版本。 |

spill-local 默认 `cleanupPeriodDays=30`，`0` 禁用清理；常驻进程不会定时再扫。适配时先关闭其自行清理，将输出纳入为伍的引用保护与保留策略。需要周期回收的 `node_modules`、构建目录、测试现场、沙箱和备份不在这个组件的清理范围内。[清理定义](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/spill/spill-local/README.md#startup-cleanup)

## 两个记忆候选

### dsh-mnemon

[维护者仓库](https://github.com/omdsh-dev/dsh-mnemon)提供运行记忆、项目文档、长期 Memory Spaces，具有关系视图、引用记录、去重与受监督写入。它有可替换的 Source、Strategy、Provider 和 headless 入口，适合评估分层记忆与检索；其实体关系图还需要映射为伍的部门、任务、交付关系。[能力与扩展边界](https://github.com/omdsh-dev/dsh-mnemon/blob/main/docs/en/guides/capabilities.md)

本轮读取的 main 包清单为 `0.5.25`、MIT、Node ≥20，peer 要求 Cordis `^4.0.4`、DSH `^0.1.7-rc.2 || ^0.2.0-rc.1`、React `^18.2.0`。与现有为伍版本不匹配；headless 模式也不能作为自动兼容旧 Host 的证明。版本是源码 manifest，不是 npm 安装验证。[包清单](https://github.com/omdsh-dev/dsh-mnemon/blob/main/package.json)

选择：关系视图和分层记忆的主要候选；在隔离环境比较可复用核心接口与兼容版本，暂不将整包加入当前运行环境。公司业务关系以现有主库为准，避免另建一份组织账本。

### MemOS local plugin

[MemOS local plugin](https://github.com/MemTensor/MemOS/tree/main/apps/memos-local-plugin)提供 trace、策略、环境知识及 Skill 沉淀，核心算法与 Agent 适配器分离。DSH 适配有有界召回、后台 capture 和记忆工具。默认轻量模式不会运行完整的 LLM 奖励与演化恢复链路，不能把安装成功当成 Skill 自动沉淀已经启用。[核心说明](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/README.md)、[DSH 适配说明](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/adapters/deepseek-harness/README.md)

本轮 main 包清单为 `2.0.16-beta.1`、MIT、Node ≥20；DSH 初始验证目标是 `0.1.0-rc.5`，测试依赖是 `0.1.0-rc.6`。源码 manifest 与安装文档的 `2.0.16` 发布表述不同，需在试验前固定真实 npm tarball 或提交。[包清单](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/package.json)

关键缺口：后台写入属于最终一致；强制退出可漏掉 capture，恢复的 DSH 会话不会重发原事件。Viewer 是独立本地端口，不是为伍网页组件。自动召回只响应直接用户 turn，不能推定员工任务交接都会触发；树外插件是可信后端代码，不在员工工具沙箱内。选择它需要以为伍持久事件与去重回执补记，并接入员工资料范围、批准版本和预算。[适配限制](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/adapters/deepseek-harness/README.md#known-limitations)

选择：经验到 Skill 的重点隔离试验候选；先测试核心及最小 DSH 适配，关闭自动发布和额外后台模型流程。全部整理与评分调用要通过现有预算门禁，产出先进入为伍待审核候选。

## 监管评测和备份

| 候选 | 选择与边界 |
| --- | --- |
| [dsh-context](https://github.com/bowenliang123/dsh-context) | 展示上下文组成和变化。当前 main manifest `0.66.1`、Apache-2.0，要求较新 DSH/Cordis 和 React 18；优先参考或适配投影，不直接装入 React 19 网页。[依赖](https://github.com/bowenliang123/dsh-context/blob/main/package.json) |
| [Promptfoo](https://github.com/promptfoo/promptfoo) | 优先采用现成评测配置、CLI 和 Node 自定义 Provider，对接为伍测试输出及经验检索结果。确定性回归与真实模型评分分别记录；评分调用纳入预算。[Provider 接口](https://www.promptfoo.dev/docs/providers/custom-api/) |
| [Langfuse](https://github.com/langfuse/langfuse) | 有追踪和评分平台，可自托管，核心 MIT、ee 目录另有许可。需要新增服务和 trace 适配；先用现有时间线，后续确需集中监管再引入。[维护者说明](https://github.com/langfuse/langfuse#-license) |
| [Waku Agent](https://github.com/ShenSeanChen/waku-agent) | 沿用既有源码调研，参考回合到工具及评分的关联；是另一套 Python Harness，不作为 DSH 插件整套并入。详见已有 Waku 调研。 |
| [restic](https://restic.readthedocs.io/en/stable/060_forget.html) | 备份保留和空间回收候选；复用快照保留、forget/prune 和预览能力。数据库仍需先生成一致快照，不能将备份 prune 当作项目工作区清理。 |

特别说明：为伍锁定 `0.1.5-rc.1` 的 `session-telemetry-otel` 只接受 `FEEDBACK_ONLY` 和 `DISABLED`，`FULL` 被拒绝，不能直接充当连续全量员工监控。后续 OTel 对接需使用独立事件适配与脱敏策略，默认不向外发送公司资料。该结论来自本地安装包 README，不能与较新 DSH 文档混用。

## 本地版本匹配检查

本轮使用现有 Node 和 semver，实际得到：

| 当前版本与候选范围 | 默认 satisfies | includePrerelease |
| --- | --- | --- |
| `0.1.5-rc.1` 对 `^0.1.7-rc.2 || ^0.2.0-rc.1` | false | false |
| `0.1.5-rc.1` 对 `>=0.1.0-rc.5 <0.2.0` | false | true |

因此 MemOS 看似覆盖 `<0.2.0` 的 peer 范围，也不能据此声称预发布依赖匹配或 API 兼容；不能简单忽略 peer 警告。11 个官方包的实际解析全部成功：compaction-basic、compaction-tool-result-pruner、session-checkpoint-policy、output-retention、spill-policy、spill-local、session-telemetry-otel、skill-filesystem、tool-skill、mcp-client、session-query-sqlite。

## 下一步调整

1. 保留现有官方上下文与检查点；先组合验证 spill、输出限制和批准 Skill 目录，不重写通用能力。
2. 用少量虚构资料隔离比较 MemOS 与 dsh-mnemon：能否按授权检索、固定引用版本、去重写入、重启补记、删除记忆、备份恢复。先做不收费的核心与协议回归，真实效果再用批准预算验证。
3. 工作记录继续来自为伍主库；成熟记忆组件只负责经验整理与检索。经验发布和工具启用复用现有审核，不启用无界自演化。
4. 部门归档恢复、工作转交、历史边、共享知识权限，以及清理前的恢复引用检查属于为伍业务逻辑。本轮没有找到能直接覆盖这些规则的插件。
5. 一种记忆核心通过验收后再接网页；不同时运行多套记忆写入、索引与后台整理，避免增加重复数据和模型费用。

候选验收完成后才调整生产版本。当前没有候选安装成功、真实记忆效果或新网页功能的验收结论。
