# 首页组织规划超时修复

2026-10-05 18:56（UTC+8）。真实首次 Astra 请求返回 HTTP 502 `GATEWAY_TIMEOUT`，新增未知费用预留 $0.37821、无团队创建：[实际网页证据](../test-evidence/funded-normal-send-2026-10-05T10-42-57-801Z-fb24616f.json)。记录起止约 92.6 秒，包含网页取证开销，与原组织调用的默认 90 秒等待相符；错误码也覆盖底层连接超时，不能据此判定模型仍在生成或上游未扣费。

已核对的调用链：

- [provider.ts](../../apps/api/src/provider.ts) 的普通 `gatewayRequest` 默认 `AbortSignal.timeout(90000)`，同一信号覆盖 fetch 和读取完整 JSON；模型请求为 `stream:false`。响应头到达前和正文读取超时都可返回 `GATEWAY_TIMEOUT`。
- [app.ts](../../apps/api/src/app.ts) 的既有项目生成显式采用 `PLANNING_TIMEOUT_MS=180000`；首页 [organization-chat.ts](../../apps/api/src/organization-chat.ts) 此前未传该选项，故只有 90 秒。现在沿用现有 180 秒规划期限，映射为 `PLANNING_TIMEOUT` 并明确现有部门/方案未变、本轮费用待核对、核对账单后再重试。单次输出仍 4000，预算、模型范围和预留公式不变。
- 项目 `policy.deadlineSeconds` 是执行时限，不控制组织规划等待；网关网页/契约目前没有可编辑的模型等待字段。此次复用原有三分钟配置，不新增权限或额度。
- [api.ts](../../apps/web/src/api.ts) 仅 GET 有 10 秒读取期限，POST 没有该限制；Vite 代理和本机 API 未自设此次响应的额外超时。
- [cost-control.ts](../../apps/api/src/cost-control.ts) 在请求前预留，未收到用量则保留为 `uncertain`。API 幂等缓存保存失败 HTTP；同 key 重读返回同一失败，不再发模型请求，也不能恢复已被取消的旧上游响应。

本地验证：[组织对话回归](../../tests/organization-chat.test.ts)，[原始输出](organization-planning-timeout-2026-10-05.txt)。使用每文件全新内存 PGlite 与本机 HTTP 测试服务；两个新增场景将配置的 180000ms 在测试中缩至 200ms，分别实际阻塞响应头与 JSON 正文。14/14 通过，失败/跳过 0；`npx tsc --noEmit` 和相关 diff-check 均退出 0。

新增断言覆盖真实路由传 180 秒且不回退 90 秒、传输配置不进入模型 JSON、完整保守金额仍预留、既有费用/方案不变、无正式团队/项目/执行/虚构用量、同 key 两次重读仅返回缓存 502（总上游请求 1 次），以及已收到的 HTTP200 头证据保留。

边界：这是本地超时/幂等回归，不是 Astra 成功验收。原未知费用未结算，产品服务未重启或重新加载；旧请求缓存也未更改。首页在收到已缓存的失败 HTTP 后允许用户另发新 key，那属于新的付费请求，不能当作获取旧结果；当前错误提示要求先核对费用。本轮真实请求恢复与供应方收费情况由主代理独立核验。
