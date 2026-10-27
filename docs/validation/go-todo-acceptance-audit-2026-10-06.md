**Go Todo 离线验收审计准备记录，2026-10-06**

新审计器 `docs/test-evidence/helpers/audit-go-todo-acceptance-2026-10-06.mjs` 与纯夹具 `tests/go-todo-acceptance-audit.test.mjs` 已冻结。最终本地工程验证为 **11/11，exit 0**，Node v24.19.0；开始/结束时间为 2026-10-06T02:46:50.7124494Z / 02:46:51.7505125Z。五个被测源码文件测试前后 SHA 一致，见同目录 `go-todo-acceptance-audit-2026-10-06-sourceSHA.json`；完整 spec 输出保存在 `go-todo-acceptance-audit-2026-10-06.txt`。

这份结果只验证审计器的工程判定，不是实际 MVP 验收。当前已提供的 normal archive `docs/test-evidence/go-normal-live-20261006-103332-90f0e832.json` 对应 run `90f0e832-f423-42f3-abc0-c0749a07b90f`，status 为 `unfinished`；本地仅检查结构和确认绑定。独立 QA、review、manager 完成证据及 recovery 实际 parent/child 尚未提供，因此真实功能验收仍 **blocked**。真实 provider bill 与原有未知费用保持单独 **blocked**。审计器不会把财务阻断折叠为功能通过，也不会把功能通过折叠为总体通过。

本轮未读取原目录数据库、查询费用/API、调用模型、执行员工代码、编辑员工交付文件、结算费用、重放未知外部操作或操作产品服务进程。测试完全使用内存中的合成事件、快照、金额、源码字符串和文件 SHA。只读核对的是已经保存到本工作树 `docs/test-evidence` 的 JSON。旧审计 helper 和新 Go operator 均通过受保护的入口导入纯函数，未执行它们的 CLI。旧 `audit-funded-todo-acceptance-2026-10-05.mjs` 保持 SHA `2f2bd665fd98e18d6aaffb09a817e682c31d56311c5cc6281c6237b71dba7dcb`。

冻结值如下：

| 文件 | SHA256 |
| --- | --- |
| NEW audit helper | `8600ddc051bcdd1960fa567c0edfee1603152532b54b83733f56c6fe1d670a2c` |
| NEW pure fixture test | `35b956566d3caa62aab9940c8607b49b685f1e48866e1d6b95218d4daaad8205` |
| Go operator dependency | `cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3` |
| Runtime unresolved-operation dependency | `aa2866bb3d472f8fe4db94881b3be1e9225b1866949370630dd4d14645271e79` |

审计保留旧 helper 的完整 native DAG、原生任务 attempt、真实 model wire/usage 归属、provider HTTP 成功记录、host 接受的命令/workspace revision、输入输出 SHA/producer 链、员工 `artifact_write` 内容及 LLM 来源、独立 QA/review/manager、固定 KB version/引用/权限与恢复物理重启检查。旧 Astra planner 与旧费用范围被明确替换成实际 Go 确认/代生成链和完整阶段 ledger 检查；其他旧检查失败、未完成或缺证据均转换成 blocked，不被省略。外部操作 outcome unknown 仍独立阻断功能验收。

新的 Go 检查要求完整 confirmedPlan/confirmedPolicy/requirement/project version 5、原始确认与 generation JSON 字节 SHA、原付费 receipt、public model configuration hash 和 tool capability test ID。只允许明确配置的 `fcce40cf-3172-4863-b0bd-776673f499e6` / Go gateway `ff9080ff-c61a-4449-a360-c5e0662e7c5a` / `deepseek-v4.1-flash` / chat-completions / disabled / 0.3 与 1.2；不接受旧模型 fallback、隐式 thinking、更换 task/policy/role 权限。ordered projectSignature 使用已冻结 operator 的原始 JSON hash，其他合同摘要使用 canonical SHA；两者没有相互替代。

实际只读代生成链核对结果：

| 场景 | confirmed v5 文件 SHA | source 数量 | 原付费 receipt / cost |
| --- | --- | --- | --- |
| normal | `4ba7a557f558a6724f64c10cf5a50552967222bd1e85ee8750ad79db004f5b45` | 2：cached recovery → paid generate | `f8a89329-fe9b-4ccb-972d-0b7424c3bce1` / `$0.0067287` |
| recovery | `cc79bc1c9618938fe721420196628c2535443f3f983e6e2faf699b9c9a00c6c7` | 1：paid generate | `c609903e-ab3d-4d3c-b327-b2385953c204` / `$0.0060192` |

