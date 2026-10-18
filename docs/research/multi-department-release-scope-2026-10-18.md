# 多部门、持续运维、办公与经验工具：范围核对

日期：2026-10-18。用户明确补充：为伍不能只服务研发；需要运维持续监控网站、Word/PPT/Excel 办公，以及经验自动发布为可执行工具。本文前半部分记录初始代码核对和复用选型，当时没有安装插件。后续本地组件验证见文末及单独报告；未修改 JJ、启动付费调用或扩大权限与预算。

## 现有能力与缺口

- `packages/contracts/index.ts` 的部门名称、职责、员工指令可配置，没有研发部门类型限制；目前每部门一个经理、最多六名员工。能够创建运维/行政部门，不代表相应业务已验收。
- `apps/api/src/automation-learning.ts` 的定时派发模式是 `approval-draft`，到期只建 DRAFT；不是预授权后自动处置告警。已有去重、跨重启游标、停止/恢复和记录机制可以复用。参见 `docs/automation-learning.md`。
- `services/agent-runtime/office-files.mjs` 支持 DOCX/XLSX/PPTX 正文提取，以及简单 DOCX/XLSX/CSV 生成。PPTX 生成、复杂样式和公式重算不支持。当前生成入口要求网页粘贴文本/表格，不是员工完整办公工具链。参见 `docs/work-files.md`。
- 现有公司方法通过 DSH Skill 注册器按需加载，校验员工授权、版本和哈希；知识候选人工发布已存在。SkillX 提炼适配已有试验，完整跨任务复用仍需关闭旧验收项。把方法说明转为受管理的可执行工具、自动测试及自动发布，尚未完成。
- 当前产品 MCP 入口为 `mcp_call_readonly`；不能把新写入工具伪装成只读工具接入，也不能把 Codex 会话的办公能力当作为伍已安装能力。

## 初步复用候选

