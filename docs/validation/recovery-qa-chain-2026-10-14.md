# 恢复、资源规划与 QA 交接联合修复

日期：2026-10-14。真实原运行：`f89af7d2-300f-4557-ae90-c229a2027fdf`；项目：`02428911-26c3-47cc-84c2-7db1ee7c2b5d`，方案 v3。

## 本轮范围与真实状态

本报告记录 `4b6294c` 的离线修复与首次发布阶段，当时没有发送真实模型请求。随后用户另行批准一次续验：真实规划成功、QA完成3次请求，末次交接因上下文门禁停止，经理未开始，详见 [真实续验报告](recovery-qa-real-2026-10-14.md)。没有补写员工交付或 QA/经理结论，不能把本报告中的脚本模型测试当作真实验收。

累计美元授权仍为 $2.80，权限、旧用量及未知费用保持。离线阶段未自动追加调用；后续明确授权的真实续验已验证 Go JSON 规划可用，但未完成 QA/经理验收。

## 根因与修复

1. 资源规划原先只通过提示词要求 JSON，模型可返回 Schema 或套一层对象，导致付费后校验失败。复用已有 `response_format` 通道，已知 DeepSeek/GPT 路线使用 JSON object 模式，提示明确返回实例；服务器继续严格校验。格式错误或供应商拒绝后记录原收据，不自动发第二次付费请求。
2. 输出扩大后，AI 缺少各个输出长度对应的程序计价。复用已有输出快照与费用预留函数提供可选报价，AI 选择额度，确认时再次校验；已完成任务不改动。
3. “本次最多新增若干请求”此前未成为独立运行时门禁。增加可选的 `taskContinuationLimits`，确认时绑定真实累计历史，封存绝对 `taskCallCeilings`。原预算门禁同时检查原累计上限与封存上限，普通恢复不重新加次数。未显式填写时兼容旧行为，不把所有任务限制为 7 次。
4. 后续授权保留已完成节点的旧限制；已有上限耗尽时在付费规划前拒绝；显式新增超过 7 次时，规划所需累计上限覆盖完整授权。
5. 网页复用现有“检查恢复条件”和“AI 调整续跑额度”：可给所有未完成节点填写本段新增次数，候选展示新增与累计上限。仍须确认候选后才启动员工。

没有引入新依赖或替换 DSH、数据库、沙箱、知识库；复用现有 Zod、GoalContract、ExecutionBudget 和收据链路。调研来源和实施范围见 [计划](../superpowers/plans/2026-10-14-recovery-qa-chain.md)。

## 验证记录

| 环境 / 检查 | 结果 | 证据 |
| --- | --- | --- |
| Windows 相关单元与原生运行时 | 106/106 | [完整输出](recovery-tranche-unit-native-2026-10-14.txt) |
| Windows 恢复 API / 网页组件 | 31/31、7/7 | [API](recovery-tranche-api-2026-10-14.txt)、[网页](recovery-tranche-web-2026-10-14.txt) |
| Windows 类型及构建 | 退出0，保留既有大于500KB的构建提醒 | [构建](recovery-tranche-build-2026-10-14.txt) |
| JJ 最终单元、网页与来源链 | 48/48 | [unit](evidence/recovery-qa-chain-2026-10-14/unit.txt) |
| JJ 最终隔离恢复 API | 31/31 | [integration](evidence/recovery-qa-chain-2026-10-14/integration.txt) |
| JJ 完整产品流程（含正常完成、两次中断恢复及资源续跑） | 19/19 | [combined](evidence/recovery-qa-chain-2026-10-14/combined.txt) |
| JJ 原生预算、恢复、输出与交接 | 33/33 | [native](evidence/recovery-qa-chain-2026-10-14/native.txt) |
| JJ 类型及生产构建 | 退出0 | [准备结果](evidence/recovery-qa-chain-2026-10-14/prepared.json)、[build](evidence/recovery-qa-chain-2026-10-14/build.txt) |

JJ最终四组共131项，通过后才切换服务。Windows/JJ有相同测试，不把它们相加冒充独立覆盖。Windows早期类型输出是测试夹具联合类型错误，修正后完整构建已通过；早期名为 `quote-green` 的文件记录舍入断言失败，不是最终通过证据。RED与诊断原文均保留。

重现命令：

```text
node --import tsx --test tests/recovery-resource-plan.test.ts tests/planning-output.test.ts tests/run-resource-resume.test.ts
node scripts/test-integration.mjs tests/recovery-conditions.test.ts
node scripts/test-integration.mjs tests/product-flow.test.ts
node --test services/agent-runtime/budget.test.mjs services/agent-runtime/run-evidence-native.test.mjs services/agent-runtime/task-plan-context.test.mjs services/agent-runtime/task-output-limit-native.test.mjs services/agent-runtime/checkpoint-context.test.mjs services/agent-runtime/employee-handoff-reminder.test.mjs
npm run build
```

