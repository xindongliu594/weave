最终冻结版可负担上下文独立审查：发现的错误分类已修复，未发现本次集成还有必须修复的预算、权限或证据保护问题。此结论是代码审查和本地无网络回归，不能证明真实 QA 或经理验收已经完成。

审查范围只有 [limits.mjs](C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/limits.mjs:29)、[budget.mjs](C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/budget.mjs:23)、[openai-compatible.mjs](C:/Users/JJ/.codex/worktrees/f57c/agent_department/services/agent-runtime/openai-compatible.mjs:234) 的本次集成及其宿主归属、上下文保护调用关系。实施代理确认冻结后再次读取了代码和最终回归日志；本审查没有修改源码、备份工具或备份证据，没有访问原数据、主服务或真实供应方。

修复前的具体问题是把字节上限失败误报成预算不足。纯本地例子使用 220 个 ASCII 字符的 system 与 `Current approved task` 用户消息，消息数组为 302 字节，`{messages}` 为 315 字节；inputRate=2、outputRate=10、maxTokens=1400 时，全请求保守预留仅为 $0.016678。设置 maxBytes=100、availableBudget=$1，受保护组因字节门禁失败，原实现仍返回 `BUDGET_CONTEXT_LIMIT` 和“原预算无法容纳”，其 cause 实际为 `CONTEXT_LIMIT`。网页因此会引导用户处理资金，而实际问题是上下文字节上限。

冻结版先用原 maxBytes 与同一组保护索引验证上下文能否容纳，再进行资金拟合，保留独立的 `CONTEXT_LIMIT` 分类。适配器仍在持久化预留与发送之前抛出对应的 `LlmError`。纯 helper 复核两种分类正确，随后又独立运行了两个适配器本地负例：替换 fetch 为立即抛错的函数，设置 `beforeRequest`/`onRequest` 计数器并逐项断言。实际结果如下，命令退出码为 0。

| 原上下文字节上限 | 原预算 | 实际错误 | 持久化预留入口次数 | wire 请求次数 | fetch 次数 | 已用调用次数 | 运行预留 | 已用费用 |
| ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | $1 | `CONTEXT_LIMIT` | 0 | 0 | 0 | 0 | 0 | 0 |
| 192000 | $0.014 | `BUDGET_CONTEXT_LIMIT` | 0 | 0 | 0 | 0 | 0 | 0 |

第二例在原上下文字节上限内，但固定输出预留已经用满 $0.014，因此无法覆盖输入和 1024 字节保护余量。冻结版诊断实际显示精简前 315 字节、精简前预留 $0.01667800、可用预算 $0.01400000、输出上限 1400 保持不变。诊断只包含数字，不包含 system、原文件、知识原文、凭据或工具正文；精简前金额也没有被称作受保护上下文的最低金额。

安全检查逐项结果：

- `available → fitAffordableMessages → reserve` 处于同一同步段，中间没有 await；后续 `reserve` 仍重新执行原门禁。较小的 run/task 剩余金额包含已用费用与当前预留，不能被两个并发员工同时占用。持久化 `beforeRequest` 仍在 fetch 之前。
- 原任务归属、未知 task、项目与任务调用上限、已用预算耗尽、90% fallback/rework 门禁都保留。宿主仍负责员工和任务归属，经理的协调请求沿用原项目级归属；本次没有新增无任务调用权限。
- 输入价格、输出价格、实际用量计费及输出上限选择没有修改。保守预留仍是 UTF-8 `JSON.stringify({messages,tools})` 字节数加 1024，再按原 inputRate 与原 maxTokens/outputRate 计算；undefined tools 与空数组仍分别核算。
- 删除对象限于较早的完整消息组，不编辑 JSON、正文、工具 schema 或 SHA。system 中的当前批准合同、最近 user/assistant、完整工具调用与响应组、compact checkpoint（含 system 索引偏移）、path+SHA 文件证据及固定知识引用都受保护。`knowledge_search/read` 通过原 tool-call ID 对应关系保护；compaction 保护全部来源，资金不足时停止而不先删来源再生成摘要。
- 此集成没有写账单状态或重分类 pending/uncertain 的路径。拟合失败发生在持久化预留入口之前；真实已发送请求继续沿用原 usage/unconfirmed 流程，保留原不明费用门禁。上下文归档失败也处于发送之前，并由原释放流程回收本次内存预留。

实施代理最终工程回归为 79/79 PASS，类型检查与 scoped diff check 均通过，日志见 [my-gateway-budget-context-fit-2026-10-05.txt](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/my-gateway-budget-context-fit-2026-10-05.txt)。其中包括字节/资金两类 0-fetch 负例、完整文件/知识/checkpoint 保护、历史剩余额度、并发、身份/turn/90% 门禁、归档失败清理，以及原错误诊断与停止时在途调用回归。初次分类失败日志单独保留在 [my-gateway-budget-context-fit-initial-2026-10-05.txt](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/my-gateway-budget-context-fit-initial-2026-10-05.txt)。79/79 是实施代理运行的本地 fixtures；上表 2/2 是本审查另行执行的无网络适配器检查。

冻结文件的 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| limits.mjs | `35b77fdda0df1d0076686079cf9c98fbe8f488cd852dae7eefc3731aa054a57e` |
| budget.mjs | `780123a17a6cddda9e45ee4716434594deb01d193849dc9490401b8e710a35ad` |
| openai-compatible.mjs | `0636896f69eb258ff601956ad345c2d54f9c64e3a4a5c8112ae3012edb43b886` |

限制仍然存在：实现保守保留历史 SHA 文件组与固定知识组，不保证能在原余额内继续 QA。实施代理报告的当前离线 QA 下界 $0.110220 已高于净余额 $0.1012552，本审查没有发起付费验证或独立重算该项目下界，也不把本地回归当作真实员工 QA、经理验收或整个 MVP 完成的证据。已完成的离线备份和隔离恢复证据保持原状。
