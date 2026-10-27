# 显式目标的大档案与受控停止工具

当前 NEW 工具以真实 Go 确认、生成来源、首次批准回执和原字节 SHA 绑定未来 Run，不依赖历史 c929 身份。只有验证后的显式目标 `/runs/ID` 和 `/runs/ID/export` 使用 128 MiB；binary 仍为 5 MiB，其他 JSON 为 50 MiB。完整停止/知识更新帧最多 256 MiB，并核对父 Run、项目、部门、版本及原件 SHA。没有删除事件或缩减档案。

首次批准省略 `budgetHistory` 只在同项目、同版本、唯一首次 project 批准的完整证据成立时沿用原构建的 0 继承语义。完整 registration、wire、usage、finish 与宿主 checkpoint 计数仍需一致；36 request / 34 wire 的缺口不能由 wire 数掩盖。已知 ENOENT 仅允许三份当前已验收开发产物首次写入前的精确 default read 失败；其他 failed/active/late/unknown 仍拒绝。真实 operation 状态和 snapshot 不被改写。

路由 barrier 会等待拦截中的 fresh preflight 完成，响应计时在转发前才开始，关闭 browser 前等待活动 guard 结束。永久 `wx` 意图与单请求门仍保留；未知已转发结果不得重放。历史 c929 已因原 3600 秒期限失败，所有 0POST proof 和旧意图保持原件；该失败不算受控停止，未来停止 CLI 明确拒绝 c929。

可执行 NEW 入口（仅由 root 后续按实际授权调用）：

- [未来首次父 Run 停止](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/stop-go-funded-run-first-parent-web-2026-10-06.mjs)：原 `--run-id`、`--command-id`、`--version`、`--confirmed-evidence`、`--generation-evidence`，另外必须填写 `--initial-approval-evidence=ACTUAL.json`、`--initial-approval-sha256=EXACT_SHA`；需要大档案时填写 `--large-run-id=同一Run`。
- [首次 v1→v2 知识更新](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/upgrade-go-funded-knowledge-first-parent-web-2026-10-06.mjs)：保留 `update-v2` 及原显式 Run/version/confirm/generate/setup/stop 参数，首次批准来源从实际 stop report 读取并重新核验。原版本、PIN、授权、费用和更新前后条件保留。
- [最终 capture](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/capture-go-acceptance-final-scope-referenced-explicit-target-2026-10-06.mjs)：保留原参数；可额外填写同长度的 `--large-run-ids=ID[,ID]`、`--large-run-approved-evidence=PATH[,PATH]`、`--large-run-approved-sha256=SHA[,SHA]`，最多三个实际正常 final / 恢复 parent / 恢复 final。parent 用实际 approve 来源，child 用实际 resume 来源。缺一、外 Run 或错误来源均拒绝。
- [最终离线 audit](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/helpers/audit-go-todo-acceptance-final-scope-referenced-explicit-target-2026-10-06.mjs)：原离线 capture/output 参数不变，重新核验目标原件及全部原预算、运行、错误、重启、知识与财务条件。

同一生成原件的绝对/相对路径拼写按实际路径比较；SHA、费用、model、requirement、plan、policy 等全部签名字段仍逐字段严格一致。正常明确无知识授权的例外只作用于原知识检查及两 capture gaps，恢复不跳过；恢复 v1 固定/v2 当前、同 marker QA 私有正向检索与开发空检索、恢复后真实 read/citation 仍要求原件。未知 provider/费用继续 blocked，缺真实恢复/知识证据不会成为验收通过。

本地验证为 89 项主回归、9 项补充回归（6 项重复，92 项独立测试通过，0 fail/skip）及 9 项 syntax。真实隔离 msedge browser 的 preflight 为 25,395 ms，21 秒时尚未转发且 browser 未关闭，最终只有 1 次转发和 202；未知结果拒绝重放和替换永久意图。所有 URL 由测试 route fulfill/abort，没有连接产品或模型。另核对原 90,161,693 字节 0POST preflight 帧全量 SHA，并用完整 51 MiB synthetic archive 验证 128 bound、原 Go 来源、污染拒绝和真实 capture stream reader；测试资料标为 engineering，未冒充实际 Run 通过。

完整记录：

- [当前来源 SHA、原件稳定性和浏览器结果](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-explicit-target-final-scope-sourceSHA-2026-10-06.json)
- [89 项真实执行日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-explicit-target-final-scope-tests-2026-10-06.txt)
- [9 项补充与 syntax 日志](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/test-evidence/go-explicit-target-final-scope-supplement-tests-2026-10-06.txt)

原 audit/capture/references/operator/stop/upgrade、原 13 项审计测试及本次 `ff689045…` operator SHA 全部稳定。没有真实 API、模型、数据库、员工文件或服务操作；此工具准备完成不表示实际 MVP 验收完成。
