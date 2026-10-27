# Completion protocol API 本地工程验证（2026-10-06）

最终结果：6 项测试全部通过，失败、取消、跳过均为 0，退出码 0。源码快照时间为 2026-10-06T09:10:09+08:00；最终测试前后以下 10 个文件 SHA256 一致。完整命令、输出与 SHA 在 [同名 txt](completion-protocol-api-2026-10-06.txt)。

新增 [tests/completion-protocol-api.test.ts](../../tests/completion-protocol-api.test.ts)，通过现有 `scripts/test-integration.mjs` 单独运行。测试强制 `SIMULATED_INTEGRATION=pglite`，使用新建的内存 PGlite 数据库、新临时 DATA_DIR/TRACE_ROOT/Obsidian 目录与本地 HTTP fixture。仅写测试和本验证记录；API、contracts、数据库源与共享 codec 只读。

6 项验证覆盖：

1. 实际 `/models` POST/PUT/GET 保存显式 protocol；字段省略的旧 Chat 模型不会按模型名或测试结果推断协议。无效 protocol 返回 schema 422，并且没有创建模型。
2. `/models/:id/test` 调用 `/responses`，`store:false`、非流式、`reasoning:none`；数据库费用预留等于实际捕获的请求 UTF-8 JSON 字节 + 1024，加原输出 cap。usage 中 80 cached tokens 包含在全量 100 input tokens 内，按配置价格保守记费。
3. 两次独立 `/models/:id/test-tools` probe 各执行两轮。函数使用 `call_id` 关联结果，首轮文本和调用完整重放；数据库保存两条 settled 回执及对应 usage。Go 身份为 `AgentDepartment/0.2.0`，同 probe session 稳定，不同 probe 隔离且不发送原始 probe ID。
4. 全局预算设置在旧 Chat 消息估算与真实 Responses wire 费用之间时，请求被拒绝，0 模型派发、0 模型回执。上下文容量精确等于捕获的 wire 字节 + 1024 + 输出 cap 时 probe 通过；容量减 1 时，在 reserve 前拒绝，0 模型派发、0 模型回执。
5. 有效 usage 配上不完整函数参数时，probe 返回安全格式错误；费用已经登记为 settled paid failure，未知预留为 0，并且未获得工具支持证据。
6. 无 usage 或 HTTP 502 时，数据库保留一条 uncertain 回执与全部预留；只有一次派发，没有自动重试。API 错误、公开费用数据和回执元数据不泄漏合成 fixture Key。

Go 精确地址通过受控 global fetch 映射到本地 HTTP fixture；其他所有外部目标拒绝。没有连接真实 Go 或其他真实网关，没有读取真实 Key 或原业务数据。此验证使用合成模型与无副作用工具，不属于员工执行或真实模型验收。PGlite 使用单产品连接，不验证独立 PostgreSQL backend 的并发锁语义、供应方实际价格或账单。用户本轮新 Go 的 DeepSeek/GLM 生产路线采用 Chat；本报告保留对已写 Responses 兼容层的工程证据。

首轮和精确边界强化后的中间轮均为 6/6；中间轮检测到其他 agent 正在更新 API thinking 配置，因此在更新后的稳定源上复验了最终 6 项。测试模型没有 thinkingMode 字段。

快照后续变更：源码 owner 对 `model-capabilities.ts` 增加了仅在 `thinkingMode:'disabled'` 时使用 `tool_choice:'auto'` 的分支，新 SHA256 为 `107f02b74cb4cfe8f9c1ad9d7d3e23072cb7ca27683afe236c50a70a5d832f8f`。下表仍保留本次 6/6 实测时的旧 SHA（`410ef083...`）。本文件的 Responses 模型没有 thinkingMode，路径保持原 forced choice；更新分支的 4/4 API 回归由 owner 另行保存于 [Go thinking 验证记录](go-thinking-mode-2026-10-06.md)。没有将该更新分支计入本次 6 项实测。

Git HEAD：`f775baa410316527dce54d0560d3a9b9d0f46199`。工作区含已有修改，源码身份以 SHA256 为准。

| 文件 | SHA256 |
| --- | --- |
| tests/completion-protocol-api.test.ts | 989da7c9ab100e0dc493d72d6ddacb14fedbf87eac378784bd4fa6a2dd1e3bfc |
| apps/api/src/app.ts | 75b14eb09723d05a6cc42b4c42840c30f9d07b838137e8b6e3bea3d3155ac331 |
| apps/api/src/provider.ts | 0df8d6f69d5098c57fad947a0b804fece7c5465a8b49ec15d6eee84aad80128a |
| apps/api/src/cost-control.ts | 79ffbb8778b894eb915bf208de7ef3e448dbfd433051a3a54020297d32144456 |
| apps/api/src/model-capabilities.ts | 410ef08350be360390669cb7873d118fb8849e6654bcd52be06dc83c0e1dd9c0 |
| packages/contracts/index.ts | a77639df16b4e1865222d872d8b1a487bab19a1b0390ac5fe9e4162543faf468 |
| services/agent-runtime/completion-protocol.mjs | d99e21fe185f80fc8e7f4e03e8400151148b5facb77fe4e486f28568b890563d |
| services/agent-runtime/completion-protocol.d.mts | a244d653800340b1c567c0793650607d6b426ee230499b800486c09411750955 |
| scripts/test-integration.mjs | c00ed62fc7cf3f2c73916ed0d7313f62293efe45e77a0787a67283e5a4be3ad6 |
| scripts/test-support/pglite-pool.mjs | c6dfd78719309965b83a316dd286379c1eb0750a68f026ebe5793a8cd34eba74 |