| 候选与来源 | 已查到的能力 | 接入判断及待验项 |
| --- | --- | --- |
| [omdsh-dev/dsh-office](https://github.com/omdsh-dev/dsh-office) | Office 创建、读取、部分编辑；Excel 重算/审计；附带 Skill。仓库 manifest 0.2.5、Apache-2.0；使用 docx、ExcelJS、PptxGenJS 等库 | 优先隔离验证，避免自己维护 Office 格式引擎。声明兼容 DSH 0.1.x 不等于已兼容为伍固定的 0.1.5-rc.1。必须审查文件访问、依赖、公式覆盖、中文排版和员工交付封存 |
| [dream-num/dsh-univer-office](https://github.com/dream-num/dsh-univer-office) | 表格/文档/幻灯片、预览、版本草稿、公式及布局检查 | 更完整的备选。声明版本包括 0.1.5-rc.3，不含当前 rc.1；其原生 DSH 侧栏也不等于为伍 React 网页。渲染要求 Chromium；资源、许可依赖及集成成本需实测 |
| [kw78/dsh-office-tools](https://github.com/kw78/dsh-office-tools) | 八个基础 Office 工具，使用 DSH fs 服务 | 轻量备选，但自己实现 OOXML；PPT 图片仅外链，更新拒绝含二进制部件文档，不足以直接承诺完整办公体验 |
| [Uptime Kuma](https://github.com/louislam/uptime-kuma) | HTTP/TCP/DNS 等持续探测、状态页、通知；[Webhook 实现](https://github.com/louislam/uptime-kuma/blob/master/server/notification-providers/webhook.js)支持事件正文和自定义请求头 | 复用监控器；为伍负责认证后的告警接入、事件去重、派工、预算和授权。尚未安装或验证接入，不把监控器当作自动运维员工 |
| [SkillX](https://github.com/zjunlp/SkillX) 与现有 DSH Skill/工具装配、OpenShell | 复用既有提炼、加载及执行基础 | 不再同时引入另一套记忆/调度系统。工具打包、版本发布、评测证据与权限校验需要为伍衔接；生成候选不等于已可执行 |

其他库备选：[docx](https://docx.js.org/)、[ExcelJS](https://github.com/exceljs/exceljs)、[PptxGenJS](https://github.com/gitbrent/PptxGenJS)。优先评估已有插件，其功能或隔离接口确实不适用时才做必要集成。

## 建议纳入第一版的有限业务范围

1. 研发维持已通过的小项目与恢复证据。
2. 办公完成一套基于同一份资料的 DOCX 报告、XLSX 统计、PPTX 汇报；由员工生成和修改，独立核验计算/内容并检查渲染。不能只验证文件存在或扩展名。
3. 运维完成一个测试网站的持续监控：普通探测不调用模型，异常去重后唤醒员工；在预授权对象、操作与预算内诊断/执行固定处置，越界转审批。明确自动任务授权为新增产品能力，保留原计划默认待审行为。验证故障、恢复、重复告警、服务重启和连续 24 小时记录；部署机需保持开机联网。
4. 经验工具完成一个低风险闭环：从实际工作提炼“巡检记录汇总”候选，员工生成参数化工具和测试；独立 QA 与隔离测试通过后，按预授权发布策略自动进入部门工具目录；另一个任务自主发现、加载固定版本并执行。测试失败、无授权、超预算不得发布；停用阻止新调用，历史证据及恢复引用保留。模型评级不替代程序授权与实际测试。

建议的自动发布首版边界由实现计划明确：只读已授权输入、写本任务输出、不带生产凭据的有限工具可预授权自动发布；生产重启、删除或新增网络/资料权限仍遵守已有审批。发布必须记录来源运行、代码/依赖固定版本、输入输出约定、权限、测试证据和发布状态。复用次数只是推荐信号，不自动证明正确性。

运维原始探测、重复告警与工作临时文件需要独立保留周期和配额；长期保留必要汇总及验收/发布证据，活动任务与恢复所需版本不可被清理。Token、耗时、成功率沿用真实采用记录，只有可比基线才计算收益。

## 下一步顺序与范围边界

### 统一使用外部能力与公司沉淀能力（用户确认）

DSH 官方/社区插件和公司自行提炼的 Skill、MCP、插件应进入同一个获授权能力目录。Skill 使用 DSH 现有 Skill 注册与按需加载；MCP 使用既有 MCP 连接/工具接口；插件遵循 DSH 插件装配机制。统一员工发现和使用入口，不把三种不同载体强制改成一种格式，也不为内部经验另造执行器。

知识记录继续保留经验内容和来源；当其成为已发布能力，知识记录关联对应能力的固定版本及评测证据。公司发布默认是私有目录登记，并不意味着向公共市场上传。目录应显示来源和命名空间以避免重名混淆，按员工授权筛选；新运行选用已发布版本，恢复沿用原批准版本。安装与授权是独立状态，不能将装入 Host 等同全体员工可调用。

首个共用接入验收应同时包含一个第三方办公插件和一个公司生成的小工具/Skill：同一员工能在同一入口发现并组合使用，未授权员工不能获取或执行，重名不覆盖，更新不改变旧任务引用，停用与恢复按既有权限核对。是否需要额外私有包仓库由实际安装机制决定，不先建设一个新市场。

### 已有开源实现复核

用户进一步询问现成开源实现。本轮重新核对一手文档与安装目录：

- [DSH skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill/README.md) 已提供多来源合并目录、提供方注册、重名裁决和按需加载。本地安装包也声明这些能力；`approved-skills.mjs` 已通过 `ctx.skills.registerProvider` 注册 `weiwu-company`，因此公司方法接入 DSH 并非全新功能，缺的是把更多已授权来源接完整。
- [DSH plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) 上游已提供 profile 插件安装、启停和来源检查。本地直接路径尚无此包，不能声称已启用；下一步核对固定版本可用性及 Host 组合依赖，而非自行重写包管理。
- [DSH mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md) 将 MCP 工具注册到 DSH 工具系统，来源可以是公司服务或外部服务。应核对并复用当前版本的连接能力和员工授权，不将上游新增 resources 能力算作现有产品验收。
- [dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) 是员工发现外部 DSH 插件的现成候选；它属于来源发现环节，不代替公司私有能力授权、固定版本和执行验证。
- [FastMCP Tool Search](https://gofastmcp.com/servers/transforms/tool-search) 是工具目录变大时的按需搜索候选；[IBM ContextForge](https://github.com/IBM/mcp-context-forge) 提供 MCP 等服务的集中注册、代理和治理。二者均不等于 DSH Skill/插件原生加载器，当前不以另加网关替代已有 DSH 装配机制。

选型结论：优先补齐 DSH 原生 Skill、插件管理、MCP 三条接入；复用为伍已有授权、快照和记录。先完成真实插件组合试验，再根据发现的具体缺口决定额外组件。此轮只读调研与文档更新，没有安装、改生产或付费调用。

用户进一步明确：优先实现“插件启用后员工按权限直接使用”，而非逐项开发办公和运维业务。下一步优先检查 DSH 原生插件装配与为伍 Host 的连接，用一个办公插件验证共用安装/启用、工具发现、授权、执行记录和交付链路；后续同类插件复用该连接。不要先造另一套插件框架。

本地核对：`host.mjs` 和 `employee-hosts.mjs` 已使用 `ctx.plugin` 挂载 DSH 组件，但业务工具合同和权限过滤基于固定的 `PRODUCT_TOOL_NAMES`；新插件安装到普通 DSH profile 不会自动加入这些员工 Host。新工具必须纳入统一权限校验，不能简单挂载后默认开放。已安装 `dsh-schedule` 文档限定 live 根会话投递；`dsh-webhook` 提供规则注册和 Session 创建，认证由适配器负责，重复交付会再次运行规则。因此优先复用其能力，但不能把原生 Session 创建直接等同于为伍批准的部门项目执行。

参考：[DSH plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md) 提供 profile 插件管理；当前上游能力需另行与本地固定版本比对，本文没有安装或升级。

先完成插件兼容性和现有交付接口核查，列出最小集成差异；再形成实现计划。采用一条贯穿场景“监控测试网站 → 员工处置 → 办公汇报 → 提炼工具 → 新任务复用”验收新增能力，避免为每个部门建立另一套执行引擎。本文不承诺任意网站全自动运营、任意 Office 格式保真或任意生成代码自动获生产权限。

以上为调研阶段结论。既有累计金额、单项目授权和未知费用保留，不以新增范围隐含扩大预算。

## 后续隔离组件试验

已按[试验计划](../superpowers/plans/2026-10-18-dsh-office-plugin-pilot.md)运行 npm 实际发布的 `@huiliyi37/dsh-office@0.2.4`，核对原包 46 个文件未修改。10 个工具在固定 DSH 上注册，公司与插件自带 Skill 共用原生目录/加载工具；DOCX、XLSX、PPTX 已生成和回读，员工权限及文件边界检查通过。试验发现 Excel 重算不持久化公式缓存，整体办公验收仍未通过；生产 Host/恢复、JJ OpenShell、网页、渲染与真实模型选用仍未验。细节和证据见[组件验证报告](../validation/dsh-office-plugin-pilot-2026-10-18.md)。

选型方向保留：复用原版 Office 和 DSH 接口，下一步补共用安装/启用、动态授权、沙箱执行和交付关联，而不是自己重做三种文件引擎。报告中的能力缺口不能被文档承诺替代。

后续消费端补验：同一 XLSX 在本机 WPS 中实际计算、输入变化、除零、保存及独立缓存核对 5 项通过。缺少缓存不是文件不可用，不应作为插件接入的全面阻塞；它只需要在无重算服务端读取/预览场景另行处理。没有修改插件源码或安装新表格引擎；JJ 的网页/运行集成仍按上述计划推进。
