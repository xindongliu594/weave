# 网页预算与恢复入口审查及最小修复

2026-10-05。先只读审查已加载网页与本机 GET，再按主代理授权修复恢复检查入口。未改原项目、预算、数据库或员工交付，未启动/停止服务，未调用真实模型。新入口截至本记录仅完成本地验证，尚未加载服务或实际浏览器验证。

## 已有实现与实际差距

原实现已能看到已记录费用、未知预留和净可用，默认不勾选保留未知费用；在途调用、未核对外部操作仍阻断。任务卡及编辑器区分累计 Token 与可选单次输出上限，历史预算通知不再冒充实时余额。[费用选择](../../apps/web/src/CostCarryoverChoice.tsx)、[历史通知](../../apps/web/src/BudgetStatus.tsx)、[任务字段](../../apps/web/src/PlanTaskBudget.tsx)、[已加载与 Edge 证据](project-budget-preflight-and-task-limits-2026-10-05.md)

本轮实际只读 GET `/api/runs/5114bb4f-7ac4-413d-a80f-aceeace8bdec` 与 `/api/projects` 均为 200：原项目 dde78f91-2a99-4a63-a9fa-5cb7bab2b8f0、方案 v6、总额 $0.48、已登记 $0.3664174、未知预留 $0.0278694、净额 $0.0857132、111 条事件保持；方案静态估算 $0.033276、validation.valid=true。GET run 的 recovery 只有 unknownOperations/costBlocked/costReadiness。静态通过不能证明当前恢复的模型请求可付；旧真实失败也不能证明更新后的请求仍必然不可付。[真实停止记录](../test-evidence/my-gateway-budget-feedback-stopped-2026-10-05.json)、[上次零修改重载](../test-evidence/task-output-budget-service-after-2026-10-05.json)

优先缺口是：项目有余额时，用户看不到原版本的完整调用次数、任务已用及未知占用；TASK_BUDGET_EXHAUSTED 原来到 POST 才拒绝。停止后运行详情不再轮询，旧失败容易被误解为当前预检。批准页的静态估算及任务额度尚未为 QA/复审/经理阶段锁定资金；动态分配属于后续能力，不能用现有静态字段代替。[恢复原门禁](../../apps/api/src/run-management.ts)、[详情刷新](../../apps/web/src/RunCenter.tsx)

## 本轮最小实现

新增 `GET /api/runs/:id/recovery-check?retainUncertainCosts=false&acknowledgeUnknownOperations=false`，由原 runManagementRouter 挂载，无需修改 app.ts。两个 query 参数只接受 true/false，缺省均为 false。使用 repeatable-read、read-only 事务；只读取账本、原版本历史、档案、检查点、授权、模型配置和每日额度，不做收据过期处理、不创建队列、不保留资金、不追加档案或请求中转站。授权验证使用同一只读数据视图，检查路径移除原 validator 的 SHARE 锁后缀，POST 的授权锁保留。[路由](../../apps/api/src/run-management.ts)、[检查辅助模块](../../apps/api/src/recovery-conditions.ts)

返回 checkedAt、runId/projectId/planVersion、originalBudget、当前 costReadiness；calls 包含同版本已用/上限/剩余，tasks 包含实费、held、自身上限余量、已用/剩余调用和完成标记。resume 与 retry 各有 allowed/reasons/completedTaskIds；reasons 包含明确 code/message。另返回本次费用/外部操作确认选择、未知操作数量及 ID、existingRunId（若已有子运行）、nativeRequestChecked:false。调用历史无法核验时不返回假零次数。

项目净额、原 90% 重试限制、同版本全局调用上限和任务 cost+reserved/次数判定已抽取为纯函数，由 GET 与 POST 共用。恢复只跳过已核验完成任务；完整重试继续受这些任务的历史额度约束。原额度、单价、确认默认值与保守预留算法不变。

网页新增“检查恢复条件”，默认未检查不放行恢复/完整重试。显示检查时点、原版本、费用与完整次数，展开查看任务余量；区分两种恢复方式的拒绝原因。费用收据、金额、版本、费用确认或外部操作集合变化后旧结果失效；最新 GET 出现此前没看到的未知操作也不能沿用旧确认。用户确认提交时先再只读检查一次，检查通过且与所见条件匹配才 POST，后端仍在锁内复核。旧错误标题标为“上次失败/停止原因”。[网页入口](../../apps/web/src/RunExtras.tsx)、[纯展示及结果身份](../../apps/web/src/RecoveryConditions.tsx)

具体模型请求尚未检查，页面明确写出该限制。静态估算只显示为批准时的累计 Token 估算；本地条件通过不代表下一次请求或全部 QA/经理过程可承担。主代理的无付费 native packet 预检尚待集成，不能把本检查称作完整费用可行性证明。

## 验证与剩余验收

[原始本地输出](recovery-conditions-local-2026-10-05.txt)：新增隔离 HTTP 7/7，网页新增 5 加既有费用 13 共 18/18，原费用承接与 POST 恢复回归 14/14；类型检查通过。HTTP 覆盖原 snapshot cap 与最新账本、任务 held、两种恢复差异、pending 不过期、原 90%/每日门禁、版本和模型变化、外部操作确认独立。GET 前后七张关键表及测试档案 SHA 相同，模型 sentinel 请求为 0。[API 测试](../../tests/recovery-conditions.test.ts)、[网页测试](../../tests/recovery-conditions-ui.test.ts)

最初 3 个测试因新证据采集函数将 request_keys 错当成有 id 列而失败；改为按整行 JSON 排序后通过。这是测试工具修复，没有为通过测试降低产品门禁。PGlite 不能证明独立 PostgreSQL 锁语义，本次未做该验证。

下一步由主代理构建、重载并在可用浏览器验证：未检查/读取中/失败/过期状态可见；任务上限耗尽且项目仍有余额时不 POST；费用或新未知操作使旧检查失效；当前原 v6 显示 21/37 与实时净额，旧静态估算和上次失败不冒充 native 预检。不得点击付费恢复来代替检查。真实 QA、复审、经理验收及恢复完成仍未通过。
