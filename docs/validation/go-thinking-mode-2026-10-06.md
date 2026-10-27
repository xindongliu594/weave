# 新 Go 模型显式 thinking 配置：本地工程验证

2026-10-06 01:19 UTC 冻结。最终隔离 API **4/4 通过**；runtime 新增 4 项与现有 Chat / Responses / codec 回归合计 **55/55 通过**，失败、取消、跳过均为 0。限定 `git diff --check` 通过。原始输出、两次 API 版本说明及 SHA 在同名 `.txt`，最终机器可读清单在 `go-thinking-mode-2026-10-06-sourceSHA.json`。

模型新增可选 `thinkingMode:'disabled'`。缺字段时沿用旧行为；不按名称选择模式。新建编辑器默认省略，显示「思考模式（可选）」和「使用中转站默认 / 关闭 thinking」；切换 Responses 会清除并禁用该项。schema 拒绝 Responses 与 disabled 的组合。批准运行的路线仅在明确配置时携带该字段。

已核对厂商原始文档：DeepSeek 支持显式关闭 thinking，启用 thinking 时不能使用 required 或指定函数的工具选择；关闭选项来自用户配置。[DeepSeek 官方 Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)。Z.AI 的 GLM 5.2 支持关闭，5.3 和 5.3 Flash 强制 thinking；本配置页面按网关支持选择，未硬编码模型名单。[Z.AI Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode)。Z.AI 工具选择只列出 auto，因此仅显式 disabled 的 API probe 使用 `tool_choice:'auto'`；旧缺字段 probe 保持指定函数方式。[Z.AI Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion)。

共享 `completion-options` 只为显式配置增加 `thinking:{type:'disabled'}`。API text / tool 及 runtime 发出相同明确字段；Responses codec 保持原 SHA。新配置的 Chat 预留计入完整实际 wire JSON、1024 字节余量和原输出 cap，旧缺字段 Chat 的消息 / 工具公式及输出边界保持。runtime 复用已有完整组保留逻辑来拟合新配置请求，未改变旧 Chat 分支。

API 已知 usage 先登记，再拒绝明确关闭后仍返回非空 `reasoning_content` 的响应（`THINKING_MODE_IGNORED`），防止 API probe 丢失状态后继续工具往返。runtime 保留既有 `reasoning_content` 往返能力，测试证明合成状态和工具结果没有被删掉；未扩展新的 thinking 状态协议。

最终 4 项 API 检查覆盖：POST / GET 保存新字段，text 与 auto 工具往返，完整 wire 预留与 settled 用量，auto 没有返回必要工具调用时严格拒绝且只派发一轮，PUT 省略字段清除配置和旧能力证据，缺字段 DeepSeek 名称仍不加 thinking 且保留旧 forced probe，忽略 disabled 的文本 / 工具响应先结算后拒绝，以及非法字段 / Responses 组合没有保存或派发。

runtime 4 项新增检查使用实际本机 HTTP：显式选项和精确 wire 预留；既有推理 / 工具历史完整重放；缺字段模型名不推断模式及旧公式；受保护完整请求预算不足前置拒绝、输出不自动降低；非法配置在预算登记或派发前拒绝。同轮 51 项既有回归通过。

首轮 API 4/4 与 runtime 55/55 后，根代理的 tsc 发现测试对象的 thinkingMode 静态推断缺失；测试改为明确的 spread 对象，无断言绕过。随后追加 disabled probe 的 auto 支路并复验 API 4/4。最终 runtime 文件、共享 options 和 codec SHA 均与 55 项测试时相同，因此未重复运行 runtime。模型能力模块是此后的唯一额外源变化，缺字段支路由最终 API 测试同时核验。

按根代理要求，`app.ts` 的生成候选还在存在时原样附带 `revisionRequest` 到 draft / response；确认正文仍只绑定 preview ID、版本与费用保留选择。该调整的专门 API / UI 复验由根代理负责。

命令（均使用上述 bundled Node）：

```powershell
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' scripts/test-integration.mjs tests/go-thinking-mode.test.ts
& 'C:/Users/JJ/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe' --test services/agent-runtime/thinking-mode.test.mjs services/agent-runtime/responses-compatible.test.mjs services/agent-runtime/completion-protocol.test.mjs services/agent-runtime/openai-compatible.test.mjs
```

全部使用新建内存 PGlite、临时目录与本机 HTTP 模型 fixture；没有请求真实 Go / Key、读取原业务 `.data/local`、产生真实费用或操作产品运行进程。Go 实际是否透传关闭选项、真实模型工具与计费行为仍待真实网关验收。最终构建由根代理执行。

| 文件 | 最终 SHA256 |
| --- | --- |
| `packages/contracts/index.ts` | `A77639DF16B4E1865222D872D8B1A487BAB19A1B0390AC5FE9E4162543FAF468` |
| `apps/web/src/App.tsx` | `D024441EC9A70236A08F4DAE67C5F63A22D5C6954064F4BE63CB85E25CE3633A` |
| `apps/api/src/provider.ts` | `0DF8D6F69D5098C57FAD947A0B804FECE7C5465A8B49EC15D6EEE84AAD80128A` |
| `apps/api/src/cost-control.ts` | `79FFBB8778B894EB915BF208DE7EF3E448DBFD433051A3A54020297D32144456` |
| `apps/api/src/app.ts` | `75B14EB09723D05A6CC42B4C42840C30F9D07B838137E8B6E3BEA3D3155AC331` |
| `apps/api/src/model-capabilities.ts` | `107F02B74CB4CFE8F9C1AD9D7D3E23072CB7CA27683AFE236C50A70A5D832F8F` |
| `services/agent-runtime/openai-compatible.mjs` | `FDA7C655153EA19A1AB23DBDF6435941E0542B5557A739141B0B002BB358457F` |
| `services/agent-runtime/openai-compatible.d.mts` | `DB18E9A1606D251DD5AD00D0E5A5E4075E64FF0B1916857C94396D4B3D730F68` |
| `services/agent-runtime/completion-options.mjs` | `E3426EB9EA0CE7E8EF3A04CD43460871AE079799B00899BAFA16D8CE47713165` |
| `services/agent-runtime/completion-options.d.mts` | `5AD80AA84E86802268A47D27AE60BE5B4E0F16492E2700C17260F65BD3F543E9` |
| `services/agent-runtime/completion-protocol.mjs` | `D99E21FE185F80FC8E7F4E03E8400151148B5FACB77FE4E486F28568B890563D` |
| `tests/go-thinking-mode.test.ts` | `225465DA4587B507AC2C17BED317894A7FCAF6E43C920D2644FA9D0B475C3C90` |
| `services/agent-runtime/thinking-mode.test.mjs` | `7373E967D8C2D537090FA1709F650222C11CE0FB3F47A75170A647215D230C2C` |
