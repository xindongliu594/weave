**v6 生成候选的费用校验：纯离线核对，2026-10-06**

`go-after-truncation-normal-generate-2026-10-06T02-48-08-965Z-98070031.json` 的 HTTP 为 200，但 candidate.validation.valid 为 false。唯一失败项是“任务费用上限”，具体为 qa_verify 的含 20% 预留估算高于 maxBudget；所有其他校验项通过。保存前后 project version 均为 6，requirement/plan/policy 完全相同；派生 planningCost/validation 随新费用变化不代表候选已被确认。

候选原始 JSON SHA：`886e7cdffb6d6f7387a4bee6ec56094a81d427d936378c1d845d1b772292334e`。对应真实新规划 receipt 为 `dafacdb8-2286-487e-b871-4724421ab194`，input/output 8918/3186，已记录费用 `$0.0064986`。这笔已知 200/正费用应继续占用余额；本核对没有修改候选、执行确认或重放请求。

实际公式来自 `packages/contracts/index.ts:216`、`:218`：raw=(estimatedInputTokens×inputRate+estimatedOutputTokens×outputRate)/1e6；required=ceil(raw×1.2×1e6)/1e6。四项任务的负责人均使用当前 Go DeepSeek ID；费率为输入 0.30、输出 1.20 美元/百万 token。计算使用与源码相同的 JavaScript Number/Math.ceil，结果与真实 validation.estimate 一致。

| task | 累计 input/output | 单次 output 上限 / calls | raw $ | 含 20% 的 required $ | maxBudget $ | 余量/缺口 $ |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| dev | 200000 / 26000 | 10000 / 14 | 0.0912 | 0.10944 | 0.11 | +0.00056 |
| qa_verify | 300000 / 30000 | 12000 / 16 | 0.126 | 0.1512 | 0.15 | **-0.0012** |
| qa_review | 150000 / 10000 | 6000 / 10 | 0.057 | 0.0684 | 0.07 | +0.0016 |
| manager_accept | 90000 / 8000 | 6000 / 8 | 0.0366 | 0.04392 | 0.05 | +0.00608 |

累计 raw 为 `$0.3108`，全任务含 20% 估算为 `$0.37296`，四项 maxBudget 总和为 `$0.38`。全局总和足够不能替代逐任务门禁，qa_verify 仍不足 `$0.0012`。这里 `$0.1512` 只是此份累计 token 估算的校验阈值，真实重试余量需由后续 AI 规划结合实际上下文和调用历史重新分配。没有把未保存的 JSON 手改为可通过值。

maxOutputTokens 是单次 wire 输出上限，estimatedOutputTokens 是任务累计输出估算；本 validatePlan 公式没有再乘 maxModelCalls。`apps/api/src/app.ts:332` 使用扣除本次规划费用后的 availableBudget 做“预估执行费用”校验。生成前 quote 为 recorded `$0.366872`、uncertain hold `$0.096526`、net `$3.716302`；扣除该规划费用后推导 net 为 `$3.7098034`，故真实“预估执行费用”检查通过。这里没有改变原 `$4.1797` 项目 cap 或清理未知 hold。

失败的 v5 normal archive `go-normal-failed-20261006-104010-90f0e832.json` SHA 为 `97eea22dd3cb0ded07d31a0f3f0e50380cfa5b7972e7dfa9e2530fbdffd3c52f`，run `90f0e832-f423-42f3-abc0-c0749a07b90f` 的最终 status 为 failed。离线读取其中原生 `node --test todo.test.mjs` resultSeq 2456，exit 0，spec 摘要 tests/pass=12/12，fail/cancelled/skipped/todo=0，原始 output SHA `0031dfd2853c25c971bf739c2cf295de9a6f130f1ccc5d80452045ad59e3bc36`。`parseNodeTestEvidence` 已识别该真实 spec 输出；开发通过不能替代 QA、review、manager 或整 run 的成功。

机器记录 `go-after-truncation-estimate-2026-10-06.json` 保留原 candidate/failed archive SHA、逐 task 精确计算、真实 receipt、quote 原值、Node 摘要及只读源码 SHA。源码 SHA 为 contracts `a77639df16b4e1865222d872d8b1a487bab19a1b0390ac5fe9e4162543faf468`、app `75b14eb09723d05a6cc42b4c42840c30f9d07b838137e8b6e3bea3d3155ac331`、project-planning `f9c64acca728d53bd5877b97334c91afc36561ec1bd44aa63abc03807c1c172c`、cost-control `79ffbb8778b894eb915bf208de7ef3e448dbfd433051a3a54020297d32144456`。

整个核对仅读取保存证据和源码；无 API、费用查询、原库读取、模型调用、员工文件/代码执行或产品进程动作。
