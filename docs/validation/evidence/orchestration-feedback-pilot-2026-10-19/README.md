# 单次草案纠正准备证据

根目录及 `dry-run/` 为零付费准备，原始失败响应来自上一轮已保存证据。`real/` 另存用户批准后的一次真实纠正，实际 $0.0057051、0/1 有效预览；不能与零付费结果混用。

- `prepare-result.json`：JJ 基线、五个覆盖脚本 SHA256、测试和演练退出码、实际请求报价。
- `baseline.json`：只读消费汇总、六笔旧未知费用的 ID/状态/金额及公开模型元数据。没有凭据。
- `quote.json`：现有 `budgetedRequestEstimate` 对完整请求的预留，$0.0177336；非实际消费。
- `windows.txt` / `tests.txt`：Windows、JJ 各 12 项脚本回归通过。
- `dry-run.txt`：JJ 一次本地回放、一次纠正请求、零付费及零部门/项目写入摘要。
- `dry-run/replayed-failure.json`：产品对原始失败响应生成的完整反馈，以及原响应 SHA256。
- `dry-run/broker-result.json`：完整组装请求和零付费假响应，明确 `mode=dry-run`、`acceptancePassed=false`。
- `dry-run/planning-results.json`：该假响应没有有效预览，不能当成真实模型失败或成功。
- `prepare-jj.py`：本轮实际执行的固定目录准备脚本；只允许首次创建，运行零付费回归/报价和只读基线核对，不读取生产进程环境，不执行付费 launcher。
- `review.md`：独立审查结果及未覆盖负例的限制。
- `real/`：本次真实响应、原始请求、账本前后值、收据、API 拒绝结果及本地回放反馈。
- `audit.mjs` / `audit.json`：只读重新检查真实费用、收据、未知预留、原文哈希、结构/任务合同及失败交付映射；不修改原候选。运行 `node --import tsx docs/validation/evidence/orchestration-feedback-pilot-2026-10-19/audit.mjs` 可复核，不调用模型。

源码基线 `5055aab` 加 `prepare-result.json` 的五个覆盖脚本。固定原始失败内容 SHA256 为 `492a6d51d11205e81b4bc0cd7ef9dce3ac1dfd015cf60e4f87fb6f132516fbbb`，未经编辑。

复现本地回归：`node --test scripts/validation/orchestration-planning-pilot/feedback.test.mjs scripts/validation/orchestration-planning-pilot/limits.test.mjs scripts/validation/orchestration-planning-pilot/lifecycle.test.mjs`。Windows 需要允许本机临时数据库的回环 TCP 连接。直接测试子进程及脚本行为，不使用浏览器。
