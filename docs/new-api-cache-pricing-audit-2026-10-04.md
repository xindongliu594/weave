为伍 New API 缓存计价只读审计 · 2026-10-04

结论：真实调用已返回缓存 Token 数量，当前计费将缓存与普通输入合并按全价计算。本站公开价格未提供缓存单价，因此当前金额应视为按已配置单价计算的保守预算估算，不能声称与供应方实际扣费一致。本记录的修复方案尚未实施；既有费用与历史档案保持原状。

真实证据来自运行 `6b8b2a0d-de1e-42f4-8519-db6773854d99`，文件为 `C:\Users\JJ\Desktop\la\agent_department\.data\local\runs\6b8b2a0d-de1e-42f4-8519-db6773854d99\events.jsonl`。本机配置的普通输入/输出费率分别为每百万 Token $0.4 / $1.6。运行适配器把原响应 `usage.prompt_tokens_details.cached_tokens` 转换为档案中的 `model/usage.cacheReadTokens`；下表的输入总数包含缓存，未缓存数与缓存数之和等于输入总数。

| 调用 ID | 输入总数 / 输出 | 未缓存 / 缓存 | 缓存证据 seq（同文件行号） | 本机 billing/usage seq / 金额 | 用户账单截图金额 |
| --- | --- | --- | --- | --- | --- |
| `b59f4854-9580-43cd-a3d7-7dc5efb516bd` | 8468 / 1990 | 5268 / 3200 | 143 | 140 / $0.0065712 | $0.005932 |
| `e1f9f148-6ac3-4876-88bf-8dd9ee538fd0` | 10488 / 1802 | 120 / 10368 | 201 | 198 / $0.0070784 | $0.005006 |

截图金额由主任务提供，用于说明差额。自动修改账单仍需逐请求编号对应的供应方证据，不能仅按 Token 数或余额差匹配。

公开来源查询结果：

- [本站 /api/pricing](https://api.rcouyi.com/api/pricing) 实测 HTTP 200：`gpt-4.1-mini` 为 `quota_type=0`、`model_ratio=0.2`、`completion_ratio=4`，启用 `default` 分组且分组倍率为 1；该行缺少 `cache_ratio` 和缓存写入倍率。现有目录解析器也只保存普通输入/输出费率。
- [本站 /api/ratio_config](https://api.rcouyi.com/api/ratio_config) 实测 HTTP 404；未获得本站缓存倍率。
- [New API 官方价格结构](https://github.com/QuantumNous/new-api/blob/main/model/pricing.go) 支持可选 `cache_ratio` / `create_cache_ratio`；[公开倍率控制器](https://github.com/QuantumNous/new-api/blob/main/controller/ratio_config.go) 要求站点启用倍率公开功能。这说明有可用接口设计，但不证明本站部署已暴露对应字段。
- [官方当前缓存默认配置](https://github.com/QuantumNous/new-api/blob/main/setting/ratio_setting/cache_ratio.go) 中 `gpt-4.1-mini` 的默认缓存倍率为 0.25；[官方额度换算](https://github.com/QuantumNous/new-api/blob/main/common/quota_math.go) 对十进制额度四舍五入。两条截图金额可被“缓存倍率 0.5、每次额度向上取整、每美元 500000 额度”同时拟合，但这是反推假设，与官方当前默认不同，不能据此替本站确认计费规则。

当前局限：

- `services/agent-runtime/openai-compatible.mjs` 的 `actualCost` 按全部输入计费，`onUsage` 未携带缓存数量。普通完成时 `model/usage` 保留缓存；内部失败后的迟到响应只走账单回调、拒绝向代理输出，缓存明细也会随之缺失。
- `apps/api/src/provider.ts` 的需求与规划调用解析只保留输入/输出，丢弃 `prompt_tokens_details`；`cost-control.ts` 也按全部输入重算金额。只修改运行适配器无法统一费用。
- 供应方自动核对仅处理 `uncertain`；已 `settled` 的调用直接返回“已结算”。现有人工核对仅接受输入/输出数量，也无法表达缓存单价或供应方实际金额。
- 唯一匹配的供应方消费日志及固定币种换算可直接提供实际扣费，涵盖缓存折扣。本站此类查询当前受接口限制；兼容总用量或余额差不足以证明某次请求的实际金额。

建议的最小方案（待实施）：

1. 需求、规划、执行与收尾统一保留输入总数、缓存读取数量及是否明确报告该字段，连同调用 ID 写入账单证据。缺字段不能自动宣称缓存为零。
2. 经本站公开价格、逐请求账单或明确人工核实得到缓存单价后，将费率、计费分组、来源、核实时间与版本固定到模型和调用快照。按“未缓存输入 × 普通费率 + 缓存输入 × 缓存费率 + 输出 × 输出费率”计算；预算仍沿用已批准额度和保守预留。
3. 网页区分“按单价估算”与“供应方账单已核对”。无本站价格依据时保留保守金额；历史修正需要可靠供应方证据、并发保护及追加审计记录，保留原记录与已用调用次数。结果未知的调用继续待核对，不能推算为零或重放。

本次仅读取既有档案与无凭据公开接口，没有模型调用或计价实现变更；无密钥、主密钥及个人 IP 被写入此记录。

2026-10-04 18:45 补充：用户提供了含完整请求 ID 和计费明细的新截图，已与真实 Run `9f389049-95a5-4e51-b40e-6d6415be016f` 的 provider-response #303 / billing-usage #304 精确对应。请求 `202610041829442180191970452813` 为 HTTP 200，19527 输入 / 21 输出，其中 455 普通输入、19072 缓存输入；该条明细明确使用缓存倍率 0.5，供应方实收 $0.004030。本地原登记 $0.0078444，差额 $0.0038144 来自全价缓存估算。

这份明细验证了该次请求的缓存倍率，不是对未来全站价格的自动认证。当前代码和历史账面未静默改价；精确关联及截图 SHA、计算结果见 `test-evidence/new-api-bill-detail-match-2026-10-04.json`，个人 IP 未复制。它与 18:31 的 HTTP 403 请求 `2026100418312058604855307789827` 不同，不能用来结算后者。
