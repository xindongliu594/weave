# 经验发布与再次选用：复用选型

日期：2026-10-11。本轮先核对代码和官方资料，再制定验收计划；未安装依赖，未调用模型。

## 结论

沿用已接入的 DSH Skill 注册与加载工具，以及为伍现有候选审核发布。当前缺口主要是不同真实工作、经验发布、后续员工再次选用的串联证据，无需另造记忆引擎或替换执行框架。

| 实现 | 本轮核对 | 选择 |
| --- | --- | --- |
| [DSH tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/tool-skill/README.md) | 提供目录摘要与正文按需加载；官方当前文档明确正文由 Provider 管理，组件本身不固定正文版本。为伍现有 approved-skills.mjs 已补授权、固定版本和正文哈希校验。 | 继续复用当前锁定版本，不追随 master 升级。 |
| [MemOS DSH 适配](https://github.com/MemTensor/MemOS/blob/main/apps/memos-local-plugin/adapters/deepseek-harness/README.md) | 支持记忆与可选 Skill 提炼；辅助模型调用计费，默认轻量模式不启用完整演化。官方列出强制退出的捕获缺口、仅直接用户消息触发自动召回、独立 Viewer 等限制。 | 本轮不接入第二条写入链；以后需要语义提炼时隔离评估其核心。 |
| [dsh-mnemon 包清单](https://github.com/omdsh-dev/dsh-mnemon/blob/main/package.json) | 当前 peer 范围要求 DSH ^0.1.7-rc.2 或 ^0.2.0-rc.1、Cordis ^4.0.4、React ^18.2.0；项目锁定 DSH 0.1.5-rc.1，既有兼容缺口仍在。 | 不忽略 peer 检查强装，不为本轮验收升级整个 Host。 |

[DSH 社区目录](https://github.com/dshplugin-app/deepseek-harness-plugins)作为发现入口；安装和能力结论以维护者源码为准。没有认定任何插件可直接覆盖为伍的部门权限、交付封存、预算和发布规则。

## 现有接入位置

- apps/api/src/knowledge-reuse.ts：成功采用统计、不同工作去重、有界证据与自动待审候选。
- apps/api/src/automation-learning.ts：既有候选编辑、显式审核、发布幂等和发布前证据校验。
- apps/api/src/knowledge.ts / knowledge-store.ts：方法标记、资料授权、批准版本快照与正文读取。
- services/agent-runtime/approved-skills.mjs：薄权限适配，目录和加载工具继续由 DSH 提供。

## 本轮只补什么

先用隔离协议回归串起这些现有接口，检查候选发布后不会自动成为 Skill，明确发布方法后能在授权目录发现、按需读取，旧快照不随编辑变化。随后用两份不同真实任务补足原有一个成功工作，再发布候选并让一个新任务自主选用。协议夹具只能证明工程行为，不能代替真实模型验收或证明效率提升。

## 实测阻断后的预算恢复选型

退款实测发现项目总额有余量、经理节点金额不足，而现有资源规划只支持总额与节点调用次数。[dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)维护者资料主要提供会话费用、预算和套餐用量展示；本轮未找到它能直接修改为伍已封存 DAG 的未完成节点金额及批准目标边。因此复用为伍现有 resource-proposal、真实 AI 规划、goalContract/resourceApproval 和恢复器，仅补可选的未完成节点金额字段，不安装新的账本或重写预算执行器。
