# Go normal v10：首个离线与失败实证（2026-10-06）

**本轮失败，不晋升完整 normal 验收。** Run `17af4ec6-379e-47bc-9b6b-0afd16d49869`，项目 `4938eab8-26ed-4f60-9413-d979f05fa968`，版本10。完整原字节 archive 为3047连续事件、integrity=ok，最终 seq3047 明确 failed / 本机设备离线。

原始6项GET均HTTP200，保存于 [raw sources](../test-evidence/go-normal-v10-failed-2026-10-06T06-57-16-610Z-e635bdb4/sources.json)。archive 37933017 bytes，SHA `c5bb7ae427f34bdcde86373dcefdf1604f52dea38b02442d193cc4239f978d49`；state/local-operations/artifacts/cost-readiness/usage 均为HTTP原字节，无PowerShell JSON往返。四份已生成员工文件下载副本与manifest逐byte SHA/size一致，见 [artifact sources](../test-evidence/go-normal-v10-failed-2026-10-06T06-57-16-610Z-e635bdb4/artifact-sources.json)。未改原工作区、未执行员工代码。

## 首失败与实际阶段

- 首个 runtime/operation-failed 是 seq97，开发 filesystem 读取 `.`，UNDECLARED_INPUT / blocked。它不是本机离线；开发随后通过验收。
- 首个 LOCAL_DEVICE_OFFLINE 是 seq2379（06:47:10.863Z），QA复审 filesystem 读取 `server.mjs`，call `call_01_bl29qz3fac5ink2h4i1frx3j`，session `79593ee8-1bde-4a77-a094-8bfdc05ef0bc`。
- 该调用仅有 session/tool/call seq2369、tool/start seq2370、operation-failed seq2379、tool/result seq2381；没有匹配 local queued/finished，也没有当前local-operations行。claimed/started不能凭缺失字段编成false/0。root已定位前置filesystem软心跳判断，具体根因由runtime代理源码审核。
- seq2380 对 QA attempt `b8f15cae-4628-41a1-91c3-b550c29ab71d` 记录 handoff/blocked，但其后 QA复审确在 seq2996 accepted/pass。此前“sticky QA”临时推测被原帧结果否定。
- manager_accept attempt `361b214d-e76f-403b-ade1-78c88375433e` 最终 failed，没有经理模型wire、员工本机操作或 acceptance-report.md。不能把“没有wire”说成从未启动attempt。

## 五条真实测试

| 节点/命令 | 实际结果 | 完整输出bytes/SHA-256 |
| --- | --- | --- |
| dev / todo.test.mjs | 6/6，exit0 | 613 / `932da245a4c80f6efa95494f28a30d50f3cefb9d46f329ca891aaa509104d1da` |
| qa_verify / todo.test.mjs | 6/6，exit0 | 611 / `c065ad74e8b2580c3fa6b7af5e70e85adbabd12a141cf3d0a41304682a484e32` |
| qa_verify / acceptance.test.mjs | 4/4，exit0 | 483 / `c4754253a2c0a9977e6a78be04601e3fb014ad73faa7fab6340942f9fe986b2a` |
| qa_review / todo.test.mjs | 6/6，exit0 | 612 / `59f8ce99fd21e06bae37524918f444a479ca0303b505e1fc8a8311a6cf253ee7` |
| qa_review / acceptance.test.mjs | 4/4，exit0 | 483 / `079d910d8a4fe262c9f8b45fd446386ba78771435b1c4a02fe9a93b5cba42209` |

全部是 completed + started=true + result.exitCode=0 + lateResult=null。从原combined输出重解析spec统计并重算完整UTF-8 SHA通过。本版不是v9 terminal误取消/晚回0。五个不同审批UUID均网页唯一1POST/HTTP200，没有盲重放。开发三文件SHA在QA写独立验收、QA复审后保持一致。

两份员工测试均使用 global fetch，业务URL来自真实 Node子进程 stdout 的 `http://127.0.0.1:<实际PORT=0端口>`；QA配置请求timeout。没有外部/provider请求路径。此项仅只读代码I/O审核，没有Codex运行员工测试。

## 费用与两种失败分别记录

- AI规划唯一1轮，generate200/valid=true，fee0.0072444、receipt `8d005a44-6159-407c-ba77-37429c43c3d9`。同key/body cached确认200/2POST，保存9→10，无新增usage。所有角色为Go DeepSeek，原4任务、权限和policy4.1797保持。
- 当前Run34条wire/34个唯一settled usage，合计约 **0.3499593**；dev9、qa_verify9、qa_review8、captain8，经理wire0。
- 最终宿主 checkpoint3046 **callsUsed36**，与34 wires的差额保留；seq3037另有 `e42313c3-2248-4af7-9abb-46c29ad8ffe8` dispatched:false / CALL_INTERRUPTED。没有直接读reservation表，不把差额额度或旧未知费估零。
- 保存readiness：recorded **1.6647368**、未知预留 **0.096526**、available **2.4184372**、pending0/uncertain1；旧receipt仍uncertain。最终native unknownOperations=[]，sourceEnd无后续accounting，activeReserved0。
- 第五次批准 d515…cc56 的helper最终只读观测失败（[原proof](../test-evidence/funded-run-web-normal-command-2026-10-06T06-52-24-306Z-fb280e44.json)，SHA `fb3bff37abecb4e1180abd09cfcbf5d2f56936f6b0801bf70010c15d4cae9336`）。POST200和后续同审批GET200已确认；finally最后只封存usage/projects200，未封存失败HTTP码或after费用帧。
- 该helper观测失败没有被用来推断Run失败。Run失败由之后root授权的独立完整raw export明确证实；d515实际terminal结果也已独立证实为正常completed/exit0。

所有历史意图、v9 lateResult、五次批准和观测失败保留；失败后没有新approve/resume/generate/cancel，不恢复、不重放、不改预算/原库/Key/员工产物，也未调用只能用于completed的delivery inspector。完整raw目录已交 responses_runtime 根因审阅。

来源SHA、call/session/attempt/queue阶段和预算证据详见 [同名JSON](go-normal-v10-first-offline-2026-10-06.json)。
