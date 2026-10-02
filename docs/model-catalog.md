# 模型目录与自动填价

接入中转站时点击“保存并获取模型与价格”；已保存的连接也有“获取模型与价格”按钮。后端使用保存的 Key 读取该中转站的 `/models`，前端只得到公开目录，不会得到 Key。可以搜索模型，选择后填入模型 ID、名称和可确认的输入输出单价，再保存模型。目录查询不进行推理或能力测试，不批量添加模型，也不修改已配置模型的价格。

## 测试 API 服务

中转站卡片的“测试 API 服务”使用当前保存的地址和密钥读取 `/models`，显示检查时间、耗时、目录数量和 HTTP 状态。连接拒绝、域名解析失败、超时、401/403、错误地址、限流、服务端错误以及不兼容的目录会给出对应原因；空目录单独提示。请求限制为 15 秒、8 MiB，不跟随重定向，也不回显中转站错误正文或密钥。检查期间配置发生变化时拒绝旧结果，前端编辑连接后清除旧检查状态。

该按钮不调用推理、不读取报价，也不改变模型连接或工具能力状态。目录可能是公开接口，因此“服务可访问”只证明当前配置能取得目录，不能证明全部模型、余额和工具调用可用。验证发消息需在已添加的模型卡片点击“测试连接”；执行员工任务前还需“测试工具能力”。这两类模型测试会走费用记录与预算检查。

## 默认采用官方公开价格

2026-10-02 用户指定按官方价格填写。新连接及未设置来源的旧连接默认使用 OpenAI 官方价格；中转站报价仍可在“价格来源”中显式选择。当前官方表为维护的核对快照，页面分别显示模型目录的读取时间和官方价格的核对日期，不能把点击时间当成官方价格更新日期。后续官方变价需要更新 `apps/api/src/official-model-prices.ts`；当前按钮不会抓取或解析官方网页。

当前已核对的 Standard 普通档文本价格如下，单位为 USD / 百万 Token：

| 准确模型 ID / 官方来源 | 输入 | 输出 |
|---|---:|---:|
| [gpt-5.5](https://developers.openai.com/api/docs/models/gpt-5.5) | 5 | 30 |
| [gpt-5.6-sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) | 4 | 20 |
| [gpt-5.6-terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) | 2 | 12 |
| [gpt-5.6-luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) | 0.2 | 1.2 |
| [gpt-6-astra](https://developers.openai.com/api/docs/models/gpt-6-astra) | 10 | 50 |
| [gpt-6-sol](https://developers.openai.com/api/docs/models/gpt-6-sol) | 2 | 10 |
| [gpt-6-luna](https://developers.openai.com/api/docs/models/gpt-6-luna) | 0.1 | 0.5 |
| [gpt-6.1-sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) | 2 | 10 |

以上模型输入超过 272K Token 时，输入单价为普通档的 2 倍，输出为 1.5 倍。“官方计费档位”可选普通档和长上下文档。为适配现有固定单价的费用系统，普通档导入默认将上下文总容量限制在 272K Token 内；目录提供更小容量时保持该较小值。长上下文档填写对应的较高单价。手动扩大普通档容量时需同时核对适用价格。Fast 模式、缓存、地区附加费、图像及服务商倍率不在这两个固定单价中；官方报价用于本项目的费用估算，实际扣费以所配置服务的账单为准。[官方价格说明](https://developers.openai.com/api/docs/pricing)

只精确匹配已核对的 ID，不删除供应商前缀、忽略后缀或按相近型号推算。当前中转站的 `codex-auto-review`、`gpt-reserve`、`gpt-image-2.5` 没有匹配的官方文本单价，保留“价格待填写”；其中图像模型不能用普通文本价格替代图像计费。未知价格不会自动填为零，手动添加仍要求完整的输入输出单价。

## 其他价格来源

- “中转站报价：仅模型目录”支持 [OpenRouter 模型目录](https://openrouter.ai/docs/guides/overview/models) 的 `pricing.prompt` / `pricing.completion`（USD / Token），换算为每百万 Token。明确的两项零值可导入；缺失、空值、负值及非有限值均不能当作免费。
- “中转站报价：New API”读取同站点公开的 `/api/pricing`，不向该公开路径发送模型 Key。按 [New API 倍率规则](https://docs.newapi.pro/en/docs/guide/console/settings/rate-settings)，输入价为模型倍率 × 2 × 分组倍率，输出再乘补全倍率。用户须选择 Key 的实际分组；不会自动选择默认组，个人折扣和自动分组需自行核对。
- “中转站报价：自动识别”先读取目录报价，对缺失项尝试上述公开价格。公开价格失败仍返回已有模型目录，不影响手动填写。

非 USD、不明单位、按次收费和条件/分档报价显示需核对，不自动换算。公开价格不会增加 Key 的模型目录之外的模型。查询限制响应大小、读取超时和重定向；配置在查询期间改变时拒绝返回旧报价。保存成功而查询失败时保留连接，直接重试不会重复创建连接。

## 验证

`tests/model-catalog.test.ts` 覆盖报价换算、真实零价、缺失/错误报价、分组倍率、按次计费、精确匹配和官方核对日期。`tests/api.test.ts` 覆盖保存后读取、凭证不回显、公开路径不携带 Key、查询不触发推理、配置和单价不被查询覆盖、来源选择、失败降级、响应上限及查询期间的版本竞争。协议测试均使用本地固定服务，不向真实模型发起推理。
