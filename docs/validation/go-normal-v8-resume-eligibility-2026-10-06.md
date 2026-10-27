同 v8 恢复从本地档案看具备跳过 dev、qa_verify 的资格；真正的恢复准入仍须在 runtime 修复后由产品检查。未执行任何 API、DB、模型、provider、恢复操作或员工文件读写，也未改 DAG、任何源码或冻结 helper。

档案 `docs/test-evidence/go-normal-v8-review-abort-20261006-122118.json` SHA256 372df14c5430594c6197fc9f26f316ef217f6a62001ce3817b3582e6df9e5889，Run `0947ae05-5c3c-47d0-969b-5c8a739118f1`，project `4938eab8-26ed-4f60-9413-d979f05fa968`，v8，failed，integrity=ok，3133 events 连续完整。

`completedTasks` 返回恰好 dev、qa_verify。dev completed attempt `847386dd-94e0-485d-9ab8-b332981ae06c` 与 seq1797 宿主 accepted 对应；qa_verify completed attempt `2c0dd0e0-1e18-4786-b889-3bc14d497235` 与 seq2994 accepted 对应。dev 最终测试7/7 exit0（较早6/7 exit1历史仍保留）；独立 QA 的两条测试均7/7 exit0、完整 output SHA 和实际审批/native operation 身份均在 seal。qa_review failed，manager_accept pending，二者不能跳过。

四个输出的 accepted SHA/size 均与最后 seq2932 artifact manifest 相同；纯 `taskContractErrors(snapshot.tasks,snapshot.agents,seals)` 返回 []。实际 v8 headroom Go HTTP200 confirm→gen 与档案完整策略、任务合同、员工及 route 经 `assertGoApprovedRun` 验证通过。读取真实磁盘文件被本轮范围禁止，因此没有调用会 inspectArtifact 的 `resumeHandoff`；实际准入仍要核对磁盘 SHA。档案匹配不能替代当前 fileVersions 检查。

| 文件 | accepted / 最后 archived SHA256 |
| --- | --- |
| server.mjs | 088dca7377c931f45881fe5f3e06a19c50192c1d6847c96576c94514eba12630 |
| todo.test.mjs | 53fa4d170b0c1efe7181b104345cfe5cf50e759b624ca9ddde6a66bff933aa3b |
| README.md | 776e688a8c76c97b95659f162e77a5ca34781d44cfd53601f9d96a40bdca838a |
| acceptance.test.mjs | 71677ecd31d4ad927921f4af7067649c7d3bb05d3e72e52c2a2eb1d7d59d3954 |

真实 sourceCheckpoint 为 seq3132：available、currentAtSourceEnd=true、后续 accounting=0。宿主项目 limit4.1797、occupied0.944673、activeReserved0、available3.235027、reserved-attempt calls24/100。入场旧 unknown hold0.096526、recorded0.6295451 仍保留；sourceAdmission.callsUsed=null 表示未封存历史，不能当0。

23 条实际 wire 全部各有一条 settled billing，独立 usage ID23，本 Run 确认费用0.2186019。dev10 wires/0.0991872，qa_verify8 wires/0.0968457，captain未归任务5 wires/0.022569。最后晚到的 usage `8e1cb3bc-5e80-4311-a6c5-c2c11f261db3` 在 seq3124，费用0.006126；seq3126 settling pending0，均先于 seq3132，因此没有漏掉晚到费用。此处是已存 archive 的真实回执推导，并非当前 DB ledger 实查。

宿主 calls24 与 wire23 不可混写为同一计数。review seq3110 发起一次 model/request，seq3115 `aac77ca0-f367-4a9c-8b4c-b4c3971ecfe6` 明确 dispatched:false/CALL_INTERRUPTED，无 wire。读取时 budget-history 仅数 wire，因此若同v8只有此父 Run，旧恢复历史会为23，不能声称封存宿主24全部保留。root 已明确自行修 apps/api/src/budget-history.ts，保守继承实际 model/request attempt；费用、unknown 和已有 hold 不归零。本报告不修改该文件，也不宣称修复已通过。

`unresolvedOperations(events)` 返回 []，表示 durable supervised 修改操作 unknown0。另有四条历史 local/operation-queued 没有 local/operation-finished：prepare seq5 以及 dev 的三次 filesystem seq122/132/143。这不能推导当前 device queue 或所有 native operation pending0，本轮没有 fresh local-ops/DB 读取。宿主 activeReserved0 也不能代表 native SDK budget hold0；native SDK/current DB hold 仍未独立验证。

读取的恢复路径保持原 approvedTasks；完成 attempt、宿主 seals、recovery.files 的 SHA 和 sourceBudgetEvidence 进入 child snapshot。staged restore 会将这两个 native 节点置 completed，然后启动剩余节点。真实 project cost-readiness 与同版本 task cost/call/hold 历史在准入时重新读取，不从模型文字估算。必须使用 resume:true、acknowledgeUnknownOperations:false，保留当前实际未知费用选择；不能用 full retry 重跑 dev/QA。当前 ledger、磁盘、no-child、模型/授权及 runtime 修复成功都尚未在本报告证明。

供 root 后续实际检查通过后使用的参数，未执行：

```text
node docs/test-evidence/helpers/operate-go-funded-run-web-2026-10-06.mjs resume --scenario=normal --normal-project-id=4938eab8-26ed-4f60-9413-d979f05fa968 --recovery-project-id=3e101c24-87e6-43ea-80f9-a2c4b0b410f4 --version=8 --run-id=0947ae05-5c3c-47d0-969b-5c8a739118f1 --confirmed-evidence=docs/test-evidence/go-headroom-normal-confirm-2026-10-06T03-52-30-038Z-bb3feede.json --generation-evidence=docs/test-evidence/go-headroom-normal-generate-2026-10-06T03-48-40-049Z-2bff7270.json --go-model-id=fcce40cf-3172-4863-b0bd-776673f499e6 --retain-uncertain-costs=true
```

显式 true 以目前档案保留的0.096526未知 receipt 为依据；若实际 fresh ledger 已无 unknown，现有 helper 会拒绝 stale true，root 应按真实状态调整选择。恢复后须核 child.resumedFrom=上述 parent、v8、completedCheckpoints 恰好 dev/qa_verify、完整对应 handoff seals 与恢复文件 SHA，并核继承费用/hold/保守24次attempt口径。此时仍不能提前声明 review/经理成功。

完整数值、actual proof path/hash、命令 output hashes、queued身份及读取时 source SHA 在同名 .json；纯本地审计输出在 .txt。source hashes 记录本次读取基线；root/另一 agent 正在修复它们，不能当作其修复后的冻结 SHA。NEW KV/stop/operator 均未修改。
