# 两例复测准备证据

- `preflight.json`：JJ 公开本机 API 的只读账本、模型元数据及活动运行快照；不含凭据。
- `quotes.json`：使用产品费用函数对两份实际请求计算的保守预留；真实模型调用 0，数据库查询 0。
- `broker-result.json`：`dry-run` 请求和退出结果，固定本机响应，只验证链路，不证明真实方案质量。
- `windows-harness-tests.txt`、`jj-harness-tests.txt`：两台机器各 10 项脚本回归。
- `source-hashes.sha256`：本轮隔离目录中的产品修复文件与测试脚本哈希，供后续复测核对。
- `real/broker-result.json`：两次真实请求的原文、用量、收据、前后账本；与根目录的 dry-run 文件分开。
- `real/planning-results.json`、`real/sequential-report.json`、`real/bounded-code-review.json`：实际产品接口返回，1 个有效预览、1 个被拒绝草案。
- `audit.mjs`、`audit.json`：只读复核脚本及结果，检查收据/费用/旧预留/源码哈希，并列出原始候选的额度数值和权限问题；不修改候选。旧字段 `plannedBudget` 是任务上限之和，不是执行费用估算，也不能据此认定项目超额，见结果报告的复核更正。

原始七例真实结果仍保留在前一轮证据目录。准备证据不包含交付文件或员工执行成功证明；新增真实结果另列，不与 dry-run 混用。

本轮真实 2 次，成本 $0.0114855，有效预览 1/2。完整解释见 [结果报告](../../orchestration-smoke-result-2026-10-19.md)。
