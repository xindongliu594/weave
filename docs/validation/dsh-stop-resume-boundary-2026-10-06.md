# DSH 停止与续跑的能力边界

2026-10-06，只读核对当前安装源码、已有真实运行证据和官方文档；本次没有模型调用、业务审批、服务停止或员工交付物修改。

当前运行器固定 DSH 0.1.5-rc.1、AgentTeams 0.1.20。安装包 `dsh-agent/lib/index.js` 提供持久会话 resume；AgentTeams `lib/tools.js` 有团队停止边界、成员取消与 resumeTeamState。不是底座完全不支持，也不是 Todo 任务特殊。

官方 [session-checkpoint-policy](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-checkpoint-policy/README.md) 将持久化后端与强制落盘时机分开：模型请求前、工具副作用前及下一步前落盘，写失败则拒绝派发；已派发而没有结果的操作按未知结果处理。此为当前官方能力说明，不等于已在本项目挂载或验证该插件。

本项目用自己的 React 网页、API/PGlite 账本和受限员工 Host。`host.mjs` 挂载 JSONL 持久化，并记录团队 checkpoint；当前未显式挂载 session-checkpoint-policy。`run-management.ts` 在恢复时核对原档案、完成节点、文件 SHA、未知操作、累计预算和调用、授权及原版本，创建关联原 Run 的续跑记录。`checkpoint-team.mjs` 只在 staged 阶段恢复 accepted 节点，再启动剩余任务。恢复实现包含产品自己的完整状态，不能仅调用一次 DSH 会话 resume 取代。

已修接入故障：`agent_teams_status` 会等待冷 Host 恢复，原产品额外 15 秒超时能误停正常任务；现在使用原运行取消/期限信号，25/25 定向工程回归通过。见 [状态生命周期验证](status-lifecycle-runtime-2026-10-06.md)。网页验收工具曾在大档案 preflight 结束前耗尽响应等待时间，四次停止尝试为 0 POST；已将响应计时移至实际转发前，并等待 preflight 完成，保留未知已转发结果不重放。见 [受控停止工具验证](go-explicit-target-final-scope-2026-10-06.md)。后者是验收工具故障，不能据此断言产品停止接口或 DSH 失效。

已有真实同版 v8 子 Run `f0f68b82-eeaf-493f-9f54-c932504e430a` 完成：开发与 QA 完成节点继承，两者新模型调用均为 0，原文件 SHA 保持，复审和经理完成；见 [真实同版续跑审核](go-v8-real-resume-audit-2026-10-06.md)。该父 Run 是非受控失败，不能替代必须的“网页主动停止 → 服务重启 → 同版续跑 → 固定知识引用”完整验收；此完整路径仍待完成。

预期用户流程：停止入口先关闭新任务和调用派发，结束或明确记录在途操作，保存节点/文件/知识/费用与调用证据；重启后先检查恢复条件，再跳过 accepted 节点并继续未完成节点。供应方扣费或外部写入结果未知时保留记录与预算预留，按实际核对结果处理，不能自动当成未执行。
