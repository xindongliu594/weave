# 节点内部检查点：复用调研与接入边界

日期：2026-10-19。本文保留设计时的调研结论；2026-10-20 实施状态见 [验收记录](../validation/step-checkpoints-2026-10-20.md)。未新增付费调用或调整额度。

## 用户目标

保留现有 DAG 节点级恢复，增加四类触发：核心阶段完成、高成本工具调用、进入分支前、一次工作循环完成。恢复应尽可能沿用已完成工作；未知外部结果不能盲目重放，费用与历史不能回退。

## 已有能力及复用结论

| 实现 | 核对结果 | 选择 |
| --- | --- | --- |
| 固定安装的 `@deepseek-ai/dsh-session-checkpoint-policy` `0.1.5-rc.1` | `employee-hosts.mjs` 已挂载。实际 lib 在模型派发前、顶层工具执行前、`agent/pre-step` 调用 `ctx.sessions.flush`。写失败则不继续派发 | 直接复用，不再实现会话日志和工作循环 |
| DSH `session-persistence-jsonl`、`session` | 已有持久化、日志校验与会话恢复；原生 `sessions.fork` 要求 live session 且切点在完整 turn 之外 | 复用日志和合法 fork；不能假设任意工具事件都可以原生 fork |
| `@nanmicoder/dsh-agent-teams` `0.1.20` | 已有团队锁、任务状态和 attempt；冷启动对未完成工作建立新 attempt | 保留现有调度与 DAG，不增加第二套执行引擎 |
| 为伍 `HandoffGate`、`checkpoint-context`、`run-management` | 已验收节点可跳过；未完成节点携带文件与有界上下文；现规则要求新 attempt 的 verify，历史命令不能自动算作新证据 | 缺口是产品侧安全边界、文件版本和明确的继承证据，不是缺少底层落盘 |
| 为伍操作日志、费用账本、存储限制 | 已有 operation-start/finished/unknown、费用留存、归档容量门禁 | 继续使用，检查点引用权威账本；恢复不能恢复成过去较低的累计支出 |
| LangGraph checkpointer/time travel | 有成熟的状态检查点、pending writes 和保留历史的 fork 语义 | 参考语义和故障用例；其 graph state 协议不直接等于 DSH session，不为此替换架构 |
| Temporal Activity | 已完成活动结果可用于 replay；未完成外部活动仍需要幂等设计 | 借鉴操作身份与核对规则，不为此增加 Temporal 服务 |

DSH 插件市场本轮打开的公开目录页没有出现 checkpoint 匹配项；这不证明整个市场没有相关插件。已安装官方组件是更直接的复用对象。上游 master 文档只作参考，固定安装包源码是本项目行为依据。

## 接入设计

保留三层：DSH 保存会话和工具事件；为伍保存可恢复边界的清单；现有 DAG 负责阶段调度及验收。

一个边界清单关联 run/task/attempt/session、父检查点、事件序号、批准合同哈希、工具版本与参数摘要、文件内容引用及哈希、环境指纹、知识版本引用和操作回执。只存恢复需要的结构化状态与简短进展，不额外调用模型生成反思，不保存隐式思考过程。

提交顺序：锁定相关工作区的写入边界，等待本批工具结束；flush 原生会话；持久化已变化文件及回执；最后发布完整 checkpoint 清单。半写清单不作为可恢复点；必须保存的检查点写入失败时阻止后续操作。多员工共享目录不能在其他写操作途中取得混合版本，沿用已有宿主锁并核对版本，不直接复制活动目录。

四类触发：

1. **核心阶段**：复用既有 `handoff/accepted`、`team/checkpoint`；长节点可以按已批准合同拆成有证据的小阶段。保存中间进度不会提前宣布整个任务已完成。
2. **高成本工具**：继续调用前保存意图；工具结果确认后立即追加 durable receipt 并建立恢复边界。高成本或不可安全重复的分类由工具目录元数据和运行策略确定，不依赖模型自称。未知插件默认不允许结果自动重放；内部嵌套调用需由插件提供可靠操作身份/回执，否则只保证外层记录。
3. **工作循环**：复用原生 pre-step 边界，将上一轮已完成模型响应和工具结果关联到文件清单；等待未完成的并行工具。循环检查点不意味着复制整个目录，也不把流式半截回答作为完整模型结果。
4. **分支前**：保存共同起点，以独立工作目录从旧检查点派生子分支；源历史不可改写。只沿用已批准的替代路径；新增目标、权限或合同变化走现有方案流程。原生 fork 不支持的切点须重新发布与完整 turn 边界一致的检查点：会话游标、文件版本、回执必须来自同一边界，不能把旧文件快照与后移的会话切点拼接；无法取得一致边界则拒绝派生。不能手改 JSONL 伪造会话。DAG 用新的分支/attempt 表达继续和返工，不能插入循环边。

