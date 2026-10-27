# 完成交付时在途员工请求的收尾修复

实际恢复 child `6e860c3c-113c-4245-b400-df85b950769e` 已完成全部任务，但收据 `c55a3d36-f662-48ef-a69e-baf1ecf26c40` 的供应方用量未知，预留 **$0.0516951**。本次仅对封存原始档案与运行器源码做本地诊断，未查询中转站、重放请求或修改费用。

## 确切原始证据

原完整 3475-event archive SHA256 `ef78ede0c817ad8557b933878139897ef1c307aff059533e74d0826cd5cbe87c` 已核对。

| 序号 | UTC 时间 | 实际事实 |
| --- | --- | --- |
| #3441 | 04:10:09.725 | 经理任务接受并封存。 |
| #3449 / #3454 | 04:10:09.758 / 04:10:11.296 | 经理任务员工 session `69c42a73-b6d0-4d79-9033-a3415394886e` 在 tool completion 后继续 native step，发出上述尾部请求。 |
| #3455–3461 | 04:10:41.930–04:10:42.162 | 另一个 captain 请求 `6808fb60-9253-485b-b5ea-8e04136def6b` 得到 HTTP200、usage，并结束回合。 |
| #3462 | 04:10:42.165 | 四任务均 completed 的最终检查点。 |
| #3463 / #3464 | 04:10:42.171 / 04:10:42.191 | 成功关闭 Host 后上述经理尾请求记为 `CALL_INTERRUPTED`，native finish 为 aborted。 |
| #3470 / #3475 | 04:10:42.867 / 04:10:42.890 | 员工 Host disposed，Run finished completed。 |

unknown 请求**不是 captain**。该请求没有 provider-response 或 billing/usage，没有运行 anomaly/deadline，也没有 model/error。事件顺序和代码一致：成功分支只 `await captain.whenIdle()`，随后 `host.close()` 取消尚在途的其他员工请求。

这是本地成功收尾缺口；供应方到底是否完成或扣费仍不能从本地取消推定。原 unknown 和预留必须继续保留，不能清零或重放。

## 最小修复

只改 `product-runtime.mjs` 成功分支，复用已有 `stopAdmission` 与 `adapter.drain`：

1. 全部批准交付通过宿主验证后，停止新的模型入场。
2. 已实际派发的请求最多等待原有 30 秒收尾，只登记原响应真实 usage；内部 stop 阻止迟到工具、fallback 和新模型派发。
3. 之后关闭所有员工 Host。超时或用户取消仍保留未知费用，批准 deadline 与取消 signal 优先；取消期间不会标为 completed。

没有重写 DSH/AgentTeams，没有降低输出上限、改额度或自动核对账单，也没有重跑已完成任务。

## 工程验证

使用实际安装的 DSH Host、native claim/in_progress/completed 和延迟本地 HTTP 响应，在临时目录重现成功交付后的 member 尾请求。新增回归验证：原响应 usage 在关闭前落盘；迟到消息工具不执行；收尾开始后没有新增 wire；用户在收尾时取消仍 cancelled，未知已派发费用不猜测或按 0 结算。

相关 **24/24 PASS，0 skip**，包含原 30 秒上限、费用持久化、失败收尾、取消/deadline、完整质量 seal、冷恢复；`tsc --noEmit` **exit 0**。这些是隔离运行器工程测试，只使用 loopback fixture HTTP，**不替代已有真实 Todo 项目验收**。

证据：

- `docs/test-evidence/go-recovery-v12-tail-interruption-readonly-2026-10-07.json`（15 条精确来源事件，原档案不改）
- `docs/test-evidence/go-delivery-settlement-tests-2026-10-07.txt`
- `docs/test-evidence/go-delivery-settlement-types-2026-10-07.txt`
- `docs/test-evidence/go-delivery-settlement-manifest-2026-10-07.json`

当前新收尾源码尚待主代理完成离线备份后重启加载；本任务没有重启服务或访问原数据。原恢复 child 已接受产物、任务与费用记录保持原样，旧 unknown 将随备份保留。
