# Task 检查点与成果读取：本地基础批次

2026-10-20；B2 Task5 的非恢复批次。复用 DSH checkpoint/flush、现有 SQL canonical/CAS 和 SHA 对象存储，没有新增执行引擎。本轮没有付费模型请求、额度调整或 JJ/生产操作。完整 Task5/6 尚未完成，新 profile 仍关闭。

检查点 v2 明确分开员工 task work manifest 与全项目 canonical ref，保留原输入来源、任务/尝试/generation、能力摘要和已提交操作。可信 API 在原锁和当前授权下校验 SQL 及 SHA 对象，等待真实 COMMIT 后再同步核对档案分派、对象与取消状态。引用只在 API、Host、Handoff 和档案中传递；员工工具结果不包含完整项目清单。旧 v1 格式及摘要保留，未完成 v2 任务必须重新验证，不继承旧终端批准或命令。

工具派发、结果观察、节点验收及 DSH flush 后的循环边界均等待私有引用。知识任务也会产生 node-accepted 检查点。节点原生完成后如检查点写盘失败，全运行进入故障拦截：保留已持久写入的 native/accepted 历史，不发布可用 completed seal，不允许换任务或 generation 绕过；最后一个节点故障也返回 failed。当前运行的拦截 latch 位于内存，失败终态和原历史进入档案；跨服务重启的恢复认证仍属后续门禁。

交付列表、下载、Office/父素材、规划上下文、工作记录和恢复提示读取实际 SQL row 的一次完整 committed 集合，并核对原 SQL 操作；半套兼容缓存不参与裁决。坏对象、缺原提交、未决 SQL 操作、未知 profile 或尚未认证的恢复来源明确拒绝。初始 null-merge head 暂不支持这批业务消费者。工作登记逐项验收使用经过任务身份核对的 sandboxWorkRevision；全项目 workspaceRevision 继续保留为完整成果版本。

实际发现并修复：正常 DSH 进度被误认为撤权；最后 SQL await/COMMIT 期间撤权或对象损坏未拦截；检查点拒绝后仍有下一次模型请求；知识任务漏存接受检查点；同步写盘失败后下游继续；工作登记混淆全项目与任务局部版本；脱敏修改元数据后仍报告检查点成功。每项有具名 RED/GREEN，不以文档代替测试。

脱敏兼容的当前边界：v2 的引用及完整 metadata 必须在原脱敏规则下保持不变，实际 append 返回的数据也必须与待写记录一致。命中规则的标识、文件名或 receipt 文本会明确返回 `CHECKPOINT_METADATA_UNSAFE`，例如合法文件名 `docs/sk-abcdefghijkl.txt` 在这批 v2 中暂不支持；不会绕过脱敏或重算 canonical 身份掩盖变化。格式验证和真实档案测试覆盖 own work、仅全项目 canonical 中的此类名称以及写入后意外变更。后续如需完整支持，须设计受约束的 typed metadata 归档并验证，当前限制不隐瞒。

三条实际 Product→Host/AgentTeams→工具包装→本地 HTTP claim/start/result→SQL canonical→Handoff→工作记录链均通过，约 124.17 秒：连续写入、B 交错提交后 A 继续，以及旧审批零操作、重新审批后执行。模型响应、物理设备与审批决定是工程夹具；SQL 成功操作/merge 未预填。测试的协调等待从 20 秒改为 40 秒、fixture policy/测试时限相应留出 SQL 与 fsync 时间，原生产时限、预算和审批规则没有改动。此前超时报告保留为夹具失败，不把它们描述成中转站故障。

最终验证：

| 范围 | 实际结果 |
| --- | --- |
| 运行时 v1/v2、真实 Host、flush/写盘失败、私有对象与错误 | root 串行 71/71，0 skip |
| 检查点 API（含真实 COMMIT 期间变化） | root 隔离 PGlite/HTTP 20/20 |
| 完整成果消费者与真实 Handoff 封存 | root 隔离 PGlite/HTTP 9/9 |
| 备份目标保护 | root 隔离 HTTP 3/3；原扩展备份 6/6；原生 PG 并发另见独立报告 |
| 成果材料/规划/工作记录 legacy | 30/30；工作记录夹具修正生命周期后 root 又通过 4/4 |
| 局部验收版本和 legacy 交接 | root 5/5 |
| 原 canonical/bridge/result/scope 回归 | 55/55 |
| 完整 Product→HTTP→工作登记链 | 3/3，36 次实际 SQL 操作、6 个工程设备对象、7 次审批夹具决定 |
| 类型检查与构建 | 最后源版本退出 0，Vite 6.64 秒，保留既有 chunk 大小提示 |
| 独立审查 | API、运行时、消费者/目标保护、验收版本与最终整批均复审 PASS |

三例运行 ID：`1fa486c0-62b2-4e2b-bb99-af07d3e784f4`、`05ea52f1-e0aa-40d1-bf22-3b08714715d6`、`bb38e468-3ac0-49ef-aaa8-202a3c0c8251`。对应操作、工程 sandbox ID、版本及命令输出见[脱敏证据目录](evidence/task-checkpoint-v2-live-foundation-2026-10-20/)，来源 SHA 记录在 tested-sources.json。临时夹具数据库/工作区在测试结束时清理，报告未把这些 ID 描述为生产业务运行。

全量 portable 默认并行曾耗尽 V8 内存，已停止原测试进程，相关套件按文件串行；没有声称全量通过。本批不证明真实 PostgreSQL 的 task 锁、JJ/OpenShell 物理隔离、付费员工质量、恢复/分支/循环、容量停止/删除或 task 备份兼容；这些继续作为后续门禁。真实业务、部署和网页企业主流程也未在本批重验。
