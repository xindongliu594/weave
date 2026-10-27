# Go DeepSeek / GLM 只读核对（2026-10-06）

核对时间：2026-10-06 01:01:17 UTC。仅查官方页面、官方 GitHub 公开源码及[旧认证目录证据](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/opencode-go-web-configuration-2026-10-05T13-29-43-137Z-ada61878.json)；未访问 Key、原库或付费接口。本报告把文档声明与实测分开，结构化摘录见同目录 JSON。

当前 Go 文档列出的下列 7 个准确 ID 均用 **POST https://opencode.ai/zen/go/v1/chat/completions**。费率单位为 USD / 百万 token，顺序为**非缓存输入 / 输出 / 缓存读取**；缓存写入均标“—”，这些行没有声明 context 长度价格分段。[Go endpoints 与费率](https://opencode.ai/docs/go/#endpoints)

| Go ID | 谷时或固定费率 | 峰时费率 |
| --- | --- | --- |
| glm-5.3-flash | 0.15 / 0.50 / 0.03 | 同左 |
| glm-5.3 | 1.40 / 4.40 / 0.26 | 同左 |
| glm-5.2 | 1.40 / 4.40 / 0.26 | 同左 |
| deepseek-v4.1-flash | 0.15 / 0.60 / 0.003 | 0.30 / 1.20 / 0.006 |
| deepseek-v4-pro | 0.66 / 1.98 / 0.022 | 1.32 / 3.96 / 0.044 |
| deepseek-v4-flash | 0.15 / 0.60 / 0.003 | 0.30 / 1.20 / 0.006 |
| deepseek-v4-flash-vision-exp | 0.15 / 0.60 / 0.003 | 0.30 / 1.20 / 0.006 |

DeepSeek 峰时为周一至周五 UTC 01–04、06–10，即北京时间 09–12、14–18；其它时间和周末为谷时。[Go 用量计价](https://opencode.ai/docs/go/#usage-limits) DeepSeek 厂商另外明确中国公共假日全天谷价；Go 正文未明确这项例外，不能据此断言当前 Go 假日计价。[厂商价格](https://api-docs.deepseek.com/quick_start/pricing/) Go 与 Zen 价格表须分别核对。

旧目录在 2026-10-05T13:30:10.3620000Z 返回 200、共 36 型号，以上 7 个及 `glm-5.1`、`deepseek-flash` 都在其中；9 项的 pricing 均为 missing。两个额外 ID 仅有历史认证目录证据，当前 Go 正文未列，当前 Go 价格、路由与可用性未验证。原证据 SHA256：`d46c6062c413954dec6daa360586bc5d9211973732b6c1e22558d2dbc3a46b1f`。

Go 请求须有自有产品 User-Agent 和每个对话稳定的 `x-opencode-session`。[官方客户端约定](https://opencode.ai/docs/go/#where-can-i-use-it) JSON 使用 `Content-Type: application/json`；`Authorization: Bearer <已配置 Go Key>` 只展示占位格式，官方 Go handler 从 authorization 读取 token，并按 body.model 路由 oa-compat 请求。[官方 handler](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/routes/zen/go/v1/chat/completions.ts) 当前公开 variant parser 读取 reasoningEffort / reasoning_effort / reasoning.effort，不能证明部署端的默认值或续接透传。[parser](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/console/app/src/routes/zen/util/variant.ts)

厂商 API 语义已证实：

- DeepSeek 当前 Flash / V4 Pro 默认 thinking=enabled、effort=high，支持 low/high/max 与工具；带 tools 时，每个历史轮次的完整 reasoning_content 都须回传，即使某轮无工具调用；缺失可返回 400。无 tools 时不需回传。[推理与续接](https://api-docs.deepseek.com/guides/thinking_mode/) thinking 下 tool_choice 只可 none/auto，required 或指定函数会返回 400。[API 约束](https://api-docs.deepseek.com/api/create-chat-completion/)
- GLM 5.3 / 5.3 Flash 强制推理，不能 disabled；标准 API 默认 max，只接受 low/high/max。5.2 默认 enabled/max，可关闭。[推理参数](https://docs.z.ai/guides/capabilities/thinking) 工具 guide 只支持 tool_choice=auto。[工具格式](https://docs.z.ai/guides/capabilities/function-calling) Interleaved thinking 须保留思考块回传；Preserved thinking 使用 clear_thinking=false，完整未改动 reasoning_content 保持原顺序，厂商 Coding Plan 默认开启、标准 API 默认关闭。[续接说明](https://docs.z.ai/guides/capabilities/thinking-mode)
- 厂商当前 DeepSeek Flash/Pro 是 1M context / 最大 384K output；原生旧 Flash IDs 已改路由到 V4.1 Flash，Go 同样路由尚未证实。[厂商容量与别名](https://api-docs.deepseek.com/quick_start/pricing/) GLM 5.2/5.3/5.3 Flash 是 1M / 128K。[5.2](https://docs.z.ai/guides/llm/glm-5.2)、[5.3](https://docs.z.ai/guides/llm/glm-5.3)、[Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) 这些是容量，不是 Go 价格阶梯或已验证的 Go 上限。

本轮仅把 **glm-5.2、deepseek-v4.1-flash** 提供给 AI 自选，准备显式配置 thinkingMode=disabled。GLM 5.2 按 1.40 / 4.40，DeepSeek 按保守峰值 0.30 / 1.20 配置；131072 contextWindowTokens 是本机配置上限，不代表 Go 容量已认证。GLM 5.3 / 5.3 Flash 无法关闭推理，排除本轮 probe 候选。未手编岗位或员工方案。Go 实际默认推理、disabled 参数透传、工具往返、reasoning state 续接、当前账户可用性和账单扣费仍未实测；接入时不能只凭 Chat Completions 标签认定这些能力成立。

已建立待 root 审核的[实际 Edge 配置 helper](/C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/configure-go-models-web-2026-10-06.mjs)，首次写入使用 wx；只完成 node --check（退出 0），没有执行 inspect/save。脚本每型号只允许一次精确 POST /api/models，拒绝现有同 gateway/wire 型号重复新增，保存后核对所有旧对象 SHA，并将新型号保持 untested。截图遮蔽密码输入，未读取或更改 Key。

五项只读集合外，脚本另明确列出 App 启动所需 GET /api/activity、/api/health，需 root 执行前审核；其它 API、收费测试、discover、账单和外站流量均阻止。模型正文只含 gatewayId/name/model/protocol/thinkingMode/inputRate/outputRate/contextWindowTokens，不加 contextBytes。当前源码字段已核对，实际已加载页面仍待 inspect 核验。helper 冻结于 2026-10-06T01:10:57.9094782+00:00，SHA256：`3f35d72f1499da7f8214fc76f7c4b763d4363498948e216248c8f5ad9551ea97`。

