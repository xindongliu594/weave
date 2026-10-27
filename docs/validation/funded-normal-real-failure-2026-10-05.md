# 正常验收项目真实失败记录（2026-10-05）

Run `8d5b4848-1f57-491f-9647-80ff3ed577af`，项目 `4938eab8-26ed-4f60-9413-d979f05fa968` v2。本次真实运行 **failed，MVP 未通过**。本报告于 2026-10-05T21:22:29.0637144+08:00 通过本机 API `GET /runs/:id/export` 核对；归档 integrity=ok、1092 事件。[独立 JSON 证据](../test-evidence/funded-normal-real-failure-2026-10-05-212229-8d5b4848.json) 保存事件序号、ID、SHA 及精确诊断字段。

开发已完成：native t1 的 attempt `55e9e46f-0d64-44eb-bbbe-0fa62a9f6b12` 与宿主 `handoff/accepted` seq1016 完全一致。`node --test todo.test.mjs` 实际 exit0，Node spec 汇总 tests=2、pass=2、fail/skip/cancelled/todo=0。实际工具结果 seq922 与观察 seq920 的合并输出 SHA 完全一致（240 字节）；审批 `1ce8ae14-a9f1-4586-b3ee-d89767b33ff8`，本机 operation `3a2bca07-d818-4828-80c3-666077466b6c` 的完成事件 seq918 可追溯。stdout/stderr 已合并，单独流证据仍为 unknown。

| 开发交付 | 字节 | 完整 SHA256 |
| --- | ---: | --- |
| server.mjs | 3273 | a5c87ff880f91dd1c214e30ccd3fd7514af77786c7916b0ee8dad8109c1dd0ba |
| todo.test.mjs | 2734 | 751ff5d607a5d7bd35691dabcd5ecbf8adf8950eac6865dfb84e8e17eab47d4f |
| README.md | 739 | b42c1371a3443f0c14283752221c2168ecb818663bef9e6a77e573c88d737da1 |

QA 首轮回执已实际生效：持久化 protected snapshot seq1025 与 model/request seq1029 的同一完整 JSON 一致，实际 wire seq1037 也保留该 JSON；SHA `d84ad6b6e557ad4f049e82a9a9af5b6b5f9873c7a3eb07cf7274b95c3a8cf2b1`，10771 字节。其 `completedAncestors` 有开发同 attempt 一项，`unavailableAncestors=[]`，命令、测试数、审批/operation 和输出 SHA 均与原回执对应。因此本次失败没有“QA 开始前祖先列表为空”的证据。开发起始无依赖，空祖先符合合同。

失败发生在 QA 首次 Sol 模型请求，尚无 QA 终端操作。seq1049 的 provider-response 为 **HTTP502**；seq1050 `billing/unconfirmed` 为 **PROVIDER_ERROR / dispatched=true**；seq1053 模型结束保存相同失败，seq1092 最终 run/finished=failed。宿主精确安全诊断前缀为：`中转站返回 HTTP 502；上游错误摘要（仅诊断）：code=upstream_error；type=invalid_request_error`。嵌套结构的安全代码为 `server_is_overloaded / service_unavailable_error / NO_MORE_RETRY`，响应表示上游过载；没有核实供应方内部根因。报告不复制供应方正文或凭据，JSON 保存原失败字段 SHA `b335a3e3e1442416df9f6cc8a5fa0da7a37b4bdb52ee89b9b31119da0d46c2a3` 及 370 字节，可回原归档核对。

本 run 共10次 wire（Luna开发9次、Sol QA1次）；9笔已结算，合计 **$0.0186906**。未知收据 `4c46dd1b-d172-4044-8ba8-ff4e45343f8c` 的 **$0.096526 是未结算预留，实际费用未知，不能按零记录**。仅依据这份归档，未查询维护型 `/costs` 或供应方账单。开发封存后有一次模型收尾请求，但没有再次写文件/运行命令。最终宿主 budget checkpoint seq1091 保留 callsUsed=10；其占用和余额不是含新增未知费用的完整当前账本，不能当作恢复的最新费用结论。

独立 QA 失败于首个命令之前，QA复审与经理节点 pending。经理任务模型请求 **0次**，其真实首个上下文和经理验收均**未验证**；本 run 的受控中断恢复也未验证。此次仅只读 GET 和新报告落盘，没有审批、费用登记、模型重试、服务操作、源码或原数据修改，也没有由 Codex 补写员工交付物。

