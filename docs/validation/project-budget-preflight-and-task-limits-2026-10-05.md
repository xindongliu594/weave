# 预算预检、单次输出上限与任务费用恢复

截至 2026-10-05 13:54（Asia/Shanghai），三处预算口径问题已修复、构建并加载。用户确认项目总上限，方案 AI 估算整项工作并建议任务额度；本次补齐程序的校验与恢复，不把修复算作 AI 已完成动态资金分配。完整真实 QA、复审、经理验收仍受阻，没有新增付费运行。

## 已修复

1. 项目列表与批准都按净额校验：原总上限减全部已登记费用，再减 pending/uncertain 预留。GET 在一个数据库视图内汇总，不修改、过期或结算收据。既有 planningCost 字段仍是全部已登记项目费用，不将它误称为仅规划费。[API](../../apps/api/src/app.ts)、[集成回归](../../tests/execution-policy.test.ts)
2. 新批准方案可显式填写 task.maxOutputTokens，范围 1–32768。estimatedInputTokens / estimatedOutputTokens 是整项任务所有请求的累计估算。模型请求先核对任务和员工，再取任务、已批准模型及本次请求上限的最小值；备用模型、恢复及返工也受原任务限制。缺字段的旧合同不补默认值，旧 v6 的固定模型上限不变。[合同](../../packages/contracts/index.ts)、[适配器](../../services/agent-runtime/openai-compatible.mjs)、[规划指引](../../apps/api/src/execution-prompt.ts)
3. 恢复时按原方案版本保留每个任务的未结算费用归属，taskUsage.reserved 与已确认 cost 分开。项目 priorSpend 已含这些保留金额，不在全局重复扣除；新请求释放或结算不能释放旧未知收据。任务上限被 cost + reserved 占满时，恢复在排队及请求前拒绝，即使项目仍有余额。[历史计算](../../apps/api/src/budget-history.ts)、[恢复入口](../../apps/api/src/run-management.ts)、[预算桶](../../services/agent-runtime/budget.mjs)

网页任务卡显示任务金额及调用上限、累计输入/输出和单次输出限制。编辑器区分字段，旧计划的可选单次字段为空；填写、清空及取消不保存计划。[网页组件](../../apps/web/src/PlanTaskBudget.tsx)

## 实际工程验证

| 范围 | 结果及证据 |
| --- | --- |
| API 权限、费用净额、批准冻结及旧路线 | [7 通过、2 跳过](project-net-budget-and-output-policy-final-2026-10-05.txt)。两个独立 PostgreSQL 锁场景不能由 PGlite 证明。未知 .4 的计划在列表和批准均不可付；查询及拒绝不改收据或调用模型。 |
| 多轮组队及方案准备状态 | [12 + 4 通过](project-budget-planner-regression-2026-10-05.txt)。本地模拟接口，不是 Astra 真实方案验收。 |
| 费用继承及恢复 | [14 通过](task-held-budget-recovery-2026-10-05.txt)。任务未知 .2 占满自身 .2 上限而项目仍余 .78，恢复拒绝；已完成节点不重派，原收据保持。 |
| 单次上限、原生首轮/恢复及返工 | [核心 59 通过](task-output-limit-separation-2026-10-05.txt)，[另 9 个已有原生返工场景通过](task-output-limit-separation-initial-2026-10-05.txt)。累计输出 9000 的任务单次 321，持久上下文、预留公式和 wire 一致；返工拒用模型提出的 9999，沿原任务上限。[源码 SHA 与边界](../test-evidence/task-output-limit-separation-2026-10-05.json) |
| 任务保留金额及新结算不释放旧收据 | [预算桶 10 通过](task-held-budget-guard-final-2026-10-05.txt)。与前行存在覆盖交集，不相加算总数。 |
| 网页预算字段 | [5 通过、类型检查通过](plan-budget-ui-2026-10-05.txt)。新字段默认空，清空序列化省略，累计费用估算不随单次上限变化。 |
| 构建 | [tsc + Vite 通过](task-output-budget-build-2026-10-05.txt)，1685 模块，生产 JS 495.78 kB。 |

初轮失败记录保留：新增 API fixture 的 history 数组需显式 JSON 序列化，其 pending 测试收据需在断言后关闭；货币释放存在 IEEE754 极小舍入，金额断言改为 1e-10 容差；返工 fixture 改为返回真实语义的新状态快照。最终相关测试通过，未因此修改原账本或降低产品门禁。

## 空闲服务重载及浏览器

重载前活动项目、在途请求、审批及外部操作均为 0。只停止身份、父进程及创建时间匹配的旧 API；沿同一原数据目录隐藏启动，不自动恢复项目。[维护记录](../test-evidence/task-output-budget-reload-2026-10-05.json)

重载后服务为 launcher 20772、API 32536、web 4310，数据库与运行时健康。Edge 隔离浏览器实际打开原 v6，四个任务的预算摘要可见，编辑器各单次字段为空；填写 256 后清空并取消，无 POST/PUT/DELETE、页面异常或付费调用。原计划、policy、完整 snapshot/journal 111 事件、真实 Sol 收据、人工零费依据、六条未知费用 history 及四文件下载 SHA 与重载前逐项一致。[重载前](../test-evidence/task-output-budget-service-before-2026-10-05.json)、[重载后](../test-evidence/task-output-budget-service-after-2026-10-05.json)

已实际查看 [方案页截图](../test-evidence/screenshots/task-output-budget-plan-after-2026-10-05.png) 与 [编辑器截图](../test-evidence/screenshots/task-output-budget-editor-after-2026-10-05.png)。运行页仍能看到当前净额、历史费用通知、失败原因和默认未勾选的费用继续入口。

## 仍缺的实际验收

原总额 $0.48、登记 $0.3664174、未知预留 $0.0278694、净额 $0.0857132，v6 已用 21/37 次均不变。此次没有新运行 ID；最新真实运行仍是 5114bb4f-7ac4-413d-a80f-aceeace8bdec。旧 v6 没有新单次字段，不暗中降低它的输出或重写批准合同。

任务 maxBudget 仍是自身费用上限与项目共享约束，尚不为后续阶段锁定资金；协调共享池及经理动态再分配仍未实现。批准前的静态费用校验也不能保证全部未来文件/工具结果都可付。重复内容量化见 [独立审查](request-context-duplication-review-2026-10-05.md)，不能用这次本地上限回归或旧低费 probe 冒充真实模型验收。真实 QA、review、经理及受控中断后完成仍须继续验证。
