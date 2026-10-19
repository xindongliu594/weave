# 证据索引

测试基线 `580aafb`；结果以 [实测报告](../../orchestration-real-test-2026-10-19.md) 为准。

- **真实规划（验收失败）**：`real-evaluation.json` 保存七次原始答案、收据、Token、费用和诊断；`real-planning-results.json` 为产品 API 返回；`real-quality-audit.md` 为独立逐题分析。有效预览 0/7，不存在员工执行证据。
- **隔离回归（通过）**：`contracts.txt` 61 项、`integration.txt` 13 项、`native.txt` 1 项；`offline-results.json` 保留 JJ 原始日志位置。本地副本仅将 `.log` 改为 `.txt` 以纳入版本管理。
- **零付费演练**：`planning-results.json` 和 `dry-run-summary.json`。此处固定回复不生成候选，仅验证测试链路，不属于真实模型验收。
- **测试驱动回归**：`limits.txt` 为 2 项费用守卫；`lifecycle-red.txt` 为修复前的 4 项预期失败，提交副本仅清除行末空白；`lifecycle-green.txt` 为同一组检查修复后通过；`pilot-review.md` 保留审查与限定复审结果。
- **费用与版本**：`baseline.json` 为测试前六笔未知费用基线；`harness-hashes.json` 固定本轮六份测试脚本的 SHA256。实际费用 $0.0399408，六笔旧未知保持不变。

这批证据不包含 API Key、数据库连接串或运行环境配置。完整重复请求保留在 JJ 私有试验目录，未纳入 Git；原始模型回答全部为虚构业务资料。没有截图，亦未进行本轮生产网页端到端验收。
