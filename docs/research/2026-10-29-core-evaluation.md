# Core v2 评测调研

2026-10-29。只在隔离工作目录运行，无付费模型、生产数据、生产部署。

现状：`tools/evaluations` 固定并已安装 Promptfoo **0.124.1**，Node 实测 24.15.0；运行服务 DSH 固定 **0.1.5-rc.1**。旧 `synthetic-v1` 五例与其 provider、criteria、manifest 和 release gate 保留原义。它们仅证明 fixture 不变量，不证明真实模型质量。

复用官方 [JavaScript provider](https://www.promptfoo.dev/docs/providers/custom-api/) 的 id/callApi 和 [JavaScript assertion](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/) 返回 pass/score/reason 接口；固定版现有桥已采用该接口，新增桥须以本机固定版 CLI 实测。复用原 offline-guard、受限文件读取、sourceIdentity 和 CLI JSON/JUnit/HTML。仅实现新版数据、产品函数适配、独立 oracle 与证据门禁，不重造执行引擎。

[AgentEvals](https://github.com/langchain-ai/agentevals) 可做轨迹匹配，但不能替代 DAG 前置依赖与宿主回执。本轮使用现有产品合同校验，不新增该依赖。[dsh-eval](https://github.com/hccccc01333/dsh-eval) 有 headless/replay/轨迹功能，但当前未安装，也未验证与固定 DSH 的兼容性；不替换已有 Promptfoo。DSH 市场发现及兼容性沿用 [七维设计稿](../superpowers/specs/2026-10-25-agent-evaluation-design.md) 的调研结论，本轮仅复核作者仓库，未实际安装市场插件。

32 例主维度数量为结果4、RAG8、证据4、过程4、稳定性4、成本4、安全4。首批预计23例为实际产品函数检查，合成输入必须明示；9例需要真实模型、跨身份服务、真实中断或外部效果，保留 pending，不能算通过。函数调用不是 Agent 完成真实业务的证明；成本检查不证明节省 Token。

产品复用点：`acceptance-checks.mjs`、`knowledge.mjs`、`budget.mjs`、`run-evidence.mjs`、`packages/contracts/orchestration.ts`、`permissionChecks`。不改这些实现，不读取生产归档。每例保存独立预期、实际返回和必需证据；正常、拒绝和故障输入分开记录。报告单列工程完整性与业务完成，pending 必须阻断完整门禁。