normal 确认来源是 `go-normal-confirm-2026-10-06T01-49-58-426Z-78c51eb2.json`，recovery 确认来源是 `go-recovery-confirm-2026-10-06T02-00-20-236Z-0e2ec036.json`。两个场景都保留原正费用、原 receipt ID 与当前 model config hash `b0d6126cc6974d01d1df1a3eac88b4fb047496f7d0743b4f938a92352f9cf4a9`。缓存读不会被当作零费用生成。normal 未完成 archive 原始 SHA 为 `8ed072f6e0c742b06a598992e2ca19e771a42ed75f243dd32e930d66578ef5a0`，其中完整 saved task fields、knowledge/browser/MCP 权限、role instructions 和 wire disabled 均与真实候选相符；这不证明任何尚未完成的交付验收。

命令判定保留 literal `node --test todo.test.mjs` 与 `node --test acceptance.test.mjs`。`parseNodeTestEvidence` 同时识别 Node TAP 的 `#` 和 Node spec 的 `ℹ`，去除 ANSI 颜色后要求行内完整的 tests/pass/fail/cancelled/skipped/todo 六项计数，tests>0、pass===tests、其余为 0；缺计数、互相矛盾的摘要或被跳过的测试都会 blocked。纯夹具使用真实格式的 12/12 spec 摘要验证整个 native receipt 链，包括 output SHA。独立 acceptance 源码必须是与员工写入 SHA 相同的实际 CLI child/server.mjs/PORT=0/HTTP/cleanup 源码，仅本地审读，不在审计器中执行。

财务检查要求完整稳定的 usage/costs before/after、完整 current project contract、项目 ledger/readiness/净余额，以及两项目每个最多 $5、总新增额度 $10。原 confirmed budget 的已付费 receipt/token/归属/时间/金额均保留。所有 addedHolds 和 baselineHolds 的 ID、project/run、amount、status、purpose、providerStatus、history SHA 均与当前 raw history 对照；不能删除、归零、改成 settled 或改写历史。原 added usage/hold 不能重新划入 baseline，原 orphan 不能在 normal/recovery 之间换归属，新增收费不能冒充旧基线。旧 protected project 的批准 version/cap 也必须保留。

这包括原两笔 Astra orphan 合计 `$0.7603`、GLM 400 orphan `$0.0016958`、normal 原 Sol 502 uncertain `$0.096526` 及确认记录中的全部六笔 baseline holds。任一 open/unknown receipt 保留时，`finance-provider-bill-and-unknown-costs` 独立 blocked；SDK 按配置费率计算的 usage 不能冒充 provider bill。未来即使没有 open receipt，也需逐 receipt 的原始 verified-provider-billing JSON、request ID、model/cost 对照，才有财务通过的证据。

11 项夹具包含正向完整 normal/recovery 工程证据与反向变异：原始 SHA/201/failure/candidate/config substitution；route/thinking/policy/task/role 权限变动；任务未完成、native finish/review 缺失；不完整/冲突/spec/TAP 计数；import-only acceptance；文件 producer/SHA/员工 provenance；KB version/private 权限/来源；无 parent/无物理 exit/预算 calls 重置/checkpoint 丢失/dev 重放；删除原收费/holds、修改 status/history、篡改额度与基线归属；未知外部动作；缺证据与非本地 CLI 输入。财务负向变异逐项断言对应 predicate blocked，避免已有 bill unknown 掩盖检验缺陷。

首轮正向夹具曾为 9/10，暴露 canonical hash 与 operator ordered signature 的不一致；对齐后 10/11 的正向预算夹具暴露了遗漏 raw history，补齐真实结构。最终 11/11 通过。未降低签名、费用、命令、计数、SHA 或恢复要求；未改旧 helper/operator/source。

完成后的离线 capture 接口为 `normal`/`recovery` 两节和 `finance` 一节。场景节需包含 projectId/runId（recovery 另含 parentId）、完整 project/models/usage/readiness、final `{archive,state,downloads}`、citations；恢复还需 parent `{archive,state,downloads}` 与 restart/restartSha256。确认来源以 `confirmation:{path,sha256}` 存放；CLI 按它的原始 generationEvidence 引用链读取并重验每个 SHA，不使用调用者自行替换的候选。finance 需完整 intent、ledger、projects、usage/usageBefore、costs/costsBefore；当前 costs.calls 保留全部 raw history。providerBills 仅在有真实 verified bill 时提供 `{path,sha256}`。

CLI 只支持 `--capture=<docs/test-evidence 下的 JSON>` 和 `--output=<新的 docs/test-evidence JSON>`。路径拒绝原 `.data/local`、URL、symlink/junction 与未知参数，单份原始来源限制 50 MiB，输出以 exclusive-create 防止覆盖。缺证据/失败输出 blocked 并 exit 2。这里没有运行 CLI 对真实尚未完成的 run 出具验收报告；后续收集完整证据后再由 root 审阅并使用离线入口。
