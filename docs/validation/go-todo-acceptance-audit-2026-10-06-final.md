**Go 离线审计显式版本接口冻结，2026-10-06**

在前一版 11/11 工程证据之后，仅新增明确的版本选择接口和两项纯夹具；旧报告、txt、sourceSHA 保留。当前源码与测试已再次冻结，最终 **13/13，exit 0**，Node v24.19.0，2026-10-06T02:55:47.2901761Z 至 02:55:48.4425324Z。五个依赖源码测试前后 SHA 一致，见 `go-todo-acceptance-audit-2026-10-06-final-sourceSHA.json`，原始 spec 输出见 `go-todo-acceptance-audit-2026-10-06-final.txt`。

当前 NEW helper SHA 为 `70a884709b69c5057ec6ed577fa5e6edc0dd7186337708e252ea59e45550ca54`；NEW test SHA 为 `edf43be619ac8d63bb70d082be6dd2122195946737484ba778eee5ced6770686`。旧 audit helper `2f2bd665fd98e18d6aaffb09a817e682c31d56311c5cc6281c6237b71dba7dcb`、Go operator `cdb9e26f85dad3e25f9edf9d303365818b5004af3cf52d049d5277c5f57d52c3`、runtime unresolved-operation dependency `aa2866bb3d472f8fe4db94881b3be1e9225b1866949370630dd4d14645271e79` 保持不变。

前一版 CLI 只有 capture/output，确认与生成路径已经由 capture 明确参数化，但 expected version 固定 5。当前审计不再固定 v5，每个场景必须明确提供 `capture.normal.version` / `capture.recovery.version` 的正安全整数，或者使用 CLI 的 `--normal-version=` / `--recovery-version=`。这些 flag 只改变审计的期望版本，未修改任何已保存确认/生成请求正文、key、候选、费用或员工文件；实际 before/after confirmed version、generation baseVersion、snapshot planVersion、full project contract 仍需全部对应，错误/遗漏版本保持 blocked。

确认路径保持 `capture.<scenario>.confirmation:{path,sha256}`，generation 路径仍沿真实确认中的 `generationEvidence` / `generationEvidenceSha256` 链加载；所有文件可选择本工作树 `docs/test-evidence` 内实际 JSON，但不能用 CLI 跳过 SHA、改写源链或采用一个不同的候选。内存调用使用 `auditGoTodo(capture)`，场景节的显式 version 生效。路径无需额外硬编码，也没有自动从旧 v5 来源推断新批准版本。

CLI 形式为：

```text
node docs/test-evidence/helpers/audit-go-todo-acceptance-2026-10-06.mjs --capture=docs/test-evidence/<完整原始capture>.json --output=docs/test-evidence/<新的audit>.json --normal-version=<实际批准版> --recovery-version=<实际批准版>
```

版本 flag 可省略，但届时 capture 内必须包含明确版本。拒绝 0、负数、小数、NaN、前导零、超过安全整数与重复 flag。两个新增纯测试验证 normal v7/recovery v8 各自完整源链和 native 快照通过功能谓词；错误/遗漏版本被阻断；所有原生证据、完整 task/role/权限、wire、费用/未知 holds、恢复、KB 与外部操作要求沿用前一版。合成用例仍 financial blocked、overall blocked、actualMvpAccepted false。

实际情况已由新保存 archive 证明：v5 normal Run 最终 failed；开发真实 spec 12/12 可识别，独立 QA 未完成不能验收。v6 当前候选虽然 HTTP200/已记录新规划费，但 validation false、尚未确认，不能被新版本参数转化为成功。各 task 的精确缺口和原始 SHA 见 `go-after-truncation-estimate-2026-10-06.md/.json`。仍需后续实际 valid confirmation 与完整 normal/recovery 原生证据。功能和 provider-bill/未知费用分别保持 blocked。

后续保存的真实 normal v7 确认与直接 paid generation 已仅离线核对绑定通过：confirm `go-after-truncation-normal-confirm-2026-10-06T02-53-22-889Z-4bfc267f.json` SHA `33d48ef5c87a6344da97f50bb62a3c92841ccff8c92ae62dda04a45cf417c67f`，gen `go-after-truncation-normal-generate-2026-10-06T02-52-15-848Z-95edc690.json` SHA `81391642a354c1d8fc29a800bcc6b7a86e9dd9b4a3d2ebc1809b2a927b45368e`，source 数量 1；原正费用 receipt `d7c403a6-7857-4590-a510-fb91a7f1d341` / `$0.0064596`。其 correctionEvidence 独立记录先前已付费但无效的候选和 `$0.0012` 缺口，没有被误当成 cached generation 链或零费用记录。这只证明 v7 确认/生成来源相符；没有新的完整 Run 验收判定。

没有运行真实 audit CLI、产品 API、原库、费用查询、模型/员工命令或服务进程操作。本轮 source 更改限于 NEW audit helper 与 NEW pure fixture test，其他变更限 NEW docs。