### 恢复与证据复用

恢复先核对归档完整性、当前权限、批准合同、文件/知识/工具/环境版本、未知外部结果和累计费用。会话恢复不能沿用旧团队的有效权限或旧 attempt；同身份恢复和跨运行恢复分别测试。跨运行继续保持新 attempt，并显式绑定父记录，而不修改历史身份。

首个可复用对象限定为有宿主证据、依赖封闭的沙箱本地测试，以及已封存的纯计算结果。网络查询、网站健康状态、时间敏感数据、未声明副作用的任意终端/MCP 工具都不能仅凭同样参数复用。

复用测试必须验证：源回执完整且成功；命令、测试文件、源代码、固定输入、运行时/依赖和相关配置一致；当前合同允许继承；原执行权限与现权限均满足；没有未核对写入。不能只比较源代码哈希。证据以 `inherited` 关联源 run/task/attempt 和 receipt，当前员工依然独立分析并提交报告，经理仍验收。条件不满足则重新测试或要求核对，不能自动放宽原 verify 规则。

外部操作遵守 planned → dispatched → succeeded/failed/unknown。同一逻辑操作跨 attempt 或分支恢复时保留稳定操作身份；每次恢复/派发均查询最新权威操作账本，包括源检查点之后在旧分支发生的成功或未知操作。不能只用旧检查点内的操作状态判断是否可执行，也不能把无关新操作误合并为原操作。只有明确未派发、确认无效果或提供方支持可靠幂等/结果查询的操作才能进入相应重试策略。已成功的外部修改不因分支回退自动撤销，也不能重复执行；需要撤销时作为独立补偿操作审核。分支复用不得影响并行分支或其他员工的新结果。

### 存储

原会话日志不按检查点重复复制。文件版本按内容哈希保存一次，检查点引用已有内容；初期只支持现有允许的工作文件类型/容量，超限必须明确拒绝，不能静默漏文件。沿用容量门禁；后续清理必须从活动恢复点、分支、交付、账本和验收证据遍历引用后提出预览。当前阶段不自动删除旧用户数据，不复制 node_modules、构建缓存和沙箱内存作为每轮快照。

## 本轮验证事实

- 已核对本地固定版本源码、员工 Host 挂载位置和现有恢复合同。
- `node --test services/agent-runtime/employee-checkpoint-policy.test.mjs`：正常权限复测 **7/7 通过**。固定模型替身仅测试落盘顺序、写失败拦截和取消，不代表真实模型验收。
- 首次受限 Windows 沙箱执行为 1 通过、3 失败、3 取消，日志包含 `MoveFileExW EACCES (Win32 5)`；同命令正常权限通过，未修改产品代码。
- 尚未验证新的节点内部恢复、结果继承和分支文件回退；不能将已有测试计为这些新增能力通过。

## 来源

2026-10-20 实施补充：复用 Node 自带权限模式约束可复用测试，使用 `--permission --allow-fs-read=<workspace> --test-isolation=none --test`。可信执行器以独立参数启动，清空员工环境变量，禁止文件写入、子进程、Worker 和原生插件权限。OpenShell 仍承担外层隔离。Node 权限模式本身不证明时间/随机数/网络无依赖，这些测试仍不得选择证据复用。依据：[Node CLI](https://nodejs.org/api/cli.html)、[Node 权限说明](https://github.com/nodejs/node/blob/main/doc/api/permissions.md)。不新增第三方测试运行引擎。

- [DSH 官方检查点策略](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md)
- [DSH JSONL 持久化](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)
- [AgentTeams](https://github.com/NanmiCoder/dsh-agent-teams)
- [DSH 插件目录](https://dshplugin.app/plugins)
- [LangGraph checkpointer](https://github.com/langchain-ai/langgraphjs/blob/main/libs/checkpoint/README.md)
- [LangGraph 分支与历史恢复](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel)
- [Temporal Activity](https://docs.temporal.io/activity-definition)
