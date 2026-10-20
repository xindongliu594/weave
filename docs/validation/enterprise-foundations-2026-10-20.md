# 企业基础加固：进度与证据

本轮目标：在既有为伍基础上完成沙箱、checkpoint、长任务、工具可靠性、上下文目标、真人权限、监管、Eval、知识生命周期、数据运维十项基础能力。不是仅复测一个小任务。

基线：`4fc763983ce0aae292052ec87c88b7f563a1fac2`。总设计与依赖顺序见 `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`、`docs/superpowers/plans/2026-10-20-enterprise-foundations.md`。

## 当前状态

| 项目 | 当前状态 | 不能据此声称 |
| --- | --- | --- |
| 固定版本/成熟方案调研 | 三份研究文档已完成 | 候选软件已安装或已部署 |
| 真人身份内核 | 本地 14/14 检查及独立复审通过；永久关闭已使用环境的首次管理员入口，停用身份不会自动激活 | OIDC 登录、全路由权限已上线；真实 PostgreSQL 并发已验证 |
| 任务工作区合同与 CAS 合并 | 本地实现及独立审查通过；14 项任务/编码、7 项原执行器、2 项 revision 回归通过，类型检查通过 | 员工已在独立 OpenShell 沙箱运行 |
| Promptfoo 评测桥 | 官方 CLI 离线正/负用例已运行；两项评审修复后 14/14，独立复审中 | 真实模型业务质量已通过 |
| checkpoint 硬链接校验 | Windows 本地修复及相关回归通过 | JJ 生产已发布此修复 |
| 其他企业阶段 | 计划中，见总计划 | 所有企业能力完成 |

## 已复现并修复：checkpoint 硬链接边界

根因：`checkpointFiles` 拒绝符号链接，却未拒绝普通文件的多硬链接；已保存 object 的 `assertPlain` 同样只检查类型。拥有另一条文件路径的文件可进入快照或在还原时被接受。

改动：工作区文件扫描、已有 object 校验、恢复 object 校验均拒绝 `stat.isFile() && stat.nlink > 1`。不修改或删除原链接/文件；遇到该状态要求先核对来源。

复现命令：`node --test --test-name-pattern=hardlinked services/agent-runtime/step-checkpoints.test.mjs`。Windows 受限 shell 首次在创建链接阶段被 OS 拒绝，因此不计为缺陷复现；仅提升此临时目录测试的运行后，两项均因 `Missing expected exception` 失败，证明实际缺口。

修复后：

| 命令 | 结果 | 范围 |
| --- | --- | --- |
| `node --test services/agent-runtime/step-checkpoints.test.mjs` | 6/6 | 版本、去重、损坏拒绝、档案写失败、两个硬链接场景 |
| `node --test services/agent-runtime/step-checkpoints.test.mjs services/agent-runtime/step-checkpoint-crash.test.mjs services/agent-runtime/checkpoint-context.test.mjs services/agent-runtime/employee-checkpoint-policy.test.mjs` | 18/18 | 真实临时文件与子进程、DSH 持久化屏障、受控中断恢复、旧完成命令不重跑 |
| `node scripts/test-integration.mjs tests/backup-checkpoints.test.ts` | 6/6 | 隔离 PGlite，备份中 checkpoint/亲缘/未知操作校验；不代表真实 PostgreSQL 并发验证 |

受控子进程测试报告：sourceRunId `44250c6c-a324-4df5-af1f-0ba88ea5ed09`，resumedRunId `a3cc8266-3487-40b4-93cc-3ddc65f46438`，checkpointId `3c1eb1cf-9ec7-45cf-97b5-5915f773f327`；命令总执行 1 次，模型调用 0 次；checkpoint 24.8403 ms、恢复 24.7057 ms、档案 5205 bytes。这些是已自动清理的临时测试运行，不是用户生产项目。

边界：以上不声称抵御可并发修改底层存储的宿主管理员，也不声称本轮 task 隔离已完成。真实 OpenShell 及 JJ 发布验收在后续阶段执行。

## 费用与生产状态

本阶段没有新增模型调用；未修改现有生产数据库、项目授权、运行状态或未知费用。旧真实恢复任务的预算不足问题仍独立保留，不伪造已完成状态。

## 任务工作区第一模块

实现 `createTaskWorkspace`、`validateTaskExport`、`planTaskMerge`：可信侧固定任务/员工/执行环境身份、来源版本和输入/输出边界；完整校验导出后生成保留其他成果的合并计划，版本冲突拒绝。复用原路径、编码、文件数量和体积检查。首版禁止把缺失文件当删除，且保守要求整个基线 revision 相同。

独立审查通过；额外畸形输入及容量检查通过。相关原执行器测试在受限 Windows shell 因临时文件操作权限失败，使用同一临时测试的允许权限复验 7/7 通过，未修改产品来绕过限制。

本模块是未接线的纯规划器，scope hash 仅证明内容一致性；调用者仍需从可信批准快照构造合同，保留权威副本并复核授权。完整 canonical manifest 只在可信侧使用，不传入员工上下文。真实沙箱分配、持久合并、checkpoint、执行器接线与 JJ 对抗验证仍未完成。

## 后续接续

身份内核复审同时验证旧 schema 三种 bootstrap 状态升级及重复迁移；已有管理员停用/删除不会重开初始化，闭合事件与状态在同一事务写入。PGlite 隔离验证不替代真实 PostgreSQL 并发。

截至 `ccf006c` 加上述待提交内核，父任务再次执行 `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/vite/bin/vite.js build`，均退出 0；Vite 构建 18.27 秒、1715 模块，保留单个 JS chunk 超过 500 kB 的优化提示，不将其列为构建失败。

接续具体计划已保存：`docs/superpowers/plans/2026-10-20-oidc-api-integration.md`、`docs/superpowers/plans/2026-10-20-task-sandbox-integration.md`。先接协议/执行器，再完成路由/消费者/恢复/网页和 JJ 验证。所有十项持续记录，不能因当前局部测试通过而关闭整个目标。
