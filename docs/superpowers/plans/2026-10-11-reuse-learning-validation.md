# 真实能力选用与复用沉淀 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证真实员工选用，并让不同工作中的已验收采用形成可查看的统计和待审经验候选。

**Architecture:** 复用 DSH 能力检索、正式工作记录、现有效率计算和 automation_knowledge_candidates 审核发布。统计按来源固定版本与独立工作聚合，原档案仍是证据；候选仅确定性整理采用说明与来源，不调用额外模型，不自动发布或安装工具。

**Tech Stack:** 当前 Node / TypeScript / React / PostgreSQL(PGlite 本地) / DSH，无新增依赖。

**Spec:** docs/knowledge-learning-loop.md；用户已批准下一批第 8、1、2 项及此前预算、JJ 部署、提交推送授权。

## Global Constraints

- JJ 累计模型授权 $2 不变；旧费用和未知预留不清零；每次真实请求须通过现有报价、项目与调用门禁。
- 原项目、员工文件和历史授权保留；测试产物由员工生成；协议测试不算真实模型验收。
- 搜索/读取不计采用；采用声明只在封存成功尝试中计入。独立工作按项目与语义方案版本去重，恢复及重复查询不增加次数。
- 统计保留未知费用和不可比较状态；复用收益沿用 workEfficiency，不能凭采用次数推断提速。
- 来源版本、当前授权、空间归档及共享边界有效；公司/私有来源不自动带入部门工作内容发布。
- 复用门槛为可配置的不同成功工作数；默认 3 是本次常规实现选择，不声称用户指定。候选不因次数满足自动成为 Skill/工具。
- 既有手工候选、审核内容、发布和版本不覆盖；候选数量和正文有界，重复补检幂等。

## Review Focus

1. 恢复子运行与同项目同方案的重跑只能计一个工作。
2. 档案缺失/篡改、失败尝试与只有读取不增加成功统计；错误明确展示。
3. 当前来源归档、修改授权及部门边界不能借候选公开私有内容。
4. 既有人工候选、编辑和已发布版本不被自动补检覆盖。
5. 统计多次刷新、重启补检及发布响应丢失不重复创建；没有可比较基线保留“未验证”。

### Task 1: 原预算内真实选用验证

**Files:** 本阶段私有验证脚本；docs/validation/reuse-learning-2026-10-11.md 与 evidence 同名目录。
**Interfaces:** 既有 /projects、planning-quote、generated-plan/confirm、approve、runs、approvals、knowledge API。

- [x] 核对现有模型价格、总费用/预留、原小项目及资料授权，估算最小真实任务。
- [ ] 原额度容纳时创建隔离的验证任务和少量方法，真实模型自行选择；完整、部分、不适用行为按实际证据分别记录。
- [x] 保存运行 ID、固定来源、采用事件、交付及验收结果；受阻记录精确门禁，不重复无效请求。

实际：真实员工已生成三场景选用报告，但没有完成节点封存、QA 与经理核对。运行 `86ca97da-dd42-47a8-8f57-be50e6834cab` 在下一请求发送前因任务预算不足停止。完整真实验收仍未完成，成功计数为 0；费用与文件保留。

### Task 2: 跨工作采用统计

**Files:** 新建 apps/api/src/knowledge-reuse.ts；修改 knowledge.ts、KnowledgeCenter.tsx、KnowledgeReuse.tsx；新增 tests/knowledge-reuse.test.ts 和相关 UI 测试。
**Interfaces:** knowledgeReuse(db,traceRoot,departmentId) 返回 fixed-source groups、distinct works、实际效率和明确 omissions；GET /knowledge/reuse?departmentId=...。

- [x] RED：不同项目成功采用累计，同项目同版本恢复去重；读取/失败不计；源版本分开；私有工作不公开；无基线不伪造收益。
- [x] GREEN：从公共 acceptedWorkEvidence 投影，复用现有历史与效率接口，有界扫描并显式返回遗漏/截断；后台不扫描效率基线。
- [x] 网页显示来源版本、不同工作数、证据入口和已有实际指标，权限与错误清楚；相关回归并提交。

### Task 3: 自动待审候选、部署与交付

**Files:** knowledge-reuse.ts、automation-learning.ts、AutomationLearningCenter.tsx、相应集成与备份测试、阶段报告。
**Interfaces:** syncReuseCandidates(db,traceRoot,departmentId,minSuccessfulWorks) 复用原候选表和发布器，只处理同部门共享来源与可共享的工作。候选包含不可变来源和成功工作的证据，已有候选不覆盖。

- [x] RED：门槛可设置，满足时幂等创建；失败/恢复不加次数；归档/授权/旧候选保护；新字段备份隔离恢复。
- [x] GREEN：现有补检服务按有界节奏同步，使用既有候选编辑、审查确认与原空间发布；显示门槛和来源工作。
- [x] 类型、构建、相关回归、一次全变更独立审查；必要修复保留 RED→GREEN。
- [x] JJ 新 release 验证，原数据/交付哈希保持；短网页验证，保存结果并提交推送现有分支。

工程证据：API 22 项、UI/效率 8 项、类型及构建通过；JJ 15 项回归通过，新 release 为 `weiwu-reuse-learning1-20261011`。发布前后 7 项目、371 条用量与全部运行档案哈希一致，原交付三文件 SHA256 未变。独立审查初始三项问题已复现修复，未进行第二轮独立审查。完整真实选用验收受预算阻塞，不能将整批标记为已验收。

## 执行方式

沿用本会话 inline 执行。用户已说“好，开始把”，实施范围与权限已明确；不再询问同一实施方法。每阶段保存进度和验证结果；真实验收、局部通过、失败和阻塞分开记录。
