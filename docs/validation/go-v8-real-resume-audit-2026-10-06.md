# Go 正常 v8 真实同版续跑审核（2026-10-06）

结论：**同版续跑成功，保留员工报告措辞与测试强度限制**。父 Run 的非受控 runtime 故障修复后，子 Run 完成原 v8 DAG。此证据不代表从头不中断的 normal，也不代表 recovery v7 受控中断、知识升级或备份恢复。

本次只读取已保存证据与相关纯校验代码。真实 API/HTTP 请求、数据库直接打开、模型调用、原员工工作区文件读取、员工命令执行、源码及员工报告修改均为 0。金额是保存批次的费用帧，后续项目活动不在审核范围。

## 实际绑定与来源

- 项目 `4938eab8-26ed-4f60-9413-d979f05fa968`，版本 **8**。
- 父 Run `0947ae05-5c3c-47d0-969b-5c8a739118f1`：failed，3133 连续事件。
- 子 Run `f0f68b82-eeaf-493f-9f54-c932504e430a`：completed，1548 连续事件，integrity=ok。state 只含前 300 条且 hasMore=true；审核使用完整 archive。
- [实际 v8 确认](../test-evidence/go-headroom-normal-confirm-2026-10-06T03-52-30-038Z-bb3feede.json) 与 [实际生成](../test-evidence/go-headroom-normal-generate-2026-10-06T03-48-40-049Z-2bff7270.json) 的 Go binding 校验通过，父子完整方案、策略、员工角色及路由同版。
- Go 模型 `fcce40cf-3172-4863-b0bd-776673f499e6`，配置 SHA `b0d6126cc6974d01d1df1a3eac88b4fb047496f7d0743b4f938a92352f9cf4a9`；规划 receipt `9aad4d3b-6282-4ed4-a423-fc446b70e369`，费用约 0.0068643 美元。

[sources.json](../test-evidence/go-normal-v8-resumed-20261006-131623-7dfd8f29/sources.json) 原六项 GET 均记录 HTTP 200，各文件原字节长度/SHA 全部匹配。索引保持六项，SHA `978f187fe44a8ff0364df9b30338fd627caa096a6c996c0668913456f51016d5`。额外 [父 raw export](../test-evidence/go-normal-v8-resumed-20261006-131623-7dfd8f29/parent-original-export.json) 独立验证：31767832 bytes，SHA `6433cbc973775f49fc3751ba19df3eac1aaceaec0ca34e39c522e9d2c099770d`；HTTP 200 来自 root 的实际 GET 捕获元数据。完整来源 SHA 保存在同名 JSON。

## 完整 DAG 与交付继承

| 节点 | 依赖 | 本次结果 |
| --- | --- | --- |
| dev / developer | 无 | 继承父 accepted attempt `847386dd-94e0-485d-9ab8-b332981ae06c` |
| qa_verify / qa | dev | 继承父 accepted attempt `2c0dd0e0-1e18-4786-b889-3bc14d497235` |
| qa_review / qa | dev、qa_verify | 新 attempt `4278eb99-2399-451b-8e51-c9365bdc0dc8`，accepted/pass |
| manager_accept / manager | qa_review | 新 attempt `1d93f0a5-20ba-4249-a762-bf669ec103c7`，accepted/pass |

恢复事件 seq 30 绑定真实父 ID 与 dev/qa_verify 两节点。child.snapshot.handoffCheckpoints 与父 raw accepted seals **完整字面相等**。四份文件同时匹配父输出、恢复 PIN、QA/经理输入及最终清单；dev/qa_verify 新模型 request/wire 均为 **0**。

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| server.mjs | 8708 | `088dca7377c931f45881fe5f3e06a19c50192c1d6847c96576c94514eba12630` |
| todo.test.mjs | 9719 | `53fa4d170b0c1efe7181b104345cfe5cf50e759b624ca9ddde6a66bff933aa3b` |
| README.md | 3159 | `776e688a8c76c97b95659f162e77a5ca34781d44cfd53601f9d96a40bdca838a` |
| acceptance.test.mjs | 23389 | `71677ecd31d4ad927921f4af7067649c7d3bb05d3e72e52c2a2eb1d7d59d3954` |

QA 与经理各读取四份文件的八份档案内容副本也重新计算 UTF-8 byte SHA，通过；未打开原员工文件。

## 真实 QA 与经理写入

QA 两命令均有唯一真实审批、同 session/call/task/attempt 的本机 queued/finished、宿主 observation 和 seq 1108 accepted。模型原生参数是命令，宿主增加 expectedWorkspaceRevision 后请求审批；审批正文与实际本机派发正文完全一致。

