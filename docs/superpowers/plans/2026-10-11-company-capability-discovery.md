# 公司能力发现与采用记录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 员工自主发现获授权公司知识、Skill 与工具；按需加载固定方法，登记实际采用并关联已核验工作。

**Architecture:** 复用 DSH Skill Provider、现有知识版本清单、工具 Schema 和持久事件。公司方法保存为显式发布的知识修订元数据，运行只保存版本引用；正式工作记录只收录已验收尝试的采用记录，不新增数据库或外部服务。

**Tech Stack:** 现有 TypeScript / React / Node、PostgreSQL、DSH 0.1.5-rc.1、Cordis 4.0.2。

**Spec:** `docs/knowledge-learning-loop.md`；本批选型与用户已批准范围 `docs/research/tool-discovery-reuse-2026-10-11.md`。

## Global Constraints

- 先复用当前 DSH，不安装新网关、市场、记忆插件或升级 Harness。
- 普通资料不是指令；公司方法须用户明确保存为 Skill，正文最多 16,000 字符。
- 员工原知识空间授权与 knowledge_search / knowledge_read 权限共同约束发现和加载；不自动扩大权限。
- 使用固定文档版本及 SHA256，旧任务恢复不读取新版本。公司 Skill 正文只在加载时读取，不复制整个知识库到运行快照。
- 搜索结果每类最多 6 条；目录每员工最多 50 个公司 Skill，超过则明确报错，不能静默遗漏。
- 检索、读取、声明采用与宿主验收分开；同一任务尝试恢复幂等，失败尝试不计成功采用。
- 本批工具采用沿用实际工具调用记录；新增显式采用接口仅覆盖知识与 Skill，不自动提炼或发布新能力。
- 保留生产数据、旧运行与预算；本批开发验收为本地回归和 JJ 无模型读检，不宣称真实模型已验证自主选择质量。

## Review Focus

1. 无权员工伪造另一员工身份或文档 ID，目录和加载均应拒绝。
2. 文档普通编辑、外部 Vault 编辑或归档后，新运行应使用明确状态；旧运行固定修订继续可用。
3. 方法名称重复、过长、非法、正文过大，不能遮蔽运行内已批准方法或注入任意指令。
4. 加载并未采用、采用后尝试失败或更换尝试，不得算成功复用。
5. 重启后重复采用、资料完整性缺失、搜索失败，必须不重复登记或伪造“未命中”。

### Task 1: 公司方法的固定版本与官方加载器

**Files:** `apps/api/src/knowledge.ts`、`apps/api/src/knowledge-store.ts`、`services/agent-runtime/approved-skills.mjs` / `.d.mts`、`employee-hosts.mjs`、`host.mjs`；测试 `tests/company-capabilities.test.ts`、`services/agent-runtime/approved-skills.test.mjs`。

**Interfaces:** `queryKnowledge(snapshot, agentId, 'skill', documentId)` 返回经授权固定修订正文及版本哈希；`companySkills(manifest, employee)` 仅返回目录摘要和来源；`installApprovedSkills` 通过已有 queryKnowledge 回调注册 DSH Provider。

- [ ] RED：公司方法通过 API 保存，非法名字/大正文拒绝；普通文档不进 Skill 目录；两员工 ACL、固定 v1 及篡改哈希拒绝。
- [ ] GREEN：元数据 `source.skillName` 明确发布；Provider 惰性 get；唯一名字使用文档 ID 摘要前缀，保留运行内 Skill。
- [ ] 验证：`node scripts/test-integration.mjs tests/company-capabilities.test.ts tests/knowledge.test.ts`；`node --test services/agent-runtime/approved-skills.test.mjs`。Expected: 相关用例全部通过。
- [ ] 提交固定版本与加载器。

### Task 2: 员工能力检索与采用回执

**Files:** 新增 `services/agent-runtime/employee-capabilities.mjs` / `.d.mts` / `.test.mjs`；修改 `employee-hosts.mjs`、`host.mjs`、`product-tools.mjs`、`recovery.mjs`、`apps/api/src/work-records.ts`、`tests/work-records.test.ts`。

**Interfaces:** `installEmployeeCapabilities(ctx, {employee,agent,manifest,queryKnowledge,archive,activeWork})` 安装 `capability_search({query})` 和 `capability_use({kind:'knowledge'|'skill',id,note})`；`acceptedAdoptions(events, receipts)` 投影成功尝试，按任务与来源去重。

- [ ] RED：知识/Skill/原已授工具检索，零命中、错误不吞；采用前必须有对应读取；无活动任务拒绝；冷恢复同尝试重复只记一次；失败尝试不进正式工作。
- [ ] GREEN：复用现有关键词搜索与 DSH schemas/list；回执使用现有 sourceKey 幂等、 taskId/attemptId，正文不重复保存。
- [ ] 验证：`node --test services/agent-runtime/employee-capabilities.test.mjs services/agent-runtime/approved-skills.test.mjs services/agent-runtime/employee-hosts.test.mjs services/agent-runtime/product-tools.test.mjs`；`node scripts/test-integration.mjs tests/work-records.test.ts`。Expected: 全部通过。
- [ ] 提交发现和采用回执。

### Task 3: 网页发布入口、验证与交付

**Files:** `apps/web/src/KnowledgeCenter.tsx`、`apps/web/src/RunCenter.tsx`；相关网页测试、`docs/knowledge-learning-loop.md`、本批验收报告。

**Interfaces:** 知识编辑表单以 `source.skillName` 显式区分普通资料和批准 Skill；运行时间线显示发现/读取/采用状态；工作记录包含成功采用及证据链接。

- [ ] RED→GREEN：表单可发布/取消方法，编辑保留来源；网页展示采用事件与仅声明采用的限定说明。
- [ ] 本地相关回归、类型检查、构建；一次全变更独立审查及必要修复。
- [ ] JJ 可达则部署固定新 release、保留共享依赖/旧数据，验证 API 与一处关键网页；不可达则记录阻塞并交付可启动代码。
- [ ] 保存测试输出、部署/浏览器证据、状态限制，提交并推送现有分支。

## 执行方式与既有授权

用户在选型后说“可以开始吧”，此前已授权自主常规实现、在当前工作区执行、Git 提交和推送。沿用 inline 执行，不再次询问相同实施流程；每阶段记录短进度。真实员工选型质量与跨工作经验晋升不在本批无模型测试中冒充通过。
