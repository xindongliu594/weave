# Weave 剩余功能复用核对与 AI 连续执行排期

日期：2026-10-29。只读盘点基线 `91050f1`，JJ 运行源码 `b37d00a`。本次没有安装组件、改变生产服务、运行付费模型或重跑测试。时间为工程估算，不是实测速度或完成保证。

## 1. 明确的排期口径

**计划交付点为 T+96 个 AI 连续执行小时。** 三个独立方向并行，公共数据库、coordinator、授权和发布接口由主线顺序集成。T 是恢复正式开发时刻；若不中断，96 小时相当于四个自然日，不按每天八小时换算。

覆盖现有单 JJ 部署的软件加固、下表限定的企业方向功能、必要工程检查与验收。不是从零重写产品，也不表示已经达到大规模多租户/高可用企业平台。预算不自动提高，只有已授权范围可以进行真实调用。

单项串行执行估计合计 72–130 小时，不能把它当作并行墙钟时间。数据恢复方向是主要依赖路径：约 24–46 小时；加上基线修复、公共接口集成与最终验证后，主路径估计约 48–72 小时。以 96 小时作为含返工余量的计划点，而不是承诺任何故障都能在上限内消除。

尚未对整个功能包做实施 spike，因此这是中等偏低置信度的排期。第一轮八小时内用真实新增改动、红绿测试和阻塞记录校准剩余时间；不以生成代码行数或人类人天作为速度依据。

## 2. 已有能力，不重新开发

- DSH `0.1.5-rc.1`、AgentTeams `0.1.20` 的员工会话、工具注册、Skill registry/provider/lazy load、checkpoint/flush；现有 DAG、批准快照、文件 CAS 和费用账本继续复用。
- OpenShell `0.1.2` 已接入并有既往真实探针；不能把“已接沙箱”与“新企业 task profile 已开放”混为一谈。
- `openid-client@6.8.8`、session 和身份/部门权限表、审计 outbox 已有；运行新效果前的当前授权检查已有。
- 知识固定版本、来源范围、候选 CAS、人工审核发布、员工按授权发现已有；SkillX 提炼有隔离试验和脚本，不是零基础。
- Promptfoo `0.124.1` 的固定离线五例、断言、报告与发布门禁已有；真实执行 provider 和七维核心 32 例尚未完成。
- 最新 JJ 定向检查 120/120、14 项只读 HTTP、2,500 文件停机副本与迁移比对证据保留；没有据此声明全部 191 份 TypeScript / 86 份 runtime 文件或最终真实业务全部通过。

## 3. 逐项复用、缺口与时间

小时包含该项必要实现和定向验证，不是仅写代码。跨项共用的最终集成统一列最后一行；经验项已经扣除部分共用验收，避免原分域估计直接重复相加。

| 工作包 | 可以沿用或复用什么 | 必须由为伍补齐什么 | 单方向 AI 小时估计 |
| --- | --- | --- | ---: |
| 完整企业备份 | 旧加密包、恢复前档案、SQL 回执、PGlite dump/load；原生 PG 沿用其备份工具 | 格式版本、身份/授权/审计/操作历史覆盖、失效会话处理、文件与库的共同边界、隔离恢复入口 | 12–22 |
| 企业 task 与 checkpoint 收口 | 既有步骤恢复、DSH/AgentTeams checkpoint、文件锁、来源 codec、CAS | 可信来源签发、全部写入者的保存/排空、初始化、正确版本恢复和备份 carrier；保留后续已发生费用及副作用 | 12–24 |
| 长时间部门任务 | 计划/去重表、运行租约、部门互斥、预算/权限检查，systemd 周期唤醒；pg-boss 是可比较候选 | 预批准自动接活、持久退避/next-attempt、重启后的恢复资格、停止和漏触发处理 | 6–10 |
| 数据与临时文件治理 | 已有盘点、配额、完成副本清理、日志压缩、preview/revalidate；systemd timer/tmpfiles | 保留策略执行、明确归属的缓存/临时目录、失败及未知回执、JJ 周期维护配置；不按年龄通配删除交付与收据 | 4–7 |
| 外部工具结果核对 | 原 DSH 注册、效果合同、intent/operation/receipt、审计与恢复门禁 | 先接一个具有稳定对象 ID 的真实工具的可信 query；有实际逆操作才接独立授权的补偿 | 6–10 |
| 私有经验到 Skill 闭环 | 现有 SkillX 适配、知识版本/候选审核、DSH 按需加载、私有包及停用 | 持久提炼 API、候选/样本/运行证据绑定、发布和撤回、员工选用固定版本、复用结果反馈 | 10–18 |
| 企业成员与权限收尾 | 现有 OIDC、管理页、部门角色、资源授权、每次效果前撤权检查 | 普通成员/审计员业务页面开放、错误与空态、真实 IdP 配置验证、独立连接撤权竞争矩阵 | 4–7 |
| 核心评测与观测导出 | 固定 Promptfoo、可选 AgentEvals 轨迹指标、现有 trace/audit、OpenTelemetry 导出器 | 七维核心 32 例的输入/独立答案/评分、受授权真实执行桥、版本绑定；脱敏/限量 OTLP 接线和失效可见性 | 8–14 |
| 旧回归与公共联调交付 | 原 test/build/部署入口、systemd、既有故障注入与数据保护 | 剩余员工历史/执行策略/备份夹具等逐项修复；跨平台和原生 PG、真实小任务/重启恢复、有限浏览器抽查、最终部署与报告 | 10–18 |
| 合计（串行，非并行墙钟） | | | **72–130** |

