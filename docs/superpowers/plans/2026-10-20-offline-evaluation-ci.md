# Offline Evaluation CI Connection

**Goal:** 将已独立审查的 Promptfoo 离线工程评测接到 GitHub Actions；不打开真实执行模式。

**Research/reuse:** `docs/research/enterprise-quality-operations-2026-10-20.md` 已核对 Promptfoo 官方 CI/确定性断言/报告能力。本地桥使用固定 0.124.1，已运行真正 CLI 正/负案例。复用仓库现有 `.github/workflows/core.yml` 和 `desktop-windows.yml` 中固定 SHA 的 checkout、setup-node、upload-artifact；不增加 CI 服务或重新实现断言。

**Architecture:** 独立 workflow，Node 24.15.0（本地实际验证版本），只在 `tools/evaluations` 安装 lock 依赖，禁用生命周期脚本；不安装为伍生产环境、不配置数据库、凭据或模型。Windows/Linux 两平台分别执行原 14 项定向检查，包括实际 CLI 正向/负向两支。结果区分离线规则检查与真实业务质量。

## Constraints and review

- Workflow 仅读仓库，checkout 不保留凭据，不引用 secrets，不执行付费模型或生产 API。
- 复用原测试；CI 显式检查固定包已安装，不能因为测试的本地可选 skip 而误绿。
- 不用 `continue-on-error`；负向 CLI 的非零退出由测试断言，不可吞掉真正测试错误。
- 仅上传合成数据生成的 manifest、gate 和 JUnit（7 天）；不上传原始报告、HTML、日志、私有目录、SQLite、依赖或任意生产资料。缺报告要明确失败，失败状态不能被上传步骤覆盖。
- Node/安装或脚本失败即失败；无需修改根 Node engine。新 job 独立于旧 Core workflow。
- 源码绑定在当前 checkout；源码改变后重跑，不重新标记旧报告。

## Task 1: Wire the existing tests

- [ ] 新建 `.github/workflows/offline-evaluation.yml`，push main/codex branches、pull_request 和手动触发；仅 contents:read，固定 action SHA，Windows/Linux matrix，20 分钟总超时。
- [ ] `npm ci --prefix tools/evaluations --ignore-scripts --no-audit --no-fund`，随后显式校验精确包版本及 Node runtime。
- [ ] 执行 `node --test tests/evaluation-bridge.test.mjs tests/evaluation-release-gate.test.mjs`；现有测试必须真实产出正向 manifest/gate/JUnit 和负向 gate。用 workflow artifacts 的明确路径保留合成证据。
- [ ] 更新 `tools/evaluations/README.md`，说明 CI 范围、机器资源和报告保留；execute 仍禁止。
- [ ] YAML 解析及独立审查；待当前并行源码稳定后，在最新版本执行一次原定向检查。已有旧源码 CLI 报告仅作历史证据。
- [ ] 提交和推送后核对 GitHub 新 job；若网络/托管执行不可用，标明远程未验证，不把本地语法检查称为 CI 通过。

**Not covered:** 企业 API 执行身份、batch 授权和真实模型 eval 等待 A1/A2，仍按原预算规则推进。