| 命令 | 真实结果 | 完整 combined 输出 SHA | 审批→queued→finished→observed→accepted |
| --- | --- | --- | --- |
| node --test todo.test.mjs | exit 0；spec tests 7/pass 7，其余 0；679 bytes | `5a9805e8b5a6429deeba019843ded0997b0c7adb3542a026687c02c1d6e7ac42` | 535→540→551→553→1108 |
| node --test acceptance.test.mjs | exit 0；spec tests 7/pass 7，其余 0；842 bytes | `66f537c600ad98d76177d61c095497930f215a0281da03963071969d5e1b107a` | 988→992→1012→1014→1108 |

从 local-operations 原输出重解析统计、重算完整字节 SHA，均与宿主证据相等。单独 stdout/stderr 仍 unknown / EXECUTOR_STREAM_NOT_SEPARATE；combined 输出不代表独立流。

[经理报告原字节](../test-evidence/go-normal-v8-resumed-20261006-131623-7dfd8f29/manager-report.md)：12475 bytes，SHA `24095c10a7adedaf730309b2830b6a23d3ef1643d7dcf06478672979c827293e`。employee-1 / manager 的原生 artifact_write 正文、本机操作 `21714187-7b3e-4bbd-92e0-d145d8807b63` 正文、导出报告、accepted 输出与最终清单完全相同。call 1467→queue 1474→finish 1478→accepted 1536；经理没有测试命令。

主要 PASS 结论与宿主回执/档案源码匹配：最终开发 7/7，父 QA 两条 7/7，本次复审两条 7/7；真实 CLI 子进程和 PORT=0、内存 Map、import 不自行监听的源码与测试存在。早期开发 6/7 exit 1 失败仍保留；知识、跨平台、压力和安全测试等未验证项保持员工披露范围。

## 调用与账务

- 父宿主保留 **24 calls**，已发 wire **23**。未派发 review receipt `aac77ca0-f367-4a9c-8b4c-b4c3971ecfe6`（dispatched:false / CALL_INTERRUPTED）仍占 **1 次额度**，qa_review 入场 calls=1。
- 子新增 **18** 个唯一 wire/usage：qa_review **9**、manager_accept **6**、captain **3**；终值 **24+18=42**。继承 basis 为 durable-admissions-and-archived-wire-requests。父子 usage ID 不相交。
- 父新增已记录费用约 **0.2186019**；child 入场 recorded **0.848147**。child 新增 **0.200091**（QA 0.1151883、经理 0.074013、captain 0.0108897）；readiness recorded **1.048238** 美元，没有重复计费。
- 未知预留 **0.096526** 保留；receipt `4c46dd1b-d172-4044-8ba8-ff4e45343f8c` 仍 uncertain。pending=0、uncertain=1、available≈**3.034936**。
- 最终 checkpoint seq 1540，currentAtSourceEnd=true、后续 accounting=0：limit 4.1797、occupied 1.1447640000000001、calls 42。activeReserved **1.3877787807814457e-17** 位于既有浮点 tolerance 内，保留原值，不另算费用、不清未知。
- 12 个本机操作全部 completed/started=true/lateResult=null；unknownOperations 与事件推导的 unresolvedOperations 都为空。

## 如实保留的精度与强度限制

1. 员工报告 §6.2 把开发与独立 QA 写成同一完整工作区 revision。开发三文件宿主 revision 是 `ccd7ceac…d6a0e`；添加 acceptance.test.mjs 后 QA 四文件是 `671a9b9c…50f3a`。三份开发文件 SHA 一致，完整清单 revision 不同。
2. D1 失败行缩写 `2f69a978…d6a0e` 的尾部不准确；实际 `2f69a97827d409340645ce9cefc635d4975b0d56794d5aece25a4c6edeee65d9`。其 exit 1、排除最终验收的处理正确。
3. 报告头 `d5603683…208c2` 是写报告前四文件的本机清单 SHA；宿主 localeCompare 排序的同四文件是 `671a9b9c…50f3a`。加入报告后五文件本机/宿主清单 SHA 是 `70414e84…7488` / `a261a257…137d`。这些是清单 revision，报告文件 SHA 则为 `24095c10…293e`。
4. acceptance.test.mjs 固定 3000 端口的反向探针允许 exit 0 或 7，该单独断言不足以证明没有监听；员工已披露。另有自然退出 0、signal null、无地址/监听文本的 import 检查。真实 7/7 不因此变成更强的负向网络证明。
5. 员工未看到终端正文针对其受保护 metadata。本审核核验保存的完整 combined 正文，独立流仍未知。
6. 旧父包装档案四处 `.930Z→.93Z` / `.490Z→.49Z` 来自 PowerShell JSON 重序列化格式；原字节父与继承 seal 时间字符串逐字相等，没有产品传承改时间证据。

两个纯本地核验阶段均 exit 0。完整来源 SHA、审批/session/call/operation/attempt 绑定、费用 checkpoint 和精度说明保存在 [同名 JSON](go-v8-real-resume-audit-2026-10-06.json)。冻结 operator/run-evidence SHA 保持原值。员工报告未修改。
