# 企业基础加固：进度与证据

本轮目标：在既有为伍基础上完成沙箱、checkpoint、长任务、工具可靠性、上下文目标、真人权限、监管、Eval、知识生命周期、数据运维十项基础能力。不是仅复测一个小任务。

基线：`4fc763983ce0aae292052ec87c88b7f563a1fac2`。总设计与依赖顺序见 `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`、`docs/superpowers/plans/2026-10-20-enterprise-foundations.md`。

## 当前状态

| 项目 | 当前状态 | 不能据此声称 |
| --- | --- | --- |
| 固定版本/成熟方案调研 | 三份研究文档已完成 | 候选软件已安装或已部署 |
| 真人身份内核与协议 | 内核 14/14；真实库及隔离 TLS IdP 协议 17/17；会话并发缺陷修复后独立静态复审通过 | OIDC 登录、全路由权限已上线；真实 PostgreSQL 并发已验证 |
| 任务工作区合同与 CAS 合并 | 本地实现及独立审查通过；14 项任务/编码、7 项原执行器、2 项 revision 回归通过，类型检查通过 | 员工已在独立 OpenShell 沙箱运行 |
| Promptfoo 评测桥 | 官方 CLI 离线正/负用例已运行；独立复审通过；`8f43c2a` 的 Windows/Linux CI 各 14/14、零跳过 | 真实模型业务质量已通过；旧报告可验证后续改动的版本 |
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

评测桥独立复审：6/6 门禁回归及 13 种一致改写 raw/manifest 的负面案例全部按预期拒绝；原生错误、跳过、子断言失败或未知费用不会被正面汇总字段掩盖。源码清单只选相关应用/构建/依赖/规则输入，含未提交源码；私有资料和历史验收文档在读取前排除。真实 CLI 证据固定于 `ccf006c` 的当时 dirty 源码，源码摘要 `70083fa65758dec4f941ded5a2b489f54a0e6a914707630bb4dd15dcd018b3bb`。提交/源码改变后旧报告按预期拒绝，不能拿它替代新版本评测。

Promptfoo 0.124.1 独立锁定安装，开发依赖实测约 1.21 GiB，不进入 JJ 生产包；生命周期脚本禁用。安装阶段尚未做 npm 安全审计，后续审计结果见本文“依赖维护”。执行模式保持禁止，尚未接服务端真实评测授权或真实业务。离线 CI 的实际结果见下文。

身份内核复审同时验证旧 schema 三种 bootstrap 状态升级及重复迁移；已有管理员停用/删除不会重开初始化，闭合事件与状态在同一事务写入。PGlite 隔离验证不替代真实 PostgreSQL 并发。

截至 `ccf006c` 加上述待提交内核，父任务再次执行 `node node_modules/typescript/bin/tsc --noEmit` 和 `node node_modules/vite/bin/vite.js build`，均退出 0；Vite 构建 18.27 秒、1715 模块，保留单个 JS chunk 超过 500 kB 的优化提示，不将其列为构建失败。

接续具体计划已保存：`docs/superpowers/plans/2026-10-20-oidc-api-integration.md`、`docs/superpowers/plans/2026-10-20-task-sandbox-integration.md`。先接协议/执行器，再完成路由/消费者/恢复/网页和 JJ 验证。所有十项持续记录，不能因当前局部测试通过而关闭整个目标。

## 双平台离线 CI：首次运行与修复

