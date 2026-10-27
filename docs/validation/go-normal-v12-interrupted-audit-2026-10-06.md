# 正常 v12 中断的独立只读审核

**开发与 QA 检查点、四文件和真实回执可恢复；完整恢复准入尚未证明。** Run `566c813d-6fc9-409a-b945-ec9d5afea4fe`、正常项目 `4938eab8-26ed-4f60-9413-d979f05fa968`、版本 12 的原 Go 生成/确认/单次 202 批准链通过本地纯校验。复审首轮发生 `LEASE_LOST`，经理未完成；本 Run 不能算 fresh normal 成功，也不是受控停止/重启路径。

18 份保存来源逐项大小/SHA 一致。完整 archive 与 archive-after 均为 31,604,398 字节、2867 连续事件、integrity=ok，SHA `aee0d4ab736dcb63e463d532b70782756fd2d57a1545e23d7fef79e7af366a2f`。原创建 snapshot SHA 与完整 state snapshot 一致。state 的公开状态为 interrupted；archive 末事件为 cancelled，两者如实保留。

| 原节点 | accepted / attempt | 已核验范围 |
| --- | --- | --- |
| dev | seq 726；`c839ed4a-07cd-4473-b3c9-666c7563b088` | 三文件由同一开发 native artifact_write 写入；下载字节、manifest、seal 一致。真实 todo 9/9、exit0。 |
| qa_verify | seq 2720；`78a7f09a-98cc-4c87-9755-692dbba8aea3` | inputs 逐项等于 dev seal 且 producer=dev；仅写自己的 acceptance.test.mjs。最终两命令在同一完整工作区版本上通过。acceptedAt 为 11:03:59.053Z，事件时间为 11:04:00.632Z。 |
| qa_review / manager_accept | 未 accepted | review 首轮失败，manager pending；不存在完整交付或经理报告。 |

| 文件 | bytes | 原 SHA256 |
| --- | ---: | --- |
| server.mjs | 6970 | `73be51c504558414f06b8176b240861eedf3b4bbba785ffce0b0744804b3f91f` |
| todo.test.mjs | 6928 | `d9c459ed56ab16765908c7e03ae5becbd6d4f023ad9afb7fbcd3be947a30b1c1` |
| README.md | 4083 | `2f71672418bfd98eca3433bedd683c477c4122da30c341a2794a5dfc03b6e174` |
| acceptance.test.mjs | 16377 | `7a8ee9a982310926b612b72db6a4c5989f335d7719f39f96ddf1bebf9a081dde` |

原始本机结果重新解析完整 Node 统计并重算 combined 输出 SHA，均与 accepted evidence 完全一致。每条命令核对了批准正文与 native arguments、session/call/task/attempt/approval/operation 身份、queued→finished→observation→accepted 顺序；stdout/stderr 独立流仍为 unknown。

| 命令/阶段 | queued→finished→observed→accepted | 实际结果 |
| --- | --- | --- |
| dev todo | 614→623→625→726 | tests9/pass9、exit0 |
| QA 首次 todo | 1452→1462→1464→2720 | 9/9、exit0；旧测试文件 revision，只作历史回执 |
| QA 首次 acceptance | 1731→1754→1756→2720 | tests11/pass10/fail1、exit1；失败保留，不计最终通过 |
| QA 最终 acceptance | 2306→2322→2324→2720 | 11/11、exit0；最终 revision `22c863fd…08ff` |
| QA 最终 todo | 2641→2658→2660→2720 | 9/9、exit0；同最终 revision |

复审原 request seq2840、requestId `2a3e4dff-5779-4098-99fb-5da8f283e048`，seq2848 首个 finish 为 `LEASE_LOST`；同 request 没有 wire 或 billing 事件。seq2856 记录服务租约过期、interrupted，seq2861 captain aborted，seq2866 保留最终宿主预算，seq2867 cancelled。没有把该末 cancelled 改称用户受控停止，也没有将 README 命令推作租约丢失根因。

预算核对：本 Run 26 registered requests，25 unique wire 与 usage 逐项对应；新增本地登记费用 `$0.233466`。dev 为 9 次、QA 11 次、captain 5 次，review 另占 1 次未 wire 的宿主额度。最终 checkpoint seq2866 为 calls26/limit100，后续 accounting=0；应保留至少 26 次及 review 1 次，不能按 wire25 重置。继承 recorded `$1.765031` 加原 unknown `$0.096526`、本次 `$0.233466` 等于 occupied `$2.095023`，cap `$4.17970`、available `$2.084677`。activeReserved 原浮点值 `1.3877787807814457e-17` 保留；pending0、旧 uncertain1 保留。snapshot 中未封存的 inherited calls 为 null，未推定零。金额是本地配置单价记录，不等于供应方账单。

在捕获副本上调用原 `completedTasks` / `resumeHandoff` 纯门通过，返回与原 dev/QA 两条完整 seal 逐字相等的检查点。所有本机 operation 均 completed/started、lateResult=null；公开 unknownOperations 与完整事件重新推导均为 0，待审批为 0。上述证明保存时的文件和检查点具备恢复基础，不授权直接重复命令或重做已完成节点。

尚欠恢复准入证据：实际 durable admission/history 或 recovery-conditions 必须保留 total26 和 review1；本批没有 reservation 行，不能从 usage25 推断第26次持久计数。原 `budget-history.ts` 使用 max(admission rows, wire)，所以需要核对真实 admission 归属，而非假定 host26 自动进入该结果。还需 root 在后续实际准入核对当前授权/模型/设备、每日与阶段费用门、无竞争 Run/child，并处理租约失败。保留 unknown 的选择仍需显式 true，旧预留不得清零。此审核不打开数据库，也不代替这些当前条件。

README 第60行为 `Get-Process node | Stop-Process`，第59行声称只停止本 session。该命令没有 session 或 Todo PID 过滤，会尝试停止可见且有权停止的所有 node 进程，可能包含工作台/API；不能推荐为仅停止 Todo 的步骤。原文同时已有“在运行 Todo 的 PowerShell 窗口 Ctrl+C”这一明确选项。QA 原输出披露未实际演练 Ctrl+C/broad kill；保存的五条 native terminal 命令全部为合同中的 Node 测试，没有 broad kill 执行证据。原文件与 SHA 未改。后续只读复审应如实指出此文档问题；如需修复，必须经员工获授权的方案/文件合同处理，不能静默改已 accepted 文件。

全部来源、精确身份链、原输出 SHA、调用与预算事实保存在 [机器审核](C:/Users/JJ/.codex/worktrees/f57c/agent_department/docs/validation/go-normal-v12-interrupted-audit-2026-10-06.json)，SHA `63de50669f00b106d884176de6a5a7b5685728114c4c66c96c8e16a1a927a4a6`。只写这份 NEW md/json；真实 API、模型、数据库、服务动作、原员工目录读取或命令执行、源码/共享进度/主报告修改均为 0。完整 MVP 仍 blocked。
