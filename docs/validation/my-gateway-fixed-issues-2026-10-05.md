# 本轮已修复问题（2026-10-05）

本清单区分产品修复、验收工具修复及实际验证边界。v6 真实运行 `1e6a2c30-3e8c-46fd-9c31-d2557768eb9a` 已有员工开发交付和开发测试证据；新真实恢复 `5114bb4f-7ac4-413d-a80f-aceeace8bdec` 已从网页触发并继承 dev，一次 Sol 请求已结算，随后仍被费用上下文门禁阻断。独立 QA 测试命令未执行、经理验收与完整恢复尚未通过，不能称全部 MVP 验收成功。[原开发与预算停止记录](../test-evidence/my-gateway-development-and-budget-stop-2026-10-05.json)、[实际网页恢复](../test-evidence/my-gateway-budget-feedback-resume-2026-10-05.json)

## 产品修复

- **费用预检与执行口径一致、输出上限独立、任务预留恢复。** 列表校验扣除 pending/uncertain；新可选 task.maxOutputTokens 与整项累计估算分开，旧路线不补字段；恢复保留同版本任务预留归属、不在全局重复扣、不被新结算释放。对应本地回归、构建、Edge 取消编辑与空闲重载保持核对已通过，0 新付费调用。[完整证据与限制](project-budget-preflight-and-task-limits-2026-10-05.md)

- **未知费用可显式保留预留继续。** 批准和恢复默认不勾选；用户明确选择后，按原预算扣除已登记费用与全部未结算预留，只使用净余额。旧收据不清零、不记作已消费，批准档案保留审核依据。[后端账本与门禁](../../apps/api/src/cost-control.ts)、[批准/恢复回归](../../tests/cost-carryover.test.ts)、[实际网页批准证据](../test-evidence/my-gateway-web-approve-v6-2026-10-05.json)

- **在途调用与未知外部操作仍阻断。** `pending` 不能由上述选择越过；恢复仍要求单独核对未知命令/修改。新方案批准也检查此前原始档案，未知操作或档案缺失不得通过费用选择盲目重放。[批准检查](../../apps/api/src/app.ts)、[恢复检查](../../apps/api/src/run-management.ts)、[相关回归及最终复测](cost-carryover-2026-10-05.txt)

- **部门日预算消除重复计算。** 活跃运行已经覆盖的本部门请求预留计一次；超出本部门分配的预留及旧未结算收据仍占额度，跨部门调用不会被全局覆盖掩盖。[dailyTotals](../../apps/api/src/cost-control.ts)、[单部门/跨部门预算回归](../../tests/cost-carryover.test.ts)

- **网页分开显示已登记、未知预留与净可用预算。** 批准和恢复区可刷新费用，未知费用默认不自动同意；新未知收据、金额或方案版本变化会使此前选择失效。恢复按归档原预算显示，历史预留不再混入“启动前已用”。方案侧栏已改为“静态估算含 20% 余量，实际以中转站账单为准”，重载后网页已核对显示正确，状态与审批不变。[费用选择组件](../../apps/web/src/CostCarryoverChoice.tsx)、[运行费用显示](../../apps/web/src/BudgetStatus.tsx)、[静态估算文案](../../apps/web/src/App.tsx)、[网页语义回归](../../tests/cost-carryover-ui.test.ts)、[验证输出](cost-carryover-web-2026-10-05.txt)、[重载后网页证据](../test-evidence/my-gateway-budget-service-after-reload-2026-10-05.json)

- **历史预算警告不再误称当前账本。** 真实停止截图暴露旧通知的占用 $0.378745、20/37 次仍显示“已记录”；现明确“历史预算通知”“通知时预算占用（含预留）”及“当时已调用”，保留该事件的数值而不冒充最新次数。当前实费与净可用仍读原费用状态；历史缺字段不猜测，70% 阈值及在途/未知操作门禁不变。局部回归 13/13、类型检查及最终构建通过，空闲重载后 Edge 已核对历史两行与当前账本显示正确，零 POST/模型请求。[实际发现截图](../test-evidence/screenshots/my-gateway-budget-feedback-stopped-2026-10-05.png)、[显示修复](../../apps/web/src/BudgetStatus.tsx)、[回归](../../tests/run-cost.test.ts)、[真实输出](my-gateway-budget-warning-web-2026-10-05.txt)、[构建](my-gateway-budget-dedup-build-2026-10-05.txt)、[加载后网页证据](../test-evidence/my-gateway-budget-dedup-service-after-2026-10-05.json)