企业 task 的 12–24 小时内部有顺序依赖：全部 writer/排空 3–6 → 可信来源签发 3–6 → 初始化及未知提交核对 3–6 → 恢复消费者与 carrier 3–6。carrier 编解码只在这里计时；备份行负责包格式、完整覆盖和隔离导入。新链路共用的原生/JJ 最终验收只计最后一行，不再加分域报告的 6–10 小时。

### 真正需要从零写的是什么

没有计划从零开发沙箱、数据库、身份协议、插件引擎、Skill 加载器、通用队列或评测引擎。新增的是为伍特有的业务合同和连接：

1. 完整备份的业务格式、来源与恢复一致性。
2. 长期运行的预授权/预算/退避/恢复资格规则。
3. 某个具体外部工具的核对合同，而不是通用副作用魔法。
4. 经验候选经证据评测与批准后成为私有能力的发布状态。
5. 本项目的评测题、参考证据与评分约束。

这些不是五套新框架；其代码、接线和必要验证已计在逐项时间内。不再给一个没有实验依据的“纯编码几小时”数字并将安全、迁移、兼容和真实验证排除在交付之外。

## 4. 本次官方资料核对后的选择

| 方案 | 结论与来源 |
| --- | --- |
| DSH 原能力 | 保留当前固定版本并复用注册、Skill 和 checkpoint。上游 master 只能作参考，不能据此声称当前已装能力。[checkpoint](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/session/session-checkpoint-policy)、[Skill](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/skill/skill)、[插件管理](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/boot/plugin-manager) |
| PGlite | 本地固定 `0.5.8` 已有 dumpDataDir/loadDataDir，复用其数据库机制；它不自动备份外部交付、密钥或原生 PG。[API](https://pglite.dev/docs/api) |
| pg-boss | 当前官方 12.38.0 已支持 `backend:'pglite'`/`fromPglite`。不能再说一概不兼容。但上游测试 PGlite 依赖为 `^0.5.9`，本项目 `0.5.8` 未实测；是否省工时须做 1–2 小时有上限的隔离比较。已有 coordinator 值得保留，不能只为装新库迁移。[后端文档](https://pgboss.io/database-backends#pglite-embedded)、[包声明](https://github.com/timgit/pg-boss/blob/master/package.json) |
| systemd | 周期唤醒和纯缓存维护可直接配置；业务授权/预算/外部效果不由 timer 解决。`Persistent=true` 可补停机时漏过的日历触发。[timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html)、[tmpfiles](https://www.freedesktop.org/software/systemd/man/latest/tmpfiles.d.html) |
| 身份 | 继续已安装的 openid-client 6.8.8，复用 OIDC 客户端，不自己写认证协议。[官方实现](https://github.com/panva/openid-client) |
| 提炼 | 继续已适配的 SkillX 固定 `b0047c8`，不另建提炼引擎。[固定管线](https://raw.githubusercontent.com/zjunlp/SkillX/b0047c848dbbcf019363d6d56eef8c558f69aefc/pipeline.py) |
| ReMe / Hermes / MemOS | ReMe 当前 DSH 插件已为 0.1.3，但 peer 要求 Cordis ~4.0.4 等及 DSH ^0.1.7-rc.2 起，不能直接强装进 4.0.2/0.1.5-rc.1。Hermes 是完整运行器，借鉴标准 Skill 生成修订；MemOS 可借鉴提炼组件，本轮不引入第二套主存。[ReMe 包声明](https://raw.githubusercontent.com/agentscope-ai/ReMe/main/integrations/dsh/package.json)、[Hermes Skill](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/docs/user-guide/features/skills.md)、[MemOS 固定组件](https://raw.githubusercontent.com/MemTensor/MemOS/a7367d07e55db61099f7b4e2c1108bc5831a24f3/apps/memos-local-plugin/core/skill/README.md) |
| 评测 | 固定 Promptfoo 的自定义断言/报告继续复用；AgentEvals 是轨迹指标候选，不能用无序工具集代替 DAG 依赖正确性。本项目案例和可信执行桥仍须自己接。[Promptfoo](https://www.promptfoo.dev/docs/configuration/expected-outputs/)、[AgentEvals](https://github.com/langchain-ai/agentevals) |
| 观测 | 复用 OpenTelemetry JS 导出机制；当前 observability.ts 仍 configured:false。补应用映射/脱敏/队列，不自建遥测平台。[OTel](https://opentelemetry.io/docs/languages/js/exporters/) |

## 5. 当前证据位置

- `apps/api/src/execution-policy.ts:23`：企业 task 执行/恢复实际关闭，不仅是文档未更新。
- `apps/api/src/backup-destination.ts:4`、`backup.ts:58`：旧业务包遇身份/审计等依赖会主动拒绝；不移除保护冒充完整备份。
- `apps/desktop/openshell-executor.cjs:513`：retireStorage 明确拒绝固定版本不支持的安全回收。
- `apps/api/src/automation-learning.ts:20`、`:50`：已有持久计划/去重派发，当前生成 DRAFT 而非自行获批运行；`:199` 是已有候选审核发布。
- `apps/api/src/tool-operations.ts:123`：当前生产效果接线范围是内建 read/workspace/free；合同中的 query/compensation 字段不是外部实现。
- `services/agent-runtime/storage-retention.mjs:13`：保留建议并不等于自动删除；`storage-governance.mjs`、API `storage-lifecycle.ts` 已有一部分真实清理和核对。
- `services/agent-runtime/approved-skills.mjs:24`：已复用 DSH registry/provider 及员工范围、版本/哈希加载。
- `apps/api/src/knowledge-reuse.ts:64`：企业模式自动经验候选因可信授权未绑定而跳过；不能绕过这个检查。
- `apps/web/src/IdentityGate.tsx:9`、`IdentityManagement.tsx:66`：人员管理已有，成员工作空间仍未开放。
- `apps/api/src/run-current-authority.ts:22`：模型/工具/知识/重试/恢复前当前授权检查已有。
- `apps/api/src/observability.ts:25`：观测导出当前未配置。
- `tools/evaluations/weiwu-provider.mjs:5`、`:13`：现为固定五例 replay，execute 拒绝；不能说七维真实评测已经运行。

## 6. 时间节点和完成标准

- **T+8 小时**：余下失败基线、分工与共享文件归属、兼容试验结果、剩余时间校准；已有成果保全。
- **T+24 小时**：优先交付现有单人主流程稳定批次、可重复的停机完整备份与隔离恢复步骤；企业 task/自动回收未满足条件时继续明确关闭，不包装成全量完成。
- **T+72 小时**：目标为上表可控功能代码、接口/组件与定向故障回归收口；三线合并。实际未通过项单列。
- **T+96 小时**：目标为完整联调、核心 32 例分层报告、获授权的小任务正常/重启恢复证据、JJ 部署和简明使用说明。计划覆盖 12–24 小时低成本的调度/存储观察，可与后半程开发并行；不冒充多日真实付费业务耐久性。

企业 task 只有在全部 writer 排空、可信来源、初始化、carrier、独立后端竞争和 JJ 物理验收都通过后才可开放；任何一项没有通过，就继续关闭并在 T+96 报告中交付受限版本及未完成项，不能称全部企业功能完成，更不能因到时移除门禁。96 小时是有依据的计划目标，不是用固定时间代替验收。

验收优先 HTTP、功能代码、数据库及独立进程；浏览器只查必要主流程与布局。真实模型、合成模型、接口、组件、物理沙箱证据分开计数。核心 32 例不意味着 32 次都要付费；确定事实优先代码断言，必要真实案例必须有实际授权和收据。

外部等待另记：JJ 唤醒/SSH、模型服务/额度、真实 IdP 配置、所需管理员权限。固定 OpenShell 0.1.2 的条件删除限制属于已知产品限制：本轮安全回收先覆盖可证明归属的日志/缓存/副本，不能承诺自动回收全部沙箱。发现只能由上游/供应商改变的阻塞时，记录并继续独立工作，不能靠放松授权或未知结果保护达成时限。

不在这 96 小时范围：任意第三方工具的自动补偿、自动生成任意 MCP/插件、自主演化、160 例完整盲测与多模型统计、大规模多租户/高可用/跨区域灾备，以及承诺任意 DSH 网页插件零适配。这些另立范围，不能称已完成。
