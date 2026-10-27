# Go MVP 最终范围工具验收（2026-10-06）

工具与工程验证已通过；真实产品 MVP 验收仍由实际捕获证据判定。本次只接续 NEW final-scope helper、测试与报告，没有访问真实 API、原数据库、模型、供应商、服务或员工交付物。

正常项目只有在实际 Go 确认链、当前完整项目、每个完整 Run 快照/状态精确绑定，所有员工明确零 knowledgeSpaceIds/knowledge tools、文档 manifest 和逐员工文档清单明确为空、完整事件及 citation 为零、当前部门权限与工具明确为零时，原 `fixed-knowledge-authorization-and-citation-readback` 一项才成为 `passed-no-authorized-knowledge`。缺字段或发现任一权限、调用、引用均回到原严格检查；其他原检查保持原决策。

可选 knowledgeDocumentIds、runInputs 和 allowedKnowledgeSpaceIds 保留原签名：省略时不补写，存在时必须为空。恢复项目绝不使用此例外。

恢复增加三个独立证据门：完整父子 v1 PIN 与当前 v2 文档/两版正文 SHA/source/facts/grants/真实引用切片；同唯一私有 marker 的原 QA search HTTP 200 全文正向与开发 search HTTP 200 空结果，完整绑定同项目、部门、员工、请求和响应 SHA；冻结升级 helper 的真实 setup/stop/before/after 原件 SHA 链并复算其纯 preserveUpgrade guard。原件和捕获时复制件都必须实际读取，状态 bool 不能代替证明。HTTP 负向依据现有 search 端点语义，不接受不存在的 read 端点 404。

NEW capture 的正常知识 gaps 使用同一个严格零范围 predicate；恢复知识 gaps 来自现场复算的三个证据门，不以 versionEvidenceStatus 或 prior 数量代替原件验证。冻结的 budget、calls、restart、errors 逻辑未放宽；供应商账单或未知成本继续阻塞财务验收及 actualMvpAccepted。

验证结果：5 个 NEW helper syntax checks 通过；77/77 工程测试通过，fail/cancelled/skipped/todo 全为 0。包括原 13 项回归、NEW 副本 13 项、零范围 5 项、正文/HTTP 5 项、完整引用存储 7 项、冻结升级 guard 34 项。NEW 副本保留原检查的通过决策，同时验证缺少新增真实恢复证据必然 blocked。

7 个冻结来源前后 SHA 完全相同，sourceStable=true。完整运行日志和全部 NEW SHA 见 [测试日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-final-scope-tests-2026-10-06.txt) 与 [sourceSHA 报告](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-final-scope-sourceSHA-2026-10-06.json)。原 finish-setup 的 QA/private 与开发空检索 HTTP 已在只读测试中复算，但此测试不声称真实 v8 恢复执行完成。

入口为 [NEW capture](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/capture-go-acceptance-final-scope-referenced-2026-10-06.mjs)、[NEW referenced audit](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/audit-go-todo-acceptance-final-scope-referenced-2026-10-06.mjs)、[范围 predicate](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/go-final-knowledge-scope-2026-10-06.mjs) 和 [恢复证据 guard](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/go-final-knowledge-proof-2026-10-06.mjs)。后续 root 应供应实际 v2 升级 result.json、受控 restart 以及恢复后 QA/review/manager 的完整事件和 citation 读回；缺少任一原件保持 blocked，不能以工程 fixture 替代。
