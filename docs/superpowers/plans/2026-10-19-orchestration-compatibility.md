# 编排模板与现有 DAG 兼容接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将七种编排保存为可检查、有版本的规划模板，接入现有方案预览和批准门禁，证明它们不会另起执行器或破坏旧项目。

**Architecture:** 保留 DSH AgentTeams 0.1.20、Harness 0.1.5-rc.1、现有 Plan/DAG 和运行恢复。内置模板使用只增版本的静态注册表，实例保存模板引用与冻结绑定；服务端校验绑定和实际 DAG 一致，批准时再次核验可执行状态。只完成设计中的本地兼容阶段，不把离线合同测试当作真实员工验收。

**Tech Stack:** 现有 TypeScript、Zod、Node test、React、PGlite 隔离测试；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-19-orchestration-pattern-library-design.md`

## Global Constraints

- 七类为 pipeline、parallel、router、orchestrator_workers、review_repair、map_reduce、proposal_review；single 保持旧行为，不计入七类。
- 保持单一执行器、单一经理、最多 6 位员工、memberMaxDepth=0、现有金额/次数/工具/资料授权。
- 只对带新模板引用的方案要求：基础任务数 + 2 × 各独立合法返工入口的批准轮数之和 ≤ 50。每任务输入仍最多 40。
- 路由、分解、分片和提案轮次在批准前冻结。运行中不添加自主任意派生团队、条件跳过或无限循环。
- 老方案没有模板引用时保持原有校验/可读性；不能自动为旧记录补模板或声称新模板已有真实验收。
- 本轮模型调用 0、生产数据库修改 0、JJ 部署 0；不把累计预算余额当作新项目授权。
- 七模板初始仅离线验证，明确显示“待真实验收”，不能经普通批准或自动批准开始执行。之后逐个按真实证据开放，不能由模型/客户端传入状态或伪造证据。
- 不动无关未提交文件。Git 操作只选本轮精确路径；若审批服务故障，保留文件和证据，不绕过。

## Review Focus

- 旧 JSON、网页草案和历史运行缺少模板字段：仍可读且原行为不变。
- 模型捏造版本、hash、任务绑定或声明已验证：拒绝，不能静默剥离后当普通方案执行。
- 合法 DAG 但不符合所选模式（伪并行、漏分片、自我复核）：不能靠标签通过。
- 候选保存后批准直接调用 API：服务端仍阻止未经真实验收的新模板，不能仅依赖 UI。
- 安全停止后的恢复：携带原冻结元数据，不重选当前模板；旧任务合同/权限/费用校验保持。

## Task 1: 七类模板注册表、冻结绑定与兼容校验

**Files:** Create `packages/contracts/orchestration-patterns.ts`, `tests/orchestration-patterns.test.ts`; modify `packages/contracts/orchestration.ts`, `packages/contracts/index.ts`.

**Interfaces:**
- `orchestrationTemplateSchema`: 可选于原 `orchestration.template`，必须 strict；共同字段 `schemaVersion:1`、`id`（七类）、`version:1`、`definitionHash`（SHA256）。按 id 区分绑定结构，不允许客户端提交状态。
- `orchestrationPatterns`: 七个不可变 v1 定义；含 name、description、sources、适用性/限制、version、definitionHash。Hash 使用明确稳定的 JSON 定义计算，Node 测试独立核对；前端不得引入 node:crypto。
- `orchestrationPatternErrors(plan: Pick<Plan,'tasks'|'agents'|'orchestration'|'deliveryCriteria'>): string[]`：无新引用返回空；校验引用和实际结构，不重写用户任务/授权。
- `orchestrationExecutionErrors(plan: Pick<Plan,'orchestration'>): string[]`：旧方案返回空，全部当前新引用返回待真实验收原因；无用户参数可绕过。离线验证状态和实测证据不进入可变模型输入。
- `orchestrationPatternSummary(template): {name:string; version:number; status:string}`：UI 只读标签，未知引用显示不可执行。

- [ ] 先写失败测试并运行，覆盖七类至少四个代表例（28）和以下边界（至少12）：缺权限、缺输入、重复/歧义绑定、未知模式、人数上限、任务上限、并行文件冲突、环、漏独立检查、错误版本/hash、模板不能伪称可执行、旧模板缺省兼容。与既有 validatePlan 的联合测试才可覆盖权限和预算。
- [ ] 采用最少的显式绑定：pipeline 有顺序 taskIds；parallel 有独立 branchTaskIds、joinTaskId；router 有固定 routeKey 和完整 selectedTaskIds；orchestrator_workers 有 frozen workItems（id、taskId、objective）和 joinTaskId；review_repair 有 reviewTaskId（必须是合法实现审查入口、maxReworkRounds 1..2）；map_reduce 有固定 manifest（id、taskId、input path/SHA256）和 reduceTaskId；proposal_review 有恰好两组 proposalTaskId/critiqueTaskId 和 decisionTaskId。绑定均检查 ID 唯一、任务存在；所有数组有 50 上限、文本有现有风格长度限制。
- [ ] 对 pipeline 检查完整任务顺序；parallel/workers/map_reduce 检查分支互不依赖、join 等待全部分支并读取其全部输出；map_reduce 每个分片恰好一个独立任务且其 inputs 绑定该不可变输入。proposal_review 两位不同提案者、初始提案互不依赖，各有他人批评，经理等全部批评，读取提案/批评输出；不声称提示词能证明语义独立。review_repair 复用 taskContractErrors，不造返工引擎。所有新模板要求 deliveryCriteria 覆盖产出、独立检查与经理；同时仍运行旧 DAG/文件/权限校验。
- [ ] 将新校验接入 validatePlan，不改变其已有参数含义，不将 requireToolSupport 当作放行新模式的开关。新模板的布局 pattern 仍为原三种；检验 pipeline→pipeline、parallel/map_reduce/proposal_review→parallel、其余可采用 pipeline 或 parallel（不能 single）。
- [ ] 检查返工展开最坏节点数边界 46+2×2=50 通过、48+2×2=52 拒绝；老无模板方案不新加此约束。
- [ ] Run `node --import tsx --test tests/orchestration-patterns.test.ts tests/task-contracts.test.ts tests/organization-routing.test.ts`，再 `npx tsc --noEmit`，保存输出；仅提交本任务精确路径（审批受阻时保留工作树交审）。

## Task 2: 规划预览、批准门禁与原生接入证据

**Files:** Modify `apps/api/src/organization-routing.ts`, `apps/api/src/organization-chat.ts`, `apps/api/src/app.ts`, `apps/web/src/OrganizationRecommendation.tsx`; add `tests/orchestration-pattern-integration.test.ts`; extend `tests/organization-recommendation-ui.test.ts`; create `services/agent-runtime/orchestration-profile-probe.test.mjs` if installed public API supports a no-model probe; record `docs/validation/orchestration-compatibility-2026-10-19.md` and small evidence.

**Interfaces:** Consume Task 1 exports and optional `plan.orchestration.template`. Preserve existing schemaVersion:2 organization response and project snapshot orchestration field. Do not expose a new user-enabled execution bypass.

- [ ] 先补失败测试：组织候选可生成/确认七类有效预览，错误模板/hash/绑定形成明确 draftIssue，普通方案仍走旧路径；模板方案批准被拒绝且无运行记录/模型调用；直接 API 与 automatic 参数也拒绝。隔离数据库只用测试 fixture，不连接生产。
- [ ] 在原有规划请求给模型有界目录及每种绑定的例子/说明，清楚标出本轮新模式只能预览、旧模式仍可用；模型选择合适模式或说明能力缺口，不能为凑模板扩大工具/人数。不增加第二次模型请求，不每个任务注入七类全文。
- [ ] resolveOrganizationCandidate 校验新引用；preview/confirm/plan_versions 原样保留冻结引用。批准在副作用之前调用 orchestrationExecutionErrors；保存/显示预览不等于运行批准。批准快照沿用原 orchestration 字段，历史读取/恢复不得基于当前目录重新改写。
- [ ] 网页显示模式名称、版本、选择依据及“离线校验，待真实验收”；旧三标签保持原显示。模板未验证的执行错误包含下一步而不是无信息失败。覆盖 React 静态渲染；不为纯标签改动启动繁重 computer use。
- [ ] 用已装 AgentTeams 公共 profiles Config 在临时目录做无模型 create/stage/approve 探针；记录是否保留完整文件合同。若种子字段不足，使用既有公开 create_task bridge，明确不导入私有实现。探针不修改产品 Host，不开沙箱/网络/模型。
- [ ] Run Task 1 tests + UI tests；Run `node scripts/test-integration.mjs tests/orchestration-pattern-integration.test.ts tests/organization-routing-confirmation.test.ts tests/organization-chat.test.ts`；Run profile probe and related portable runtime tests as supported；Run `npm run build`。日志保存小型证据，不重复全量 suite。
- [ ] 独立评审本轮完整差异，修复重要问题；更新报告和进度、精确提交并沿用既有授权推送当前分支。报告分别列本地已验证、真实未验证、未部署。后续真实小任务/恢复逐类验收及公司模板发布生命周期另起具体计划，不在此阶段伪称完成。
