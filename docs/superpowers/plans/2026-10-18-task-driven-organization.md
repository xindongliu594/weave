# Task-driven Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 用户通过需求对话获得可调整的团队与协作建议，确认后按明确交付标准进入现有执行和验收链。

**Architecture:** 在既有组织对话中加入获授权人员目录和 V2 候选，后端解析为原有 Plan；唯一执行图仍是 `Plan.tasks`。复用 DSH AgentTeams、跨部门来源校验、确认事务、质量合同与恢复记录，只补自动选人和需求到验收的映射。

**Tech Stack:** TypeScript、Zod 4、React 19、Express 5、PostgreSQL/PGlite；DSH `0.1.5-rc.1`、Cordis `4.0.2`、AgentTeams `0.1.20`。本期不新增框架依赖。

**Spec:** [设计与选型依据](../specs/2026-10-18-task-driven-organization.md)。本计划只实施其第一段；模板发布检索、临时组织和大范围运行中重规划另立计划。

## Global Constraints

- 一个项目恰好 1 位经理、最多 6 位员工（含经理）、最多 50 个计划任务、子团队深度 0；返工轮数仍受既有 0～2 及实际策略约束。
- 现有金额、次数、权限、未知费用预留和执行收据不放宽；普通组织对话账务方式保持。
- 不修改已有部门员工名单来实现项目选人；不让模型生成身份来源或授权；旧 V1 草案与旧项目可继续打开。
- 用户确认前只有对话/预览记录，不保存正式部门、员工或项目，不启动执行。
- `Plan.tasks` 是唯一可执行图；完整合同仍经 `stageApprovedTeam()` 桥接，保留 `lockPlan`。
- JJ 执行产品、工具与测试，大模型走已保存 API。本轮文档不授权新付费验收。

## Review Focus

- 推荐后部门被编辑或归档：确认拒绝陈旧草案，已有项目不受影响（Task 3）。
- 需求讨论从“新部门”切换成“已有部门”：网页草案类型与确认动作一致，不能误编辑原部门（Tasks 2、4）。
- 候选声称有某员工/工具，但目录与实际授权不同：服务端重建并拒绝，不接受客户端快照（Tasks 2、3）。
- 新字段被 Zod 或保存/恢复路径静默丢弃：往返序列化和恢复后内容一致（Tasks 1、5）。
- 模型将一条需求笼统写成“已完成”或用旧文件检查：机械证据不足不能通过，内容判断必须有检查者（Tasks 1、5）。

## Task 1：版本化候选与交付标准合同

**Files:** 新建 `packages/contracts/orchestration.ts`、`tests/orchestration-contracts.test.ts`；修改 `packages/contracts/organization.ts`、`packages/contracts/index.ts`、`packages/contracts/task-contracts.mjs` 及相应类型声明。

**Interfaces:** `organizationCandidateV2Schema`、`OrganizationCandidateV2` 按 spec 定义 target 判别联合；`orchestrationSchema`、`deliveryCriterionSchema` 作为 Plan 可选扩展；`deliveryCriteriaErrors(plan: Plan): string[]` 负责新映射校验。避免 index 与 orchestration 运行时循环依赖：基础字段 schema 不反向导入 Plan，校验使用 type-only 或结构类型。

- [ ] 写 `legacy_plan_roundtrip`：旧 Plan 解析结果不新增伪造字段；`v2_roundtrip`：候选及 Plan 的两项新字段序列化后保持；所有 V2 必须有非空 deliveryCriteria，引用不能重复或悬空。
- [ ] 写 `criterion_dependency_and_identity`：检查任务须在依赖上等待所有产出；independent=true 时检查者不能是任一生产者；criterion index 必须存在；失败提示包含需求 ID 与任务 ID。沿用原循环/写冲突校验，不另建拓扑实现。
- [ ] 运行 `node --import tsx --test tests/orchestration-contracts.test.ts`，记录新断言失败；实现最小 schema 和校验，在 `validatePlan` 合并错误。
- [ ] 运行上述测试及 `tests/task-contracts.test.ts`、`tests/planning-acceptance.test.ts`；通过后提交本任务限定文件。

## Task 2：在原对话中推荐组织和人员

**Files:** 新建 `apps/api/src/organization-routing.ts`、`tests/organization-routing.test.ts`；修改 `apps/api/src/organization-chat.ts`、`apps/api/src/organization-task-planning.ts`、`apps/api/src/collaboration.ts`、`tests/collaboration.test.ts`、`tests/organization-chat.test.ts`。

