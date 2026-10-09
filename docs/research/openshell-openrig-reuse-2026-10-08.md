# OpenShell 与两个 OpenRig：为伍的复用选型

日期：2026-10-08（北京时间）。用户确认两个同名 OpenRig 都看。本轮核对维护者官方文档、GitHub 版本及固定提交源码；未安装、启动候选、调用真实模型、修改业务实现、权限、费用额度或原数据库。以下“建议”属于工程判断，兼容性和运行效果尚未实测。

## 1. 结论与版本

**NVIDIA OpenShell 优先作为执行隔离候选；mvschwarz/openrig 优先作为长期部门管理候选；EliasOenal/OpenRig 更适合作为 Linux 企业沙箱实现参考。** 三者覆盖不同层，不能以接入一个项目代替全部业务验收。

| 项目 | 主要定位 | 本轮固定版本 | 代码许可证 |
| --- | --- | --- | --- |
| [NVIDIA/OpenShell](https://github.com/NVIDIA/OpenShell) | 沙箱、进程/文件/网络边界、可信侧凭据与推理路由 | 稳定 v0.1.2：[`6648bd0`](https://github.com/NVIDIA/OpenShell/commit/6648bd0c290efbc41ba131ee9831ee45cd431f94)；main：[`277f922`](https://github.com/NVIDIA/OpenShell/commit/277f922d6d3b08b16d825cbd97499fe1a50031ac) | [Apache-2.0](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/LICENSE) |
| [mvschwarz/openrig](https://github.com/mvschwarz/openrig) | 持久岗位、多 Harness、队列、交接、恢复、TUI | 发布 v0.6.6；main：[`5fab9ae`](https://github.com/mvschwarz/openrig/commit/5fab9ae8025e0a0279c988aaee55d01dbac4d709)，2026-10-08 | [Apache-2.0](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/LICENSE) |
| [EliasOenal/OpenRig](https://github.com/EliasOenal/OpenRig) | 多用户 Linux Agent 服务、Firejail、网页与资源管理 | 0.1.0、Python ≥3.12；main：[`8bb61d3`](https://github.com/EliasOenal/OpenRig/commit/8bb61d30cc8baea9df2a0a54781a70b128af8f61)，2026-03-08 首次公开提交 | [BSD-3-Clause-Clear](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/LICENSE) |

发布版与 main 分开看，不能把开发分支能力当成稳定安装包能力。OpenRig 网站部分 FAQ 仍有早期简化描述；涉及权限、工作流及运行器时优先采用本轮固定源码和 as-built 文档。公开源码缓存保存在忽略的 `.data/research/` 下，含版本和文件哈希；没有执行下载内容。

## 2. NVIDIA OpenShell：可以直接优先复用沙箱底座

它把执行边界放在模型之外：Linux 文件访问使用 Landlock，进程使用权限下降和 seccomp，网络通过受控出口；provider 凭据留在可信侧按配置端点使用。对“员工可以自由开发，但不能越过公司授权”有直接价值。允许访问某端点仍允许向其传递内容，不能把受控出口解释为模型供应商看不到上下文。[官方架构](https://docs.nvidia.com/openshell/dev/about/architecture)、[Linux 进程过滤源码](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/crates/openshell-isolation-interface/src/linux/child_seccomp.rs)

**Windows 的现实路线是 WSL2＋Docker Desktop，官方标为实验支持。** 可以运行 Linux OCI 工作负载，GPU 和 Kubernetes 都不是必需；仍须检查内核和隔离能力，稳定矩阵要求 Landlock ABI≥3。不能将当前 Windows 本机执行器自动视为已隔离。[稳定支持矩阵](https://github.com/NVIDIA/OpenShell/blob/6648bd0c290efbc41ba131ee9831ee45cd431f94/docs/about/support-matrix.mdx)

main 已有原生 Windows MXC 驱动，但能力表缺重启持久化、交互执行/连接/转发等能力，依赖特定 Insider 系统和额外执行组件；内存 registry 重启会遗留会话。当前不选它作为为伍的 Windows 发布路线，也不能用“前提不满足时跳过的测试”为本机隔离证据。[MXC 能力表](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/crates/openshell-driver-mxc/README.md)、[驱动](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/crates/openshell-driver-mxc/src/driver.rs)

已有官方 TypeScript SDK，能管理生命周期、执行、取消和策略；执行流缺最终 exit 事件会报错。文件传输没有对应 RPC，CLI 采用 tar-over-SSH。为伍可接 SDK/CLI 而不用另造隔离内核，但仍须实现受限的文件传输、校验和版本封存，匹配所选发行版本。SDK 当前通过 GitHub Packages 分发，安装权限也是试点前提。[SDK](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/sdk/typescript/README.md)、[客户端](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/sdk/typescript/src/client.ts)

沙箱保留、重连和 stop/start 是基础设施生命周期。自动 restart 重启 supervisor 和主进程，不恢复进程内存或终端历史，文件持久化还取决于驱动。它不能代替项目 DAG、知识固定版本、已完成节点、累计预算和结果不明操作核对。[沙箱生命周期](https://github.com/NVIDIA/OpenShell/blob/277f922d6d3b08b16d825cbd97499fe1a50031ac/docs/how-it-works/sandboxes/overview.mdx)

**建议接入边界〔工程判断〕：** 第一轮只接批准的构建/测试命令，DSH、网页审批和费用/恢复记录仍在可信侧；通过隔离与文件往返验收后，再评估员工整个进程进入沙箱。员工任务上下文和公司知识仍按现有授权按需提供。

## 3. mvschwarz/openrig：最接近长期部门组织

它区分持久岗位 seat 和占据岗位的具体会话。岗位保留名称、职责和未完工作，会话可压缩、移交或恢复；pod 组织相关岗位，RigSpec 声明团队。这对应“研发经理、开发、QA 长期存在，新任务不重新造整支团队”的产品目标。[持续岗位](https://openrig.dev/docs/continuity)、[规格与适配源码文档](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/docs/as-built/architecture/adapters-and-runtimes.md)

队列把工作归属、闭合理由和交接记录在 SQLite；交接在事务内关闭旧项、建立新项。等待事项有唤醒计时器，消息和正式工作项分别处理。官方明确“交接/关闭”不等于下一阶段验收通过，这与为伍应保留真实 QA 门禁相容。[队列说明](https://openrig.dev/docs/coordination)、[固定提交的协调层](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/docs/as-built/architecture/coordination-primitive.md)

恢复报告按岗位区分 resumed、fresh、awaiting-decision、failed 等状态；不会把新会话包装成旧会话恢复。上下文包按片段读取，岗位可保存经验文件。它提供持久工作与上下文交接基础，但这些文件不自动成为有授权、不可变版本及独立检索质量验证的公司知识库。[恢复实现说明](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/docs/as-built/architecture/lifecycle-snapshot-restore.md)、[上下文包](https://openrig.dev/docs/context)

### 当前接入限制

| 核对点 | 实际边界与为伍影响 |
| --- | --- |
| Windows | 需要 macOS/Linux 的 Node＋tmux；Windows 路线为 WSL2，原生不支持，仓库说明 WSL2 尚未纳入自动测试。见 [固定 README](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/README.md)。 |
| DSH 与 Go 模型 | 当前原生适配键含 Claude Code、Codex、Pi、Oh My Pi、Terminal、Stub，没有 DSH。Pi 可以作为模型路线的试点候选，但我们 Go/DeepSeek/GLM 接入未实测。不能因为一个 runtime 支持模型，就说整套工作流兼容。见 [RuntimeAdapter](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/packages/daemon/src/domain/runtime-adapter.ts)。 |
| 工作流 | 固定 as-built 文档明确 workflow 的 harness 语法仍只接 Claude Code/Codex；部分 lineage/closure/spawn_budget 字段只是声明、未强制。同名同版本源文件编辑可更新缓存，版本标签不是不可变内容固定。见 [工作流边界](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/docs/as-built/architecture/workflow-runtime.md)。 |
| 权限 | 执行依赖所管理 Harness 的原生权限。kernel 岗位的默认权限比普通团队宽；启动还会写 Hook、信任和工作区配置。不能把其默认姿态等同为伍已有授权；试点要用独立用户/配置，不指向当前个人配置。见 [README 的变更说明](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/README.md)、[Codex 适配器](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/packages/daemon/src/adapters/codex-runtime-adapter.ts)。 |
| 网页 | 主要操作界面为 TUI，legacy web 不是主要产品入口。已有 HTTP/MCP 控制面可评估由为伍网页适配，不是现成的“公司部门网页”替换包。见 [架构](https://openrig.dev/docs/architecture)。 |
| 费用与验收 | 上下文/供应方用量观察不等于我们的美元预算门禁、未知收据及文件/测试 seal。正式验收仍需核对实际命令和对应产物；不能用 queue done 代替经理通过。 |

### 文件与数据增长

它已有明确分层：终态任务的旧 transition 事务归档，活动前沿保留；watchdog 与 usage sample 属于遥测，按保留期分批删除。当前默认 transition 30 天归档、遥测 14 天清理。这是可以复用的容量治理思路，迁移前需匹配为伍不可丢失账本的保留要求。[retention 源码](https://github.com/mvschwarz/openrig/blob/5fab9ae8025e0a0279c988aaee55d01dbac4d709/packages/daemon/src/domain/queue-retention.ts)

上述数据库治理、agent-image prune 不等于自动解决 `node_modules`、构建中间文件、测试截图、旧 Git 工作区和员工临时文件增长。工作区/缓存/交付物仍需分别计量、保留和回收；不能因支持 cleanup 相关命令就宣称文件容量已受控。

**建议〔工程判断〕：** 将其列入部门管理层的优先试点，而不先自研另一套持久岗位、交接队列和上下文移交。先比较“直接采用 OpenRig 管理层＋适配网页/员工运行器”与“保留现有 DSH 执行并只复用其成熟组件”的实际成本；试点决定归属，不能让两套系统同时自主派发同一个任务。

## 4. EliasOenal/OpenRig：Linux 企业运行时，当前不作为整体替换

它按 Unix 用户和会话隔离，Firejail 建立私有目录、网络 namespace、seccomp 及资源边界；实现使用 Linux cgroup v2、iptables、Unix socket，并有 privileged 容器部署路线。适合公司 Linux 服务器评估，Windows 网页可以作为客户端；不是原生 Windows 执行器。[沙箱源码](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/sandbox.py)

模型接口实际使用 OpenAI 兼容 Chat Completions，支持流式工具调用和 reasoning_content；DeepSeek/GLM 有适配可能，维护者声明测试的是 vLLM/llama.cpp。上下文容量自动发现依赖 `/models` 的扩展，普通中转站可能需显式配置；本轮没有模型实测。[模型客户端](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/llm.py)、[Agent](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/agent.py)

有网页、会话事件、SSE、用户/管理员控制和调度/资源管理；这不证明满足为伍的部门、DAG、独立 QA/经理验收及费用门禁。公开主分支目前为首次发布单提交，测试文件和 Ubuntu CI 的存在也不等于我们的真实验收已通过。[项目](https://github.com/EliasOenal/OpenRig)、[CI](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/.github/workflows/test.yml)

源码发现的关键不匹配：

- Supervisor RPC 的通用断连/超时重试也用于 execute，未见请求 ID 去重；未知 shell 结果有重复执行风险。[supervisor](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/supervisor.py)
- 工具秘密虽加密存储，运行时会写 env/files 并 source 到会话 shell，可由 shell 读取；这不是可信侧不可见凭据代理。会话 retry 会删除失败轮次事件后重放，终态 TTL 默认 7 天，清理可删除会话、事件及工作目录。[session](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/session.py)
- 用户 persistence 采用目录复制后替换；多个会话写回可能覆盖，未见这一层有文件版本冲突保护。[持久目录写回](https://github.com/EliasOenal/OpenRig/blob/8bb61d30cc8baea9df2a0a54781a70b128af8f61/src/openrig/sandbox.py)

这些是具体实现差异，并非所有场景不可用。可参考其 Linux 多用户沙箱和网络分段；若抽取为工具后端，必须先适配请求去重、结果未知暂停、不可变历史和文件 CAS。以现成独立隔离产品优先的原则，目前先试 OpenShell，避免同时维护两套沙箱。

## 5. 对我们之前问题的覆盖

| 用户关心的问题 | 可优先复用 | 仍需为伍正式定义和验证 |
| --- | --- | --- |
| 公司组织搬到 Agent | OpenRig 的持久岗位、pod、交接队列 | 部门职责、业务授权、网页自主操作、当前 DSH/Go 路线 |
| 长时间上下文 | OpenRig 上下文包、handover、snapshot；沿用 DSH 已安装摘要组件 | 来源、矛盾知识、合同、预算和推理协议状态在多次压缩/恢复后仍正确 |
| OS 沙箱 | OpenShell；Linux 多用户隔离参考另一 OpenRig | Windows/WSL 实际隔离、工具/网络授权、取消、产物回收与未知操作 |
| Token 与费用 | 已有用量观察和唤醒机制 | 单一费用账本、原额度、未知预留、后台收费核对；不把监控样本当账单 |
| 公司知识与经验 | OpenRig 按需 context pack 与岗位经验文件 | 按员工授权检索、固定 SHA/版本、经验来源与审核，不直接覆盖公司正式知识 |
| 文件与数据增长 | OpenRig 分层归档、批处理遥测清理 | 员工临时目录、依赖缓存、旧产物、备份和容量硬上限 |
| 监管与 Eval | OpenRig 的岗位/队列/恢复状态；OpenShell 安全日志 | 真实业务成功标准、独立评分及 Eval 回归；继续结合 [Waku 调研](waku-agent-observability-eval-2026-10-08.md) |

## 6. 下一步试点计划（本轮未执行）

1. **OpenShell 隔离后端先试。** 在隔离的 WSL2/Linux 环境、独立测试目录，用本地命令验证允许文件、越界/网络拒绝、取消、出口、产物哈希往返及重启。预检失败、跳过和实际执行分别记录；不用真实模型冒充基础隔离测试。
2. **OpenRig 小型长期研发队试点。** 独立配置/数据/仓库副本，经理、开发、QA 三岗位；先验证事件产生工作、排队/交接、待决策、会话移交和重启。再验证 DSH adapter 或 Pi/Go 路线，特别记录其 workflow 当前仅 Claude/Codex 的限制；不覆盖原 Codex/Claude 用户配置。
3. **决定唯一派发权与账本归属。** 选择 OpenRig 管理层或现有协调器作为唯一派发者；外部状态只作投影时不可自行续跑。预算、费用及正式验收要在唯一门禁核对，不因队列关闭释放未知费用。
4. **再做完整业务验证。** 新增付费验证先按现有授权预算准入；仍需真实员工开发、独立测试、经理验收、未知操作处理和受控重启，不以本轮静态调研代替。

这次调研完成了身份、固定版本、源码边界和复用判断。安装、Windows 兼容、模型路线、资源消耗、长时间稳定性及实际隔离全部标为未实测。原研究背景见 [长期研发部门调研](long-running-rd-reuse-2026-10-07.md)，当前交付状态见 [README](../../README.md)。
