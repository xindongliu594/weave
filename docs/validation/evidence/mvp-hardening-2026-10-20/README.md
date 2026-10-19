# 工程加固证据索引

这里保存可公开的隔离工程测试、部署与恢复摘要。固定模型替身、模拟沙箱身份及合成文件负载均不计为真实员工验收。业务数据库内容、完整业务指纹、凭据与生产原始日志仍留在 JJ。

| 记录 | 覆盖 |
| --- | --- |
| `product-flow-fixed.txt` | 19 项 API 主流程：独立 QA、两次中断、预算与完成节点、审批取消、未知写入不重放 |
| `product-flow-coordinator.txt` | 协调会话修复后的同一 19 项 API 主流程再验，144.29 秒 |
| `supervisor-green.txt` | 正常员工身份与阶段持久化、独立进程读回、100 次不变状态不重复写 |
| `backup-review-green.txt`、`backup-reviewed-integration.txt` | 内容对象、来源链和原始回执验证；加密备份隔离导入、拒绝损坏、目标数据不变 |
| `storage-checkpoints.txt` | 工作副本清理/日志压缩不破坏检查点 |
| `step-reviewed.txt`、`crash-policy-unrestricted.txt` | 继承条件、实际测试后强制终止、测试总执行一次；DSH 请求/工具前落盘与取消 |
| `cross-module-api.txt` | 知识和能力权限、恢复条件、存储 API |
| `recovery-ui.txt`、`reply-ui.txt` | 恢复确认失效、费用/错误提示、经理摘要与折叠原文 |
| `linux-final-tests.txt`、`linux-final-backup.txt` | JJ 发布前 48 项运行时与 6 项备份测试 |
| `build-ui.txt` | TypeScript 检查和 Vite 构建 |
| `boundary-green.txt`、`harness-zero-green.txt`、`deploy-green.txt` | 待用真实验收脚本的零付费预检及发布回滚回归 |
| `checkpoint-growth-*.json` | Windows/JJ 各 600 次保存，完整内容读回与磁盘/耗时统计；非五小时墙钟耐久 |
| `restore-summary.json` | 停止备份的真实数据隔离恢复、二次打开比对、临时副本清理 |
| `deployment-summary.json` | 发布路径、原包及脚本覆盖哈希、停止状态检查、账本条数保持 |
| `runtime-audit-summary.json` | 初始 60 文件审计的失败名单与逐项修复证据；不是一次完整全绿运行 |
| `coordinator-context-red.txt`、`coordinator-permissions-green.txt` | 协调员误用员工任务上下文的复现；修复后的上下文、隔离与权限 38 项 |
| `history-and-task-context-green.txt` | Responses 原始历史格式与恢复文件合同 20 项 |
| `delivery-settlement-bounded.txt`、`model-settlement-native-fixture.txt` | 真实本地 HTTP 的交付/取消/内部停滞费用结算；分别 2 项和 6 项 |
| `handoff-fixtures-green.txt`、`task-output-fixed.txt` | 工具注册/员工授权下的文件交接 7 项；按任务输出上限 3 项 |
| `build-runtime.txt`、`deploy-runtime-green.txt` | 新增运行时修复后的类型检查/构建和发布回滚回归 |
| `linux-runtime-tests.txt`、`linux-runtime-backup.txt`、`deployment-runtime-summary.json` | 最新 JJ 发布前 92 项运行时、6 项备份与空闲/费用保持核对 |

复验命令按仓库根目录执行，例如：

```text
node scripts/test-integration.mjs tests/product-flow.test.ts
node --test services/agent-runtime/supervisor-persistence.test.mjs services/agent-runtime/sandbox-checkpoint.test.mjs services/agent-runtime/step-checkpoint-crash.test.mjs
node scripts/validation/mvp-hardening/checkpoint-growth.mjs
npm run build
```

Windows 受限测试环境阻止临时文件原子替换或本地测试套接字时，本轮使用普通运行权限重跑受影响测试；未据此放宽产品沙箱。生产备份不在本目录，不能把这里的夹具输出导入生产。
