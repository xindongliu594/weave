# 只读运行回执上下文：本地验证（2026-10-05）

本轮修复已冻结，相关本地回归 **39/39 通过，0 失败、0 跳过**；类型检查、语法检查及 diff 检查通过。[完整输出](runtime-readonly-run-evidence-2026-10-05.txt)；[结果、早期失败及源码 SHA](../test-evidence/runtime-readonly-run-evidence-2026-10-05.json)。本报告不代表两份真实付费验收项目已通过；服务加载、真实 QA/经理验收与受控重启由主代理继续验证。

- [host.mjs](../../services/agent-runtime/host.mjs) 在既有受保护 `department:approved-context` 增加 `runEvidence`。只展示当前任务的已完成祖先，必须有相同 native attempt 的宿主持久交接；不采信模型 `commandsRun`、任意上游 output 或私有知识正文。
- [handoff.mjs](../../services/agent-runtime/handoff.mjs)、[product-tools.mjs](../../services/agent-runtime/product-tools.mjs) 记录实际命令、退出码、审批 ID、call/session、工作区版本及观察事件序号。新的 committed 集合区分临时封存与已持久交接；未提交、旧 attempt 和非祖先回执不可作为下游证据。
- [run-evidence.mjs](../../services/agent-runtime/run-evidence.mjs) 计算实际返回输出的 SHA256 与 UTF-8 字节数，按同 run/call/session/task/attempt/approval 在已有档案严格匹配已完成本机 operation ID。当前执行器合并 stdout/stderr，因此仅 combined output 哈希有效，两个独立流为 unknown；不复制终端正文。哈希基于执行器原返回值，发生档案脱敏时可能与脱敏后的正文不同。
- 同一模块只对单条 `node --test` 的唯一、完整且一致的 TAP/spec 汇总提供 tests/suites/pass/fail/cancelled/skipped/todo。输出缺失、截断、重复汇总、多命令或非 Node 命令都为 unknown，不把员工声明当作测试数。
- [employee-hosts.mjs](../../services/agent-runtime/employee-hosts.mjs) 在原生准入通过后、持久化首次上下文之前等待原交接锁，再刷新原受保护快照。真实本地 native 回归捕获了“经理第一轮缺 QA 回执”的时序问题并验证修复；没有新增工具、外部能力或授权。
- [checkpoint-context.mjs](../../services/agent-runtime/checkpoint-context.mjs) 保留源 run 最近的实际宿主预算检查点及入场账本。节点接受、恢复初始与运行停止检查点标明 point/时间/序号；若之后还有费用或 wire 事件，`currentAtSourceEnd=false`。旧检查点缺失为 unknown；当前继承值单独列出，缺失金额与调用数为 null，不能推定为零。

预算语义：`currentBudget.project.occupied` 是宿主预算占用，包含入场占用、已结算执行费和在途预留，不是实时供应方账单；新增未知费用仍须核对账本。`inherited.recordedCost` 与 `retainedUnknownReservation` 分开。`project.callsUsed` 是宿主已预留的请求尝试计数；入场 `callsUsed` 来自实际 wire 请求档案，两个字段均带 basis。预算、DAG、审批规则及员工产物没有被改写。

新增 [纯回执/隔离子进程测试](../../services/agent-runtime/run-evidence.test.mjs) 5 项与 [原生 DAG 测试](../../services/agent-runtime/run-evidence-native.test.mjs) 2 项。原生正常路径实跑临时 Node 测试并验证经理首次快照持久化完整 QA 元数据、无 QA 私有正文、无额外工具；原生恢复路径核对源预算、继承调用数及文件 SHA，开发员工零派发、零重复操作，QA 继续真实本地命令。

这些 native 测试使用脚本模型替身与本机 operation 档案包装，预算金额为模拟值，不能代替真实模型验收。最初递归 Node 环境变量、缺少 fixture 授权和提前停止 fixture 的失败已在证据分别标为测试工具问题；首次快照时序属于产品修复。未访问原数据库或中转站，未启动/停止服务，未生成生产员工交付文件。

