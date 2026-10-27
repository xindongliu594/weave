# 已完成运行的经理结果显示修复

正常 v14 Run `88aa22a9-f887-467c-bf12-91bb57d42361` 已有四个 completed/accepted 任务，经理在 #6999 交付 `acceptance-report.md`，17620 B，SHA256 `342915788d0570634a86450e650cddefa83115fe85394950f94bbb4f2269c24b`。旧网页主结果却显示 captain 的英文站退回复，声称 t4 仍 claimed、没有报告。

原因是 runtime 在结束时取 `lastAssistantText(captain)` 写入 `run/finished.summary`。captain 协调会话的最后回复早于另一经理任务会话的真实交付；它没有随着经理 accepted 更新。`RunExtras` 原来直接把这个历史协调摘要显示为结果。

本次仅修网页派生展示，不改 runtime、原档案、原回复或任何员工文件：

- 仅在 run 状态和 finished 状态均 completed、档案 integrity=ok、全部批准任务当前 completed/accepted 时，选择唯一末端经理任务。
- 将该任务的原始 output 作为主结果，并显示匹配同 run/task/attempt/version 的宿主接收序号及真实输出文件 SHA。
- 缺少 seal、错误 attempt/version、失败/中断/不完整、未知节点、无完整产物哈希等情况均不提升为经理验收结果。
- 原始 captain 摘要完整折叠在“查看原始协调回复”中，注明可能早于任务交付；追溯时间线及原导出不变。
- 用户明确“沉淀为部门知识”时使用同一主结果，避免继续保存过时站退文字。

验证：相关 UI **28/28 PASS**，类型检查 **exit 0**。本机 Node 24.19.0 的 Vite 构建 **exit 0**；首次沙箱构建因 esbuild 祖先目录访问限制失败，原日志保留，随后自动审批的本地构建通过，没有访问模型或原数据。生成主包 `index-DLecTdHN.js`；500 kB 构建体积提示保留，未额外扩大范围拆包。

另对实际封存 `state.json` 做 SHA256 严格校验（`276ed6a395c8a6ddb8272b035bbfa0f138d387c9efec88c54c71e40e46b8ad4d`），使用实际 RunExtras 服务端渲染，主结果确定为经理任务、#6999 和上述 report SHA；旧协调回复仍在折叠历史。**0 fetch、0 live 请求、0 员工文件写入**。这项是本地实际数据渲染，浏览器刷新验证由主代理继续，不能冒称已完成浏览器验收。

证据：

- `docs/test-evidence/go-normal-v14-completed-result-local-render-2026-10-07.json`、同名 `.html`
- `docs/test-evidence/go-completed-result-ui-tests-2026-10-07.txt`
- `docs/test-evidence/go-completed-result-ui-types-2026-10-07.txt`
- `docs/test-evidence/go-completed-result-ui-build-2026-10-07.txt`（原沙箱失败）及 `-escalated.txt`（exit 0）
- `docs/test-evidence/go-completed-result-ui-manifest-2026-10-07.json`

未重启服务、调用 API/Cua/模型、打开原数据库或修改已接受文件。整体 MVP 剩余恢复、备份和最终浏览器交付仍由各自验收报告判定。
