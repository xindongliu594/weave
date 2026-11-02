# Core v2 验收记录

2026-10-29，本机 Node 24.15.0 / Promptfoo 0.124.1。无付费调用、生产数据、部署、Git修改操作。当前产物为七维开发回归集，公开输入与oracle，不是盲测。

## 实际结果

第三轮实际 Promptfoo CLI：**23 passed、9 failed assertions、0 errors**。9项失败断言对应9项明确pending，不是产品失败。core门禁分类：**passed=23、failed=0、pending=9、integrity=true、complete=false**，reason=`pending-evidence-required`。Promptfoo退出100，外层命令退出1；该整体命令未通过完整验收。

产品检查全部使用合成输入并真正调用现有产品函数。它们只覆盖验收输出与回执规则、词法检索/切分、交付合同依赖、内存预算、策略允许列表，不证明模型生成质量、完整混合检索、完整服务授权或真实崩溃恢复。

| 主维度 | 函数检查通过 | 待验证 | 待验证案例 |
| --- | ---: | ---: | --- |
| 结果 | 2 | 2 | result-code-live、result-office-live |
| RAG | 6 | 2 | rag-answer-faithfulness、rag-cross-identity |
| 证据 | 4 | 0 | — |
| Agent过程 | 3 | 1 | process-agent-correction |
| 稳定性 | 2 | 2 | stability-process-kill、stability-unknown-write |
| 成本 | 3 | 1 | cost-paired-baseline |
| 安全权限 | 3 | 1 | security-injection-effect |

每例包含input、oracle、requiredEvidence；pending不接受手写成功或模型结论补齐。真实模型、API/数据库、组件、浏览器均未由本轮函数检查替代。无同条件基线，不声称省Token。

## 命令与证据

1. `node --import tsx --test tests/evaluation-core.test.mjs`：最终退出0，4 tests / 4 pass。首次RED退出1（模块尚不存在）；后续三个针对性RED分别重现跨case借证据、Promptfoo注入basePath、普通pending断言自带error字段；修正后GREEN。日志在 `.private/p0-core-evaluation-20261029/{red,case-binding-red,provider-red,pending-red,final-green}.log`。
2. `node --import tsx tools/evaluations/core-v2-run.mjs --output tools/evaluations/output/core-v2-20261029-third`：退出1，实际Promptfoo退出100；分类结果如上。目录保留 `controlled-config.json`、`promptfoo.json`、原生JUnit/HTML、runner.log、manifest.json、gate.json。第一轮32 errors源于过严元数据检查；第二轮23/9/0但pending归一化失败；两轮报告保留，不计作成功。
3. `node --require ./.private/p0-core-evaluation-20261029/tmp-bootstrap.cjs --test tests/evaluation-bridge.test.mjs tests/evaluation-release-gate.test.mjs`：退出1，13/14通过，唯一失败为原CLI检查`source-changed-during-evaluation`，并行源码漂移被正确拒绝。原生直接命令先遇沙箱虚拟TEMP目录ENOENT；只在忽略的bootstrap中指定本slice临时目录，未改测试或v1实现。日志 `v1-regression-bootstrap.log`。最终稳定源码仍须root重跑。

原v1实现、五例、lock与旧测试未修改。README仅追加core-v2入口。新脚本不进入全局CI，未做全库build或typecheck。

## 第三轮版本绑定

- commit：`417b46e5510ab72203d722292e46e1e9b9322b77`，dirty=true。
- dataset v2 SHA256：`a396aeb8ef2346381310939e0dfdc33df90448d7debcd8e7ad6eb2676bd347db`。
- criteria/adapter/gate/runner SHA256：`973b936233d4dd2d182ae52eff89ba277accb4ebc3aa10984a05bca8cca6604b`。
- source rootDigest：`318d8e73d7e12807823b2be92841a7222dcfe3a5db63153c67ac658f3f3f58a8`。
- runtimeDigest：`dad4a65ac8680fa240596ea1cac6227736e12d21cc05c34acac5fd7e6aafa8e1`。
- manifest文件SHA256：`4c915170b60e6b86fdfa3843412ab2f3fe8ab0d7379312d2a1a777d168cdb5fd`。
- gate文件SHA256：`af9acc4e332d41b0164a6d2dc265ab4af4175d695673c411679cb969acd0072c`。
- raw文件SHA256：`4c48a134767e6c9fd1716df2fe8b0832ed7b8eeb6880161e7aeba9689d828ce6`。