- **上游错误提供安全诊断。** 保留 HTTP 失败分类，仅引用有限的供应方错误字段；过滤凭据，对错误正文设置大小与独立读取超时。结果不明的已发送调用继续保留预留，诊断不会自动重放模型。[适配器](../../services/agent-runtime/openai-compatible.mjs)、[错误与结算回归](../../services/agent-runtime/openai-compatible.test.mjs)、[验证输出](my-gateway-upstream-error-2026-10-05.txt)

- **上下文按净余额保留完整组。** 在持久费用预留和发送前，仅移除较早完整消息组；保留当前合同、角色、最新上下文、摘要来源、完整文件 JSON/SHA 和固定知识组。原单价、输出上限及 `UTF-8 JSON 字节 +1024` 预留算法不变；原字节上限失败与财务不可容纳分别报告 `CONTEXT_LIMIT` / `BUDGET_CONTEXT_LIMIT`，失败不发请求。[纯函数](../../services/agent-runtime/limits.mjs)、[适配器接入](../../services/agent-runtime/openai-compatible.mjs)、[保护与失败分类回归](../../services/agent-runtime/affordable-context.test.mjs)、[最终局部验证](my-gateway-budget-context-fit-2026-10-05.txt)。本轮费用下限量化仍不能证明余下 QA 可付：[量化报告](cost-context-lower-bounds-2026-10-05.md)。

- **方案按真实净预算估算多轮费用。** 规划提示明确 Token 是整项任务全部请求的累计估算，涵盖岗位/合同/schema 和文件、知识重复输入、协调与合理修复；项目 generate 获得本地 `planning_budget` 的已记录费用、保留预留、净可用及本次规划上限，返回校验使用规划收费后重新读取的净余额。已本地验证并加载服务；仍是估算，不是完整自适应任务额度分配或完成保证。[累计 Token 定义](../../apps/api/src/execution-prompt.ts)、[规划净预算与收费后校验](../../apps/api/src/app.ts)、[预算职责审查](my-gateway-budget-ownership-review-2026-10-05.md)

- **员工实时预算与 native 最新批准快照修复。** 经理和员工获得当前项目/任务占用、可用额、剩余次数及估算超出状态；原员工 ID 与运行别名都可正确匹配。native pre-step 在可进入本轮后、持久化前刷新批准上下文，发送时保护最新快照整组，避免使用等待分派或旧费用版本；只展示员工获授权的 domain 工具，必要团队和恢复工具保留。前阶段隔离 native **15/15** 验证第一/第二轮当前合同、固定恢复文件 SHA、持久化与 wire 一致，以及模拟费用/调用次数变化；真实 provider fetch 为 0，不是员工真实 QA。[预算反馈](../../services/agent-runtime/budget-context.mjs)、[native 晚刷新与工具过滤](../../services/agent-runtime/employee-hosts.mjs)、[最新快照保护](../../services/agent-runtime/openai-compatible.mjs)、[15/15 阶段证据](../test-evidence/fresh-resume-budget-first-sol-native-refresh-final-2026-10-05.json)

- **product-only 原生任务描述去重。** 仅在宿主确认完整当前批准上下文可靠时，将重复历史需求的 description 改为指向最新批准快照；完整需求、typed 合同、输入/输出 JSON、DAG、恢复与知识/文件 SHA 继续受原保护规则约束。实际 native 隔离 claim `task_details` 从 8,876B 降为 2,445B，最终 probe **20/20**、旧真实费用敏感性 **18/18** 预期门禁通过；没有第二次敏感性 wire，真实模型请求为 0。修复已构建并加载，尚未真实 QA 复验，不代表完整预算管理已实现。[映射](../../services/agent-runtime/handoff.mjs)、[完整性断言](../../services/agent-runtime/host.mjs)、[产品接入](../../services/agent-runtime/product-runtime.mjs)、[独立审查](fresh-resume-claim-budget-review-2026-10-05.md)、[20/20 最终证据](../test-evidence/fresh-resume-budget-first-sol-claim-compact-probe-final-2026-10-05.json)、[18/18 预期拒绝证据](../test-evidence/fresh-resume-budget-first-sol-claim-compact-source-fee-final-2026-10-05.json)