**Interfaces:**
- `loadOrganizationCatalog(db, policy): Promise<OrganizationCatalog>`：定义并返回服务器侧、受既有可见性与 policy 约束的部门/员工摘要；无凭据、无知识正文。输入人数/模型/工具约束复用 Policy。
- `resolveOrganizationCandidate(candidate: OrganizationCandidateV2, policy: Policy, db): Promise<ResolvedOrganizationDraft>`：输出 `{kind:'organization-v2', candidate, plan:Plan, sourceDepartmentVersions:[{id,version}]}`。existing 分支只从实时来源构造 Agent；new 分支保持原无隐式授权逻辑。
- `buildProjectTeam(primary,selections,db,primaryAgentIds?:string[])`：原三参数调用行为保持；传入子集必须含原经理、无重复/不存在 ID，合计不超过 6 人。

- [ ] 写三类需求的受控候选测试：simple/pipeline/parallel 均能变成合法 Plan；相同模式也可有不同 DAG。测试新部门/已有部门在多轮切换时 previous draft 不混用身份。
- [ ] 写不可信模型输出测试：伪造 source 字段、未授权部门、已归档员工、人员过多、无经理、授权工具缺口全部给可继续对话的 draftIssue，不创建业务对象；正常文字回复仍显示。
- [ ] 运行新测试确认失败，实现有界目录与原规划 prompt 的联合输入。先用 policy/可见性过滤，再按相关信息裁剪目录；返回 catalogTruncated 标志，截断不等于“公司不存在其他部门”。不固定增加一次路由模型调用。
- [ ] 扩展原 response candidate 解析支持 V1/V2；为新客户端使用 V2，保持原多轮会话、未生成/失败/正式草案状态和费用路径。保留 V1 原有 schema，不让其所有调用方突然收到不兼容 union。
- [ ] 运行纯 routing 单测；数据库用 `node scripts/test-integration.mjs tests/collaboration.test.ts tests/organization-chat.test.ts`，不直连生产数据库。通过后提交本任务限定文件。

## Task 3：确认时安全创建项目，保持部门独立

**Files:** 新建 `apps/api/src/organization-confirmation.ts`、`tests/organization-routing-confirmation.test.ts`；修改 `apps/api/src/product.ts`、`apps/api/src/app.ts` 的公共项目构造逻辑（仅提取重复逻辑，不改旧 API 语义）。

**Interfaces:** 在 productRouter 增加 `POST /organizations/previews/:id/confirm`，请求 `{previewVersion:number}`，仅接受服务端存储的 organization-v2 草案；返回原 `{departmentId,projectId,departmentVersion,projectVersion,existing}` 结构。previewVersion 放在新草案 data，初始 1；每次内容修订生成新 preview ID，旧候选标记 supersededBy，不允许确认旧需求。

`confirmOrganizationDraft(client, previewId, previewVersion): Promise<OrganizationConfirmation>`：在事务内锁定预览及来源部门，重建人员、重新校验 Plan/Policy/版本，复用现有项目保存、日志和费用归属逻辑。V1 的 `/organizations` 和已有“更新部门/项目”接口保留。

- [ ] 写 `existing_team_does_not_edit_department`：选择部分主部门员工加一位借用员工只产生一个项目，原部门/员工 JSON 与版本完全不变；snapshot 保存实际参与部门版本和来源。
- [ ] 写失效/竞态测试：先推荐后撤权/归档/改员工或新需求替代旧草案，确认返回冲突且零业务写入；双击及两个并发确认只产生一个项目。按现有账务锁顺序取锁，参与部门按 ID 排序。
- [ ] 写 V1 创建/更新兼容测试及 V2 new 流程；无确认不能保存正式团队。先运行隔离回归观察失败，再实现确认服务；客户端不得直接提交改过的 Plan 替换预览。
- [ ] 运行 `node scripts/test-integration.mjs tests/organization-routing-confirmation.test.ts tests/organization-update.test.ts tests/collaboration.test.ts`。确认新字段进入原批准快照，而执行仍需现有批准门禁。通过后提交本任务限定文件。

## Task 4：网页呈现一个可理解、可修改的方案

**Files:** 修改 `apps/web/src/OrganizationChat.tsx`、`apps/web/src/OrganizationCenter.tsx`、`apps/web/src/organization-draft.ts`、`apps/web/src/ProjectPlanning.tsx`；按现有组件组织新增 `apps/web/src/OrganizationRecommendation.tsx`；测试 `tests/organization-draft.test.ts`、新增 `tests/organization-recommendation-ui.test.ts`。

