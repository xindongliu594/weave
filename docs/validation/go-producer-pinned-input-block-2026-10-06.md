# 新方案拒绝固定历史 producer SHA

新方案输入同时填写 `producerTaskId` 和 `sha256` 时，默认的 `taskContractErrors` 返回合同错误；普通方案、AI 候选预览和批准前的 `validatePlan` 均显示 invalid。生产任务输入仅绑定 `path` / `producerTaskId`，实际消费版本由宿主的本次 accepted seal 决定。外部固定资料使用真实 `sha256`，不填写生产任务 ID。Schema 增加两字段说明，保留历史反序列化格式。

已批准历史快照在 `HandoffGate` 和 `resumeHandoff` 两个调用点显式保留原合同语义。accepted SHA、合同中的固定 SHA 和真实文件 SHA 的原比较未改；合法旧合同可恢复，固定 SHA 不匹配和文件污染仍阻断。`resume/retry` 不调用 `validatePlan`；新生成、组织预览和新项目批准继续使用默认新门。修改仅为共享规则、声明、schema 描述及两个历史调用点。

隔离 HTTP/PGlite 回归直接使用真实产品确认和批准处理器，未启动模型端点。产品依原语义允许保存 invalid 候选供审阅，并显示明确错误；随后批准返回 `422 PLAN_NOT_READY`。Run、用量、预留均为 0，执行器检查未到达。没有修改真实项目、运行、员工文件、数据库或服务。

最终验证：合同/范围/恢复 18 项、实际隔离 HTTP admission 1 项、原 native quality handoff 5 项，共 24 项通过、0 skip；两项 syntax 通过，`tsc --noEmit` exit 0。首次日志保留了测试 fixture 类型声明缺失造成的 tsc 错误；后续修复仅在 fixture 中声明实际测试对象，修复日志记录 4 项重跑及 tsc exit 0。

来源、完整 SHA 和测试输出：

- [源码 SHA 与结果](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-producer-pinned-input-block-sourceSHA-2026-10-06.json)
- [原验证日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-producer-input-validation-tests-2026-10-06.txt)
- [类型修复后验证日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-producer-input-validation-repair-tests-2026-10-06.txt)
- [改动前来源](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-producer-input-validation-before-sourceSHA-2026-10-06.json)

原 operator `cdb9e26f…` 和当前 NEW operator `ff689045…` SHA 均未变。此报告是工程校验，不能作为真实业务验收完成的证据。
