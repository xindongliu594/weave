# 经理定义交接要求

用户已确认：经理派工时说明要什么，员工按要求交结果与证据；经理读取结果并按需核验。

## 调研与选型

- 已安装 `@nanmicoder/dsh-agent-teams` 提供 `agent_teams_update_task`、`output`、`acceptanceResults`、`commandsRun` 及任务/attempt 校验。继续使用现有插件，不升级执行引擎。
- 项目已有 `taskSchema`、文件合同、HandoffGate、不可变目标哈希、恢复封存和 runEvidence。缺少经理指定的报告内容及跨节点的结构化报告封存。
- [DSH 任务团队](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/tool-agent-team/README.md) 提供共享任务与协作能力；上游新接口和本地插件版本不同，不直接替换。
- [Agents SDK handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/) 区分交接载荷和历史过滤；借鉴这种分离，不引入第二套 SDK。

## 实施范围与接口

1. 在任务上增加可选 `handoff.sections`，每项为经理生成的 `key` 和 `requirement`（最多 8 项）。现有 acceptanceCriteria、outputs、verify 继续定义验收和实际证据。历史无该字段的合同保留原行为。
2. 员工仍只调用原生 update_task；output 填 JSON 字符串 `{summary, sections:{key:正文}, risks:[]}`。宿主检查格式、必填章节、长度、逐项 acceptanceResults；文件版本和真实命令仍走已有 gate，文字不能代替真实测试。
3. 成功交接时把报告与合同指纹封存在原 handoff/accepted 内。经理的受保护上下文默认注入直接前置任务的报告，明确这是员工陈述，实际输出/命令回执单列。不传员工完整会话，不新增知识读取权限。复用安装版 AgentTeams scheduler 的纯函数，按当前任务、attempt 和精确原文识别派工及认领中的重复祖先报告，改成封存报告引用；不改变原任务板的访问权限。旧合同、缺少封存报告的混合流程保留原生行为。
4. 恢复重新校验合同指纹和报告；旧记录不伪造报告。网页展示交接要求和封存报告，支持修改草案要求。

## 验证及边界

- 本地回归：缺字段、重复/未知章节、缺逐项验收、失败冒充通过、超长报告、旧方案兼容、文件/命令校验不绕过、只传直接前置、失配 attempt、恢复后报告一致、合同变更拒绝。
- 使用安装的原生 DSH 工具验证实际 JSON 参数与状态提交；固定响应仅用于协议回归，不作为真实模型验收。
- 类型检查、前端构建、一次独立最终代码审查，记录证据后提交推送。
- 本轮不新增付费调用、不替员工补交付物。旧退款 QA 的最终请求上下文超限与这次跨员工报告是不同环节；不能把新报告功能通过当成旧项目真实验收通过。
- 已设 256000 字节的是旧项目新草案，未改旧快照；本次不偷偷改变其预算、恢复策略或模型窗口。

## 进度

- 实施和审查修复完成。71 项相关回归及类型检查、构建通过；独立审查三项重要问题均已修复并复核。
- JJ 只读健康检查通过后，发布上传遇 SSH 22 超时；上传和部署均未完成，在线服务未切换。
- 真实模型验收未执行。下一步：JJ 网络稳定后，用准备好的隔离发布包做 Linux 回归并发布，之后单独安排真实模型验收。