**Interfaces:** `OrganizationRecommendation` 读取服务端草案，展示组织来源、理由、任务关系、逐条交付标准与检查者；将继续讨论交回原聊天，将确认交给 Task 3 接口。使用现有 API/错误处理风格，不引入新状态管理库。

- [ ] 写展示与动作测试：无候选显示讨论；无效候选显示原因且不能确认；正式草案显示“已有部门/新部门”和来源、人数、协作理由、依赖与验收。不要把模式标签当历史模板命中。
- [ ] 写多轮修改和旧候选测试：新的要求到达后旧方案不能被误确认；existing 候选按钮为“确认方案并创建项目”，绝不调用旧部门更新操作。
- [ ] 实现最小页面连接；依赖展示可沿用已有 DAG 或简洁列表，不新增图编辑引擎。权限/预算缺口直达已有配置入口，不能自动勾选扩大权限。
- [ ] 跑相关前端测试和 `npm run build`；在可用浏览器完成一次无付费的草案切换、过期提示和双击确认验证。保存最少必要截图，通过后提交本任务限定文件。

## Task 5：质量、恢复和真实小任务验收

**Files:** 修改 `apps/api/src/run-acceptance-evidence.ts`、`apps/api/src/execution-prompt.ts`、`packages/contracts/goal-contract.mjs` 及 `packages/contracts/goal-contract.d.mts`（如需）；核对 `services/agent-runtime/handoff.mjs` ID 映射；扩展 `tests/acceptance-evidence.test.ts`、`tests/goal-contract.test.ts` 与相关 runtime 测试；新增 `docs/validation/task-driven-organization-acceptance.md`。

**Interfaces:** 在现有验收证据聚合中按 deliveryCriteria 展示 `{criterionId,status:'passed'|'failed'|'unverified',evidenceRefs}`，必须来自当前产物/检查记录。沿用批准快照与原始任务 ID；若运行时需要映射新引用，则通过 handoff 原有 ID map 单次映射，不创建第二份图。

- [ ] 写正反例：缺必需交付、坏文件、检查命令失败、旧 hash、作者自验及模型口头通过都无法冒充成功；业务语义检查由指定检查者的有据结论承担。未验证项阻止项目自动显示全部通过。
- [ ] 写新字段保存/读取/批准/恢复一致性测试；中断后目标、人员来源和 DAG 不重规划，已完成节点不重跑，费用与未知操作核对沿用既有机制。覆盖原生返工新增节点后需求映射如何跟随合法的修复/复查结果，不能永远指向已失败的旧检查。
- [ ] 运行相关合同/API/运行时回归、`npx tsc --noEmit`、`npm run build`。运行时临时目录使用受控工作区；出现环境阻塞单独记录，不循环重复同一路径。
- [ ] 先整理真实验收所需项目、预算与现有授权对应关系；不足授权才提出具体差额。获适用授权后，在 JJ 用现有可用插件完成一个小任务，员工生成产物、独立检查与经理验收；使用同一批准方案验证一次受控重启。
- [ ] 对三类小需求做真实规划质量抽检，记录理由合理性、依赖正确性、权限违规率与验收覆盖，不能用固定响应代替。可复用其中已走真实规划的执行案例，避免额外重复调用。
- [ ] 报告区分本地协议测试与真实模型证据，写明运行 ID、版本、交付文件、检查输出、Token/费用、截图及未通过项；通过后按已有发布流程交付，才开始模板发布检索的第二段计划。

## 本轮进度与后续入口

- 已完成：固定版本/现有代码核对、选择复用方案、第一段设计与文件级计划。
- 设计独立只读 builder check：未发现必须补充的阻塞问题。合同与规划验收现有纯单元回归 12/12 通过，详见[本轮核对记录](../../validation/task-driven-organization-design-check-2026-10-18.md)；不代表新功能通过验收。
- 2026-10-18 实施进度：Tasks 1–4 已实现并完成本地接口/网页验证；Task 5 的质量门禁及本地回归通过，新版本已发布 JJ 并通过 13 项 Linux 复核；新增真实规划/执行/重启验收待本轮费用分配确认。详见 docs/validation/task-driven-organization-acceptance.md。
- 已有 Cortex 隔离试验保留，不重复跑同一路线，也不当作本功能验收通过。
- 本地集成复核遇数据库连接和 Windows 临时目录限制，属于待处理的测试环境问题；不据此更改生产授权或宣称产品失败。

实施从 Task 1 开始；第一段完成后再编写模板发布/检索的独立计划，避免把组织推荐、知识发布和任意运行时重规划绑成一次大改造。
