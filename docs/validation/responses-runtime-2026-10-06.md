# Responses runtime 本地工程验证（2026-10-06）

结果：103 项相关 runtime 测试全部通过；失败、取消、跳过均为 0。源码冻结于 2026-10-06T08:43:27+08:00。完整 TAP、退出码和源码 SHA256 保存在 [同名 txt](responses-runtime-2026-10-06.txt)。本记录属于本地工程验证，不代表真实模型验收。

本轮保留工作区已有修改，仅补改 `completion-protocol.mjs`、`completion-protocol.test.mjs`、`openai-compatible.mjs` 和 `responses-compatible.test.mjs`。没有修改 API、Web、contracts、数据库或已有员工交付物。

- Responses 收到 401/403/429/502/503、缺失或无效 usage、无效 JSON 后，保留已派发请求的本地 run/task 费用预留。配置 fallback 也不会自动切换模型或重试。
- 标准 usage 的持久化回调成功后才释放本地预留并结算；元数据、usage 或未知费用写入失败会保留预留并报 `BILLING_PERSISTENCE_FAILED`。尚未派发的取消释放预留，收到响应头后的取消保留预留。
- 费用先登记，随后验证输出。截断、无效参数、未授权工具和非空推理状态不会产生可执行调用。内部停止只结算原请求的迟到费用，不执行迟到工具或发送新请求。
- 核对 `/responses` 路由、`call_id` 而非 output item ID、三轮完整文本和并行函数历史、完整 SHA 文件及固定版本知识 JSON、`store:false`，以及没有 `previous_response_id` / conversation 状态。授权参数 schema 保持原文，默认显式 `strict:false`。[OpenAI 官方迁移文档](https://developers.openai.com/api/docs/guides/migrate-to-responses)说明了 stateless、工具关联及 strict 默认行为。
- 预留使用实际 HTTP 请求 UTF-8 JSON 字节 + 1024，并加原单次输出上限。核对预算不足、字节边界、模型上下文边界、任务输出 cap；保护当前合同和固定来源，仅移除较早的完整可删除组。
- `reasoning:none` 为当前显式限制；非 none、无效配置和历史推理状态在派发前拒绝。Responses 请求仅支持非流式文本与原生 function 工具。加密或无法证明为空的 reasoning 输出在费用登记后拒绝。
- Go 身份只在精确 `https://opencode.ai/zen/go/v1[/]` 路由下生成：`User-Agent: AgentDepartment/0.2.0`，session 由稳定本地会话 ID 的 SHA256 派生；其他域名不带 Go 身份。此项验证使用 helper 与纯预览，没有连接 Go。
- 未指定 protocol 或显式 `chat-completions` 继续使用旧 Chat 路径与请求体；不按模型名称猜测协议。旧 Chat 回归通过。

测试使用现有 Node（`C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`），运行 `node --test --test-reporter=tap`，范围为 runtime 的 completion-protocol、responses-compatible、openai-compatible、request-preflight、request-context、affordable-context、budget、budget-context、limits 和 model-settlement 共 10 个测试文件。最终共 103 项；此前 Responses 基线 18 项通过，补完后协议与 Responses 专项共 25 项。`git diff --check` 在授权适配文件范围内通过。

模型请求只使用本地 HTTP 合成 fixture 或现有 fetch mock；未读取真实 Key，未请求真实网关。数据库持久化和供应方实际费用对账不在此验证范围内；callback 写入成功/失败的时序在内存 fixture 中验证。真实模型输出质量、供应方支持情况和 Go 的真实接收行为仍需单独验收。

Git HEAD 为 `f775baa410316527dce54d0560d3a9b9d0f46199`；工作区含已有未提交修改，适配冻结身份以以下 SHA256 为准。

| 文件 | SHA256 |
| --- | --- |
| services/agent-runtime/completion-protocol.mjs | d99e21fe185f80fc8e7f4e03e8400151148b5facb77fe4e486f28568b890563d |
| services/agent-runtime/completion-protocol.d.mts | a244d653800340b1c567c0793650607d6b426ee230499b800486c09411750955 |
| services/agent-runtime/completion-protocol.test.mjs | 5fb83342fbcd80adffd4bb43de3d96b0fc025570f5e06f8f8590958cc8157b1e |
| services/agent-runtime/openai-compatible.mjs | 101c90545eaf9ca10c0b5449140068cbb7d6967aa22f1faeeffc1dc870717ecf |
| services/agent-runtime/openai-compatible.d.mts | 9ad69d7510d75322467198fd427c948ce5cc814bb2ac5c7bdc938a7780fa94c9 |
| services/agent-runtime/responses-compatible.test.mjs | 91db73be89a24ef470c31ac34bd4c37756201c084e7e00cc327190c496497849 |
