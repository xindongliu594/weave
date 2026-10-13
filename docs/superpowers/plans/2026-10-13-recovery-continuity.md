# 恢复进度与最后一次交接修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task.

**Goal:** 保留未完成任务的工具进度，并让最后一次已授权模型调用专用于正式交接。
**Architecture:** 复用DSH持久化、原生pre-step、AgentTeams和现有HandoffGate；补恢复元数据与宿主控制的交接阶段。
**Tech Stack:** 现有Node、DSH、TypeScript；无新依赖。
**Spec:** ../../research/recovery-continuity-2026-10-13.md。

## Global Constraints

- 当前阶段不调用真实模型，不重发429请求；累计$2.72、阶段$0.64及已批准项目分配保持。
- 旧运行、完成节点、知识版本、权限、交付和未知预留不变。
- 不复制旧团队会话身份，不把历史工具结果当新尝试验收证据，不导出私有正文。
- 本地协议夹具只能验证程序；QA/经理及知识发布真实闭环保持未验证。
- 用户“好开始把”授权上述常规修复，按现有架构执行，不为实现选择重复确认。

## Review Focus

- 无callId配对、结果未知或工具调用失败，不能标为完成或自动重放。
- 兄弟员工资料、任意正文、隐藏推理不进入恢复摘要；8KB上限保持。
- 队长、已封存任务和不剩调用的任务不能误入交接阶段。
- 最后一次额度仍受费用、身份、输出和未知结果门禁约束；压缩/其他工具不能偷用。
- 普通文字结束或非终态更新不能自动完成，不触发无限纠正。

### Task 1: 保留恢复工具定位和状态

**Files:** checkpoint-context.mjs及checkpoint-context.test.mjs。
**Interfaces:** buildCheckpointContext的每任务节点增加有界recentOperations；recoveryContext只投影已允许元数据和当前任务/固定资料定位。
- [x] RED：完整认领/检索/读取有最近状态，未配对为unknown；相同callId跨session不能误配；无正文泄漏。
- [x] GREEN：最多6项，白名单名称/参数、callId配对，继承不重复；恢复规则说明当前宿主已分派时不重新认领，按已知固定引用读取而不重复探索。
- [x] 验证checkpoint、恢复上下文和已有命令/知识隔离用例。

### Task 2: 宿主控制最后一次交接

**Files:** host.mjs、employee-hosts.mjs、openai-compatible.mjs及其相关测试。
**Interfaces:** 宿主提供handoffClosure(sessionId)，仅返回当前未封存员工的taskId/runtimeTaskId/attemptId；工厂pre-step追加一次原生提示；适配器最后阶段工具目录限agent_teams_update_task、请求用途handoff。
- [x] RED：节点或项目剩1次触发；只有正式交接工具；其他工具及非终态更新拒绝；压缩不消耗这次；没有工具支持则发送前停止。
- [x] GREEN：保留全部金额和身份校验，模型自行提交completed/failed，最终普通文本不再续发请求；队长/完成节点不触发。
- [x] 原生协议验证“读取返回→最后判断并提交”与“仍未提交→停止”；不伪造真实验收。

### Task 3: 工程验证与交付

- [x] 运行变更相关原生回归、恢复来源/API、类型及构建；新增失败再扩大检查。
- [x] 一次新上下文最终审查；重要问题一轮修复并回归。
- [x] 保存简短报告和证据；代码按精确文件范围交付，历史未提交文件保留。
- [ ] JJ发布后核对服务版本、原数据与批准快照不变；SSH断线，最终结果待核对，不重复apply。
- [x] 中转站和未知收据受阻时如实保留；不把本地协议通过写成真实QA/经理/知识闭环通过。

2026-10-13执行记录：独立审查两项Important已在一次修复中处理，最终原生155+隔离/费用展示/历史53+来源28=236通过，类型/构建通过。JJ固定包预检通过，发布在测试期间SSH断开，之后22端口超时；服务和发布最终结果待核对。没有重跑apply或真实请求；429、未知费用和经验闭环阻塞保持。接续顺序见验证报告。