完整lock摘要保存在manifest。rawDigest绑定解析后JSON，rawFileDigest额外记录字节；本地hash提供一致性，不是签名或对本地管理员的安全边界。后续并行修改会使本轮报告成为历史证据，root须在最终源码稳定状态重跑。独立代码审查由root安排，尚未完成。

## P2 独立审查修正：pending 原始评分冲突

审查发现此前pending特判在顶层error等于预声明原因时覆盖状态，未排除unknown status、skip/block与评分节点error；无顶层error时又可借普通fail归一化绕过评分一致性。因此上述第三轮报告现为修复前历史证据，不能当作修复后版本验收。

修复范围仅 `tools/evaluations/core-v2-gate.mjs`、`tests/evaluation-core.test.mjs` 与本文档。新增统一 `validPendingRaw`，归一化和门禁都要求原始row、response、gradingResult及唯一component结构一致；只允许缺省/`fail`状态、缺省/false的skip/block标记，拒绝provider/grade/component的error、未知/冲突status及非规范评分。合法顶层error可缺省，或必须精确等于本例PENDING原因；原生失败类型必须为断言失败1。完整验收仍保持false，v1未修改。

- RED：`node --import tsx --test tests/evaluation-core.test.mjs`，退出1。新增24类篡改各测有/无顶层error两种格式，共48组，原实现误收29组。每次都重建manifest与摘要，证明不是仅靠旧hash拒绝。日志 `.private/p0-core-evaluation-20261029/p2-pending-red.log`。
- GREEN：同一命令退出0，4 tests / 4 pass，48组冲突全部拒绝；合法有/无顶层error两种形式均接受其pending分类，complete仍false。日志 `p2-pending-green.log`。
- 必要的一次实际适配验证：`node --import tsx tools/evaluations/core-v2-run.mjs --output tools/evaluations/output/core-v2-20261029-p2-review`，外层退出1、Promptfoo退出100。实际CLI仍23 pass、9 failed assertions、0 errors；门禁正确分类23 passed / 0 failed / 9 pending。`integrity=false, complete=false`，因为并行源码变化产生`version-binding-mismatch`与`source-changed-during-evaluation`，另保留`pending-evidence-required`。这不是完整性通过报告，修复后的最终源码仍待root稳定后重跑。

未重跑v1全套、全库build或typecheck；v1最终回归及原reviewer定向复核由root安排。完整原始证据保存在上面的独占输出目录，适配日志为 `.private/p0-core-evaluation-20261029/p2-cli.log`。

P2规则SHA256：`13c70104f29c37d45ede2c533cde7e33d39c87b2572da0c5ab109a0b39ba4e40`；数据SHA256保持上述v2值。P2报告字节SHA256：manifest=`22966bc24d87a99765c68e5dbcdfc0518da8ee860da80cacc855cae23cbcc752`，raw=`da93c47e0892b78cc830d33f0da7980c56d693dcb4d1b707bfd32c3a2e80c010`，gate=`70097bc6dc7a469cdf8fcaf73a32d1cf0fe67b2b15b4c57ba56be153064af7d8`。这些摘要记录失败的完整性结果，不能用来声称最终版本通过。

## 协调者最终验证

上述“待root重跑/复核”为过程记录，现已执行完成：原reviewer对P2修正给出spec/quality PASS；最终旧v1回归14/14通过，类型检查与构建退出0。最终稳定运行目录为 `tools/evaluations/output/core-v2-20261029-parallel-final`，实际CLI仍为23 pass、9断言失败、0 errors；严格分类23 passed / 0 failed / 9 pending，`integrity=true, complete=false`，唯一门禁原因为 `pending-evidence-required`。外层退出1、Promptfoo退出100，不改记成功退出。完整实际日志、原始32例结果及版本摘要见 [批次报告与证据](p0-parallel-2026-10-29.md)。本结论只绑定本次运行源码，后续并发修改不自动继承此证据。
