# 交付映射单次真实验证证据

- 源码基线 `a05f034`；本轮五个脚本覆盖的 SHA256 在 `prepare-result.json`，已逐一与本地核对。
- `red.txt`：新配置尚未实现时，两项针对性测试失败。
- `windows.txt` / `tests.txt`：Windows/JJ 各14项脚本回归通过；Windows临时回环数据库需沙箱外运行。
- `prepare-jj.py`：固定新目录准备脚本，只运行回归、零付费演练、只读账本检查和请求报价。
- `prepare-result.json` / `baseline.json` / `quote.json`：零付费预检与预算边界，无凭据。
- `dry-run.txt`：假响应仅检验链路，不能计作真实模型成功或失败。
- `review.md`：付费前独立审查，无待修问题。
- `real/`：一次真实请求/原始响应、产品反馈、预览结果、收据和账本前后值。原始候选未经修改。
- `audit.mjs` / `audit.json`：调用后仅读取保存证据重新核对合同、费用、六笔旧预留与原文哈希；不请求模型。
- `postfix/` / `verify-jj-postfix.py`：实际结果发现未来 QA 文件依赖后的本地修复证据；Windows/JJ 各110项单元/脚本、46项API，Windows构建通过。原实验源码不覆盖。

真实 API 当时返回有效预览，但整体合理性未通过。当前复核分别保留 `trialPreviewPassed=true` 与 `currentContractPassed=false`，不能把前者当作实际可执行验收。

复核：`node --import tsx docs/validation/evidence/delivery-binding-pilot-2026-10-19/audit.mjs`。

本轮不执行员工、不创建正式部门/项目、不部署生产或验证重启恢复。日志仅清理行尾空白，不改变检查结果。
