# C1 固定工具来源盘点 Implementation Plan

> **For agentic workers:** Use executing-plans and test-driven-development. 已授权在当前 worktree 执行；不提交，不改共享文件。

**Goal:** 在批准前从真实固定注册代码取得最终定义，提供可供既有合同 service 消费的服务端来源候选。
**Architecture:** 在有界、独立的内存 worker 中挂固定 Cordis/DSH 服务，复用原产品/native/能力注册函数及官方 Skill/AgentTeams 插件。没有 adapter、agent、session persistence、archive、业务 run 或 execute；不加载 native bundle 代码。校验实际部署源码及固定包发布指纹，来源 adapter 只接受服务端目录 key。Native 复用 readNativeBundle 校验，但效果保持 unknown；MCP 具体目标绑定未接，不提供可准入候选。
**Tech Stack:** 固定 Cordis 4.0.2、DSH 0.1.5-rc.1、AgentTeams 0.1.20，现有 Node worker_threads/crypto/pg 类型，无依赖安装。
**Spec:** `docs/superpowers/plans/2026-10-20-tool-effect-integration.md` Task 1/3；`2026-10-24-tool-effect-contract-authority.md`。

## 所有权与接口

- 新增且独占 `services/agent-runtime/runtime-tool-inventory.mjs/.d.mts/.test.mjs`、`apps/api/src/tool-effect-sources.ts`、`tests/tool-effect-sources.test.ts` 和本计划。
- 不改 app、router catalog、contract service、Host、product/native wrappers、UI 或批准事务。本片不全面启用 effectContractVersion。
- `inspectRuntimeToolInventory({variant:'container'|'local'|'demo',nativeBindings?,includeRecovery?})` 返回不可变描述性目录、固定包/源码指纹与正常释放结果；不暴露 Context、工具函数或自定义加载回调。worker 有硬超时，消息/文件数/字节数受限。
- `createToolEffectSources({variant,nativeRoot?})` 返回 `listBuiltinCandidates()` 与兼容既有 `ToolEffectBindingResolver` 的 `resolveBinding(client,key)`。来源固定后每次复核发布指纹；变化要求重建/重新审核，不让同一服务实例漂移到新代码。
- 每个 source 实例只构造一次 builtin 内存 Host；之后每个有效 key 只复验发布文件。没有跨调用批次缓存、ALS 或额外事务生命周期。记录实际多 key 耗时，生产 snapshot 批量校验留待实际集成。
- Builtin namespace 区分真实 variant；employee 本地工具使用 employee registry binding，其他使用 coordinator binding。本片所有候选 effect/cost 保持 unknown，retry never：磁盘发布指纹不能证明 Host 中任意注入的 queryKnowledge/Skill provider/sandbox/外部回调语义。来源指纹覆盖本应用源码、锁文件及实际固定 DSH 包，但不是全依赖闭包或 callback 身份证明；必须由后续生产组合补完整 source attestation 后才可给出 read/free。
- Native namespace 包含插件 namespace 与完整 manifest ID；来源行 FOR SHARE 后复用 readNativeBundle 校验固定文件，盘点现有 native wrapper；未核验插件语义保持 effect/cost unknown、retry never。未配置 nativeRoot 不默认读生产目录。
- MCP namespace 返回不可用；没有以外壳或 annotations 代表具体远端目标审核。

## 实施与验收

- [x] 写 inventory RED：实际原注册定义摘要吻合，local/container/demo 差异，Skill/14 协作工具可盘点，无模型适配器/agent/persistence/execute，正常 disposal；调用方不能注入 loader/路径/业务对象；非法或重复 native manifest、超大输入拒绝。
- [x] 最小实现独立内存盘点；失败时释放或终止 worker，固定包版本不符拒绝。重复盘点不串状态，不创建业务档案。
- [x] 写 source RED：从实际目录生成固定候选，源码指纹非手填版本，未知工具/MCP/伪造 namespace 拒绝；native 原 bundle 验证、停用/篡改拒绝、旧固定版本保留且 unknown；source adapter 与真实合同 service 可组合读取候选，绝不自动标 reviewed。
- [x] 实现 adapter；不读生产 DB，SQL 来源查询使用调用方 client，不另开事务、不持连接等待网络；native 行锁在合同锁之前。
- [x] 运行定向 runtime/API 测试和类型检查，保存 RED/GREEN、SHA、真实命令与限制到 `.superpowers/sdd/2026-10-23-enterprise-plugin-completion/tool-effect-source-*`，停止编辑供父复审。最终 inventory 5/5、隔离 PGlite source 5/5，tsc 无诊断；26 个 key 逐次复验实测 7685ms。

## 已完成的只读依据

前置内存探测已验证原 installProductTools 的 8 个最终注册工具以及三种 filesystem 描述摘要差异；正常官方插件注入可取得 skill 与 14 个 AgentTeams 工具，0 adapters、0 agents、无 persistence。固定源码为 `node_modules/@deepseek-ai/dsh-tools/lib/index.js` register/get/guard，以及 `@nanmicoder/dsh-agent-teams/lib/index.js` 的标准 inject；不裸调缺依赖的 registerAgentTeamsTools。

已核对的官方市场只提供索引/安装来源信息，user-approval 是逐次许可，不能提供为伍持久审核/撤权语义。本片复用其已有注册机制，新增的只是来源适配层。该调研在前一轮完成，本片不访问外网。