提交 `482631a43d1400f6507ddee2a179c0f6ba62ee7a` 的实际 GitHub Actions [运行 39364813640](https://github.com/xindongliu594/agent-department/actions/runs/39364813640)：Linux job `118439106681` 成功，Windows job `118439106467` 在离线 CLI 检查失败，安装和预检通过。Windows 报 `fixture-digest-mismatch`；Git 的换行转换改变了固定样本字节。

用 `git -c core.autocrlf=true cat-file --filters HEAD:<fixture>` 实际复现：五份样本转换为 CRLF 后均与登记的 SHA256 不符。只在 `.gitattributes` 增加 `tools/evaluations/datasets/*.json -text` 后，同一 Git 过滤检查五份均匹配。独立审查同样复现并批准；没有修改摘要校验或全局 Git 配置。提交修复时，新 checkout 的远端检查尚未运行；后续结果如下。

后续实际结果：修复提交 `8f43c2aecf13102224cf3376347a040ac52c1f6c` 的 [运行 39365731426](https://github.com/xindongliu594/agent-department/actions/runs/39365731426) 成功。Windows job `118442030918` 为 14/14、0 skipped、6.014 秒；Linux job `118442031052` 为 14/14、0 skipped、4.645 秒。两者均安装并执行固定官方 CLI，包含真实离线正/负门禁；没有模型或生产访问。此结果只绑定该提交，不能证明未提交的身份/任务隔离实现已通过 CI。

## 未发布的集成工作

- OIDC 协议层复用真实 `openid-client`、Express 会话及隔离 TLS IdP。首次 9/9 检查仍遗漏并发退出问题：独立审查复现旧 SID 被延迟保存重建。修复增加持久会话世代记录与同一根记录上的事务锁，保存、轮换、退出和清理使用一致有效性约束。父任务实际复验 17/17、0 skipped、8.073 秒；内核 14/14、类型检查通过；独立静态复审 PASS。物理会话记录的 expire 被限制在该 SID 有效期限内，浏览器 cookie 仍可能保留更晚的失效时间，但不能恢复已失效登录。旧的无世代记录会话升级时要求重新登录；迁移前须停止旧写入进程。该模块尚未发布或接入业务路由，真实 PostgreSQL 独立连接竞争和浏览器部署未验证。
- 任务执行 scope 已加入可信 employee/task/attempt/session 绑定、服务端 generation、租约/项目版本校验和输入来源。独立审查发现实际 ReworkGate 保留完整交付输出时，窄范围返工被误拒绝；现已将“完整交付合同”和“获准写入子集”分开，统一应用于 scope 与历史提交核对，未扩大读取授权。scope 25/25、host/rework 17/17、类型检查通过，独立复审的新真实 ReworkGate 回归 1/1 通过。新 profile 保持禁止执行；实际 task OpenShell、持久成果合并与跨 run 恢复尚未接通。本地 Task 1 通过不代表 B2 完成。

## 工具效果合同格式：局部验证

新增工具效果合同、意图、状态及证据类型，提供有界严格 JSON 校验和稳定内容摘要。合同显式表达读取/工作区写入/外部动作/未知效果、重试策略、收费适配、核对方式和需另行批准的补偿。校验后的合同与输入脱离且不可变；未知效果不能声明自动重试。

首次独立审查复现 Proxy 可在检查期间触发调用方 trap；现已在任何反射前拒绝根级、嵌套、数组及已撤销 Proxy。父任务实际执行 12/12、0 skipped；独立复审也实际执行 12/12 并通过。定向类型检查通过。

这只是 C1 Task 1a 的格式与摘要模块。它不证明来源可信，不授予调用权限，也没有接入能力目录、批准快照或实际工具执行。后续 Task 1b/3 必须完成这些接线，不能据此标记工具幂等和副作用恢复已完成。本轮没有新增模型调用或 JJ 生产变更。

## 依赖维护

2026-10-20 在线检查根生产依赖，发现 sharp 0.35.4 的已知 high 公告。兼容更新至 0.35.5，仅修改锁文件中的 sharp 及 26 个配套平台库，根 manifest、Transformers 和身份依赖版本均保留；安装脚本关闭。

父任务在 Windows 实际加载 sharp 0.35.5 / libvips 8.18.7，用合成 2×2 RGB 像素生成 98 字节 PNG，再解码核对逐字节一致。更新后在线生产依赖 audit 返回 0 项，类型检查及构建退出 0，保留既有大 chunk 提示。没有加载嵌入模型，没有模型调用或生产部署。Linux/JJ 二进制兼容性仍待隔离验证；零公告不等同于全面安全审计。

隔离 Promptfoo 目录的在线 audit 有 10 个受影响包，归于 basic-ftp、braces、node-forge 三项原始公告。现有父包约束内没有已验证兼容补丁，本轮保持该锁文件不变，明确记录在 `tools/evaluations/README.md`。固定离线 runner 不开放任意配置、FTP 或证书导入；该限制不能证明依赖漏洞不可利用。详见 `docs/superpowers/plans/2026-10-20-dependency-security-maintenance.md` 的依据和后续门禁。