独立审查提出3项授权边界问题，修正并通过对应回归后窄读复核通过。无新增依赖、数据库迁移或权限。

联合场景实际启动隔离 API、PGlite 与 DSH runtime：开发节点完成后，中断已发送的 QA 请求，保留未知费用，再冷重建服务；资源候选→明确确认→新运行；QA 检索/读取固定知识 v1（当前文档已更新 v2）并完成正式交接；经理在交接封存后才开始，收到匹配的文件、命令回执与审批证据。开发不重跑，文件 SHA、历史调用和未知预留保持。模型回复来自 localhost 脚本，仅用于软件工程验证。

运行时预算回归覆盖 QA 历史44加4、经理历史0加7、经理第8次请求在发送前拒绝；经理历史6恢复只余1；省略授权不重置；非法字段拒绝。API 回归检查候选、确认、只读检查与实际续跑拒绝相符。

JJ 完整流程初验发现夹具的 QA 实际需要 **7 次执行 + 1 次上下文整理**，将其限定7次会在测试命令前被最后一次交接门禁停止；设为8次后，末次交接触发 `CONTEXT_LIMIT`。后续代码追踪纠正了最初“16K模型窗口”的解释：这条路径检查的是完整请求字节门禁，交接时恢复了重复的宿主状态快照。两次失败保留，均不算 QA 通过。首次发布的完成场景保留原夹具任务累计12次，显式授权对应新增11次（历史1次），经理新增7次，并记录真实耗用；它没有覆盖恰好在最后一次调用交接的失败路径。后续修复必须补足该路径，不能用较高的测试次数替代。真实项目 QA4/经理7/总72的授权保持。按用途记录见 [原夹具收据](recovery-tranche-joint-original-receipts-2026-10-14.json)。调度及上下文整理调用也消耗项目次数，不能仅数工作步骤。

真实数据只读预演读取10份来源运行，规划请求保守预留 $0.0029853，低于原 $0.003；QA4/经理7、8192输出的下一段费用下限加规划预留为 $0.55882891，低于允许的 $0.56。预演没有推理请求或生产写入，不能保证任务在这些次数内完成。[预演结果](evidence/recovery-qa-chain-2026-10-14/planning-preflight.json)

原产品流程中的旧断言也曾失败；在 HEAD 对照中确认它仍期待旧 `TASK_TURN_LIMIT`，当前运行时已采用最后一次 `HANDOFF_ONLY` 正式交接。测试按现行行为校正，仍检查8次总调用、完整重试拒绝、旧记录保留及没有新增运行。未削弱生产门禁。

## 使用入口

停止的运行页面 → 检查恢复条件 → AI 调整续跑额度。按实际允许金额/累计次数/输出长度填写；需要限定本轮续验时展开“限制本段新增调用（可选）”，填写全部未完成节点。生成候选自身有模型费用；核对候选后再确认恢复。普通恢复沿用已批准上限，刷新页面或重启服务不会增加次数。

## JJ 发布及原始数据

北京时间2026-10-14 09:44完成切换。当前目录 `/home/jj/.local/share/weiwu/releases/weiwu-recovery-qa-chain-v2-20261014`；旧生产目录 `weiwu-recovery-output-compact-20261013` 保留，可用已备份的用户服务配置回滚。新包SHA256：`011084b4d7b7a3e86e3131d4227977ef4cf1264c40c1b77dbe4d6931ad3eacaa`；[逐文件清单](evidence/recovery-qa-chain-2026-10-14/manifest.json)。

发布前检查无进行中运行/调用，发布后健康接口连通。45份列表运行、525条用量、全部费用预留、原运行导出和交付SHA前后相同；账面累计占用仍 $2.4751467。本轮新增真实模型调用与费用均为0。[发布核对](evidence/recovery-qa-chain-2026-10-14/deployment.json)

## 尚未验证

- 真实 QA 和经理通过（后续一次 Go 资源规划已通过，QA/经理结果见上述真实报告）。
- 新增网页输入的实际浏览器操作（本轮已做组件渲染与参数回归）。
- 本轮没有重做 OpenShell/Docker 隔离、完整备份恢复等更大验收；历史证据独立保留。

已有交付 `inventory-cases.md` 的 SHA256：`57f22107eb69a4851d0cc0f4cded066937d78dca6c204dfa4d685505d293842f`。
