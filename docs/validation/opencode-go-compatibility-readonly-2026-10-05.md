# OpenCode Go 只读兼容审计

审查快照：2026-10-05 13:52 UTC。未读取凭据、原数据库或员工文件，未发推理请求，未修改配置、服务或业务源码。并行适配正在实施；本文记录观察与必要边界，不是 Go 模型执行验收。源码 SHA 和去敏观察在 [审计 JSON](../test-evidence/opencode-go-compatibility-readonly-2026-10-05.json)。

## 已确认的兼容差异

- [实际网页配置证据](../test-evidence/opencode-go-web-configuration-2026-10-05T13-29-43-137Z-ada61878.json) 中，`ff9080ff-c61a-4449-a360-c5e0662e7c5a/v1` 的认证目录 HTTP 200，36 个型号，Luna 在列，Astra/Sol 不在列，36 项价格均缺失。此前匿名公开 [`/models`](https://opencode.ai/zen/go/v1/models) 只观察到 `id/object/created/owned_by`，没有费率或协议。匿名目录不能作为这把 Key 的权限证明；保存的认证 discover 是去敏投影，不能反推出其历史原始响应的全部字段。
- [Go 官方文档](https://opencode.ai/docs/go/) 为 `gpt-6-luna` 指定 `/zen/go/v1/responses`，并要求可识别的产品 User-Agent、稳定的每段对话会话身份。旧 API 与运行适配器固定 Chat Completions，单改 base URL 不足。根代理正在接入共享 codec；本文不把尚未回归的并行变更标为通过。
- 已安装的 `dsh-llm@0.1.5-rc.1` 的 `attributionHeaders()` 只输出 User-Agent，不能推断存在原生 session 头。当前定制 runtime 已有 `options.sessionId`，可将其稳定映射到 `x-opencode-session`；无需发送合同、员工姓名或任何秘密。真产品身份应如实声明，不伪装其他客户端。官方 [客户端实现](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/provider/provider.ts) 也将接口协议与模型资料配置分开，不能依赖 `/models` 自动推断。

## API 稳定身份的最小建议

`completeBudgeted` 已开始把 `context.sessionId` 传给 transport。项目规划可用 `project:<id>:planning:<version>`；同一工具能力测试两次请求可复用 `probe:<probeId>`。经理咨询应显式用独立 manager 命名空间，避免落入规划命名空间。

组织对话临时采用模型 ID 与首条用户消息的哈希。它跨轮次稳定，但同模型同首句的两段新需求会合并身份。应在网页 Draft 中保存独立 UUID `conversationId`，API 使用 `organization:<uuid>`；刷新与多轮复用，确认“开始新需求”后更新。旧 pending 的原始 body 和幂等 Key 必须原样重送，不能迁移时给同 Key 加字段；旧客户端缺字段继续兼容安全哈希。会话头仅是路由与缓存身份，不是权限、重复请求抑制或外部操作恢复凭据。

## 有限上下文与保守计价

以下是 [Go 文档](https://opencode.ai/docs/go/) 的 `gpt-6-luna` 费率，单位 USD / 百万 Token：

| 输入档位 | 常规输入 | 缓存读取 | 缓存写入 | 输出 |
| --- | ---: | ---: | ---: | ---: |
| 不超过 272K | 0.10 | 0.01 | 0.125 | 0.50 |
| 超过 272K | 0.20 | 0.02 | 0.25 | 0.75 |

现有两费率账本可暂以 `inputRate=0.125, outputRate=0.50` 对低档全部输入保守计价，不假设缓存命中。前提是 API 与 runtime 均对**真实编码后的输入与工具包**作同一保守 Token 上界检查，包含既有预留开销，硬拒绝超过 272000 的请求。仅填写 `contextWindowTokens=272000` 不成立：当前它是 DSH 元数据；runtime 的 `contextBytes` 检查只覆盖消息，工具另占输入。不得通过删独有知识、合同、完整文件或降低批准的输出上限来绕过该边界。

费率来源须标为 Go、带核查日期，不能误套普通 [Zen](https://opencode.ai/docs/zen/) 或现有 OpenAI 官方价格快照。按用量乘保守费率的产品登记仍是估算；Go 套餐额度、现金余额和精确单请求账单是不同来源。本轮没有核实可安全使用的 Go 单请求账单查询端点，不接 New API 账单接口来猜。缺用量、超时和原个人代理的未知收据继续保留，不据此记零；不擅自启用余额回退。

## 可独立完成的本地工程任务

1. 共享 Responses 请求/响应 codec 与真实稳定会话头，API 文本规划、工具测试和 runtime 同路；本地 HTTP fixture 验证 output、工具往返、usage 缺失、已消费但输出无效等边界。保持模型配置指纹、版本批准、预算与未知操作门禁。
2. 所有预检与实际派发共用编码结果，低档上界在 reserve/fetch 前检查；通过本地过阈值的 0 receipt / 0 fetch 回归证明。恢复时固定同一协议、会话和费率来源，不隐式更新旧批准模型。
3. 网页独立会话 UUID 与旧 pending 迁移回归；估算标签与原未知费用保留。用户已允许替换 Go 模型并由 AI 重做方案，但尚不能据目录可用宣称模型推理、独立 QA 或完整项目预算链已通过。

本报告冻结后，组织会话 UUID 实现另行记录；上述源码 hash 是本次观察快照，不保证等于并行适配最终版本。