前阶段预算修复在 2026-10-05 04:30:57 UTC 已加载：当时的只读检查记录零模型请求、零供应方查询、零产品 mutation、零浏览器 POST，原 snapshot/journal、1619 条事件、62 条项目用量、费用状态和四个交付/下载 SHA 保持。原 $0.48 未提高，没有自动恢复或重复旧操作，根代理随后受控 fresh resume 同一 v6。去重前 native 首轮保守预留 $0.073602 可入场，但四个完整文件的乐观变体需要 $0.115490；这些是该阶段版本的数值，不证明最新版本完整 QA、复审与经理能完成。[重载前](../test-evidence/my-gateway-budget-service-before-reload-2026-10-05.json)、[重载过程](../test-evidence/my-gateway-budget-service-reload-2026-10-05.json)、[重载后](../test-evidence/my-gateway-budget-service-after-reload-2026-10-05.json)、[费用版本边界](my-gateway-budget-ownership-review-2026-10-05.md)

随后根代理通过网页一次 POST202 完成上述真实恢复首步：Sol 一次用量 7501/54 Token、$0.015542 已结算，没有新未知费用，dev 检查点与完整 DAG 继承、四个文件 SHA 不变；`task_claim` 返回的重复历史需求大工具组使下一轮在发送前 `BUDGET_CONTEXT_LIMIT`，QA 命令和文件修改均为 0。停止证据截至 2026-10-05 04:48:27 UTC，净可用已降为 **$0.0857132**（已记录 $0.3664174、旧未知预留 $0.0278694），v6 21/37 次、余 16 次；原 $0.1012552 仅为启动前历史值。任务描述去重现已完成上述本地验证并加载，没有再次付费恢复或真实 QA 复验；完整自适应任务预算分配未完成。[网页恢复证据](../test-evidence/my-gateway-budget-feedback-resume-2026-10-05.json)、[真实结算、停止与文件保持证据](../test-evidence/my-gateway-budget-feedback-stopped-2026-10-05.json)

最终构建及空闲重载后（2026-10-05 05:08:39 UTC），Edge 已核对历史费用通知与当前实费/净额正确；关闭运行 `5114bb4f…` 的 111 条事件、snapshot/journal、真实收据、全环境 6 笔 unknown 及 history、四个文件与下载 SHA 完全保持，零活动运行、在途调用、审批、POST、模型请求和供应方查询。原额度不变。最新隔离 strict 保护下首条预留 **$0.074238**，低费用 fixture 的 claim 次条 **$0.079952**；旧真实费用 $0.015542 敏感性使次步净额 **$0.0701712 < $0.079956**，因此不再付费恢复试探。此为本地预检/网页/数据保持证据，真实 QA、复审、经理和完整 Todo 交付仍未通过。[最终构建](my-gateway-budget-dedup-build-2026-10-05.txt)、[重载](../test-evidence/my-gateway-budget-dedup-reload-2026-10-05.json)、[重载后实际网页及原数据核对](../test-evidence/my-gateway-budget-dedup-service-after-2026-10-05.json)、[最新费用预检](fresh-resume-claim-budget-review-2026-10-05.md)

## 验收与备份工具修复

- **恢复审计支持混合模型与旧预留。** 审计按每条真实请求核对批准的模型路由，区分当前进行中费用与明确带入的旧未知预留；缺少同意、丢收据、改金额或静默结算等反例必须失败。这是采集/审计工具修复，不代表本轮真实恢复已通过。[采集脚本](../../scripts/capture-mvp-run.mjs)、[审计脚本](../../scripts/verify-real-recovery.mjs)、[隔离反例回归证据](../test-evidence/carryover-recovery-script-regression-final-2026-10-05.json)

- **全量离线备份在隔离目录复验。** 仅在源服务与数据库关闭后复制到全新目录，拒绝覆盖、活跃请求和越界链接；在隔离副本打开及再次打开数据库，核对业务数据与交付文件哈希，并复跑员工开发测试。原环境未被覆盖，历史操作未重放；凭据/授权仅作不透明文件复制，认证迁移有效性尚未验证。这是备份验收工具增强，不能替代独立 QA 或经理验收。[离线备份脚本](../../scripts/verify-mvp-full-offline-backup.mjs)、[安全回归](../../tests/full-offline-backup.test.mjs)、[真实全量复制与隔离恢复证据](../test-evidence/my-gateway-full-backup-2026-10-05.json)

工程最终合并回归、类型检查与构建统计由主验收报告补充；各链接保留真实失败及后续复测，不以本地模拟模型测试代替真实中转站验收。
