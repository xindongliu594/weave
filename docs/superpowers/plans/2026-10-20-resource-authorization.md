# Resource Authorization and Human Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本轮委派仅编写计划；实施按前置审查与文件交接推进，无需再次请求常规授权。

**Goal:** 在现有 OIDC API 边界上实现按资源的真人权限、不可扩大来源的共享、审批与其他关键动作的可归责审计，并在长任务恢复和每个新效果前重验当前授权。

**Architecture:** 继续使用 `api-route-policies.ts` 唯一路由目录、`apiAccess` 的服务端 principal、现有 PostgreSQL 外键/事务、运行快照和 DSH 工具门禁。新增小型资源解析与来源约束函数，逐个业务路由接入；无可证归属或无法携带来源的路径保留 admin-only/拒绝。运行持久保存授权人 ID、批准时 epoch 与授权范围，后台以 system actor 执行并重查该真人当前权限，不持有浏览器 session。

**Tech Stack:** Node `^22.19.0 || >=24`、TypeScript、Express 5、PostgreSQL/pg、React 19；使用已固定的 OIDC/openid-client 和 DSH `0.1.5-rc.1`，不增加权限引擎或登录库。

**Spec:** `docs/superpowers/specs/2026-10-20-resource-authorization.md`；总约束 `docs/superpowers/specs/2026-10-20-enterprise-foundations.md`。

## Global Constraints

- A1 的 OIDC API Task 2 集成/复审通过，`apiAccess`、route catalog、principal-scoped idempotency 的合同稳定后才实施 A2；**A1 OIDC Task 3** 的登录 UI/CSRF transport 是浏览器验收前置。本计划不触碰正在由另一实施者修改的 A1 文件，执行时须重新核对其最终接口。
- 企业模式未知 method/path、未知资源、无归属历史、冲突部门集合均拒绝成员。保留 `legacy-local` 的单人兼容行为；旧记录不补造 `owner`、`requestedBy` 或审批人。
- 真人 actor 只取 `identity.authenticate(req)` 后由 `apiAccess` 写入的 `res.locals.principal`。body、query、headers、模型输出、运行快照不得声明或覆盖 actor；device/system 只由现有受信机器/内部入口构造。审计也记录 `local-owner`，但不把旧行为改写成新的人名。
- 成员权限只取当前 `human_users` active/epoch 与 `department_memberships`；长运行还须将当前 epoch 与批准时持久 `authorized_epoch` 比较，自然 session TTL 到期不等于 epoch 撤权。审批要求每个参与部门 `operator|manager` 且各自 `can_approve=true`。预算上调、挪用未分配额度、未知费用处置、网关/凭据/插件管理、备份/清理初期仅 admin。`auditor` 无业务资源读权。
- 读权不含再分发权。来源条件取并集、目标参与部门必须包含全部来源所需部门，`admin_only/private` 严格性不能消失；持久来源版本/哈希可追溯。管理员普通复制仍带来源条件。无法捕获或传递来源的在应用内派生路径禁向成员开放，不能以模型改写或改名消除来源限制。
- 授权和 CSRF 在幂等 lookup 前；列表/搜索/计数在 SQL `LIMIT` 前过滤；有副作用的成功审计与业务变化同事务，失败/拒绝审计在回滚后独立写入。outbox 只投影到受限 DB 运行索引，不由第二个 worker 写活动 JSONL。后台无浏览器 session，不能用历史快照绕过当前撤权。
- 保留数据、费用与未知结果；隔离 DB/临时目录测试，无生产/JJ、真实模型或付费调用。每任务定向红绿测试通过后才做下一任务；最终再做跨端集成验收。
- 需要 SQL 的新 `tests/resource-*.test.ts`、`tests/identity-management.test.ts` 必须像 `tests/api-idempotency.test.ts` 一样确认受信隔离 runner 和 loopback 测试 URL：一般测试断言 `SIMULATED_INTEGRATION==='pglite'`；Task 7/8 的独立后端并发测试额外接受 `resource-postgres`，仅由 Task 7 新 runner 注入。用现有 `node scripts/test-integration.mjs <测试文件...>`：它为**每文件**创建新 PGlite + pgvector、注入临时 `DATABASE_URL` 并关闭，绝不直接执行 `tsx --test` 继承 ambient `DATABASE_URL`。无 DB 的纯函数测试可直接 tsx。PGlite 单 backend 不能证明真实 PostgreSQL 行锁并发；Task 7/10 另用显式隔离 PG 验收。

## Review Focus

1. 项目主部门 A 可见但协作部门 B 已撤权：列表、详情、附件、引用、成本、审批及恢复都拒绝；Task 2/4/7 的用例覆盖。
2. B 来源文件/知识被放进 A-only 目标、模型概括后重发或再次派生：在读取/批准/发布前拒绝，合法 A+B 目标继续带 B 限制；Task 3/5/6 的用例覆盖。
3. 并发批准与撤 `can_approve`：只有持锁且当前每部门权限仍在的一次提交，审计失败回滚；Task 7 覆盖。
4. 重启后无 session 的 coordinator 继续运行，原授权人已停用/撤成员/增加 epoch：下一个模型请求、知识读、工具效果和 retry 阻断，已完成效果不重放；Task 8 覆盖。
5. 无归属旧数据、版本冲突、查无对象、恶意 body actor 与相同幂等键：不泄漏、不回填人名、不命中旧响应；Task 1/2/3/9 覆盖。

---

## 文件结构、顺序和互斥所有权

先完成 1→2→3→4→5→6→7→8→9；Task 10 为浏览器/发布门禁。每任务只由当前实施者持有列出的文件，前一任务合并/复审后下一任务接手。同名文件出现于后续任务表示**顺序交接**，禁止并行编辑。A1 Task 2 对 `app.ts`、`api-access.ts`、`api-route-policies.ts`、`db.ts`、`idempotency.ts` 拥有先行所有权；在 A1 复审通过前 A2 对它们只读。**A1 OIDC Task 3** 独占通用 `apps/web/src/api.ts` 登录/CSRF transport；A2 仅消费其最终接口，不并改。

| 单元 | 文件及责任 |
| --- | --- |
| 当前身份/资源判断 | 新 `apps/api/src/resource-authorization.ts`：查真实外键、参与部门、当前成员并提供明确判定；新 `tests/resource-authorization.test.ts`。不解析任意 DSL/通配 policy。 |
| 路由入站 | `apps/api/src/api-route-policies.ts` 唯一 method/path 清单；`api-access.ts` 在 idempotency 前对可解析单对象写路由调用资源判断；`app.ts` 等 list handler 在 SQL 过滤。`res.locals.principal` 是唯一 HTTP actor 输入。 |
| 来源合同 | 新 `apps/api/src/source-bounds.ts`：有限的 run/file/knowledge revision 来源并集与目标检查；`product-schema.ts`/`work-files.ts` 的 additive migration。源 ID、固定 version/hash、部门集合、`adminOnly`、`private` 持久化；旧 NULL 均保守拒绝成员。 |
| 人事与审计 | 新 `apps/api/src/identity-management.ts`（人员 API）；`identity-store.ts` 的审计白名单扩展；`identity-schema.ts` 追加审批 actor 字段；`product-schema.ts`/`work-files.ts`/`automation-learning.ts` 各自迁移资源来源字段；新 `apps/api/src/human-audit.ts` 管 success/denied/failure 与 outbox 投影。 |
| 运行门禁 | `run-coordinator.ts` 的 admission/model/恢复 hook、`host.mjs` 已有异步 `tools/pre-execute`、`knowledge-store.ts` 的读前检查；`employee-tool-access.mjs` 的同步 `ctx.tools.guard` 保留既有定义/快照校验，不能在其内异步查 DB；运行 `requested_by_user_id`、`authorized_by_user_id` 为身份引用，`authorized_epoch` 为批准时撤权版本，均不是 session。 |
| UI | **A1 OIDC Task 3** 先交付 `apps/web/src/api.ts` 通用 CSRF/login；A2 后建小型人员页并由 `apps/web/src/App.tsx` 接入。 |

### Task 1: 可信 actor 与最小人员管理

**Files:** create `apps/api/src/identity-management.ts`, `tests/identity-management.test.ts`; modify `apps/api/src/identity-store.ts`, `identity-schema.ts`, `api-route-policies.ts`, `app.ts`（限挂新 router）。

**Interfaces:** consume A1 `res.locals.principal: Principal`, `loadHumanPrincipal`, `appendHumanAudit`, session epoch；produce `requireHttpHuman(res): HumanPrincipal`（只检查服务端 locals，不接受 body 身份），`identityManagementRouter(): Router`。路由显式登记 `GET /api/identity/users`、`PATCH /api/identity/users/:id`、`POST /api/identity/users/:id/revoke-sessions`、`GET /api/identity/departments/:id/members`、`PUT/DELETE /api/identity/departments/:id/members/:userId`；初版全部 admin，manager 管人先保持 admin-only，避免自我/间接提权。

- [ ] 写失败测试：pending/disabled 无权限；body/header `actorId/orgRole` 不能改变审计主体；user 版本冲突 409；同一事务停用后 epoch 失效；最后 active admin 无法停用或降级；会员修改后的下一请求当前权限变化。运行 `node scripts/test-integration.mjs tests/identity-management.test.ts`，预期新增路由/接口缺失导致失败。补两个独立 PostgreSQL 连接下两位管理员同时自我降级、同时自我停用的竞态测试，各自最多一个提交、提交后至少一位 active admin；Task 7 runner 就绪前标记真实并发门禁待验。
- [ ] 实现服务端 principal 提取、分页安全字段与 version CAS；复用 `identity_bootstrap` 单行 `FOR UPDATE` 为所有改变 active-admin 集合的入口提供共同序列锁，在 `identity-store.ts` 抽最小共享锁函数并用于 bootstrap/identity upsert、激活/停用及 org role 升降级，不能仅分别锁 actor/target 后计数。统一锁序为 `identity_bootstrap` → 按 ID 锁 actor/目标 `human_users` → 按 department ID 锁目标 membership；取得共同锁后重查 actor 当前 admin 资格及 active-admin 数量，最后管理员不变量和身份 audit 同事务提交。普通 membership/epoch 撤权事务按 user→membership 顺序，不在持有人锁后再获取 bootstrap 或 project/run/approval 锁；审批/运行授权事务按 Task 7 的 project→run→approval→user→membership 顺序锁同一 user/membership，不用无锁旧读。停用/撤权的线性化点为 user epoch 或 membership 更新提交。仅 bootstrap 精确 `(issuer,subject)` 首管理员，绝不按 email 自动入部门。
- [ ] 更新唯一 route catalog 与 `assertRouteInventory`，不设 `/api/identity/*` 前缀例外。运行上述隔离测试及 `./node_modules/.bin/tsc.cmd --noEmit`，预期通过；A1 route/CSRF/幂等负例用 `node scripts/test-integration.mjs tests/api-access.test.ts tests/api-idempotency.test.ts`。

### Task 2: 资源锚点、当前 membership 与入站门禁

**Files:** create `apps/api/src/resource-authorization.ts`, `tests/resource-authorization.test.ts`; modify `apps/api/src/api-route-policies.ts`, `api-access.ts`。后续 Task 4/5/6/7 按顺序改 handler。

**Interfaces:** produce `resolveProjectDepartments(db, projectId): Promise<string[]|null>`、`resolveRunDepartments(db, runId): Promise<string[]|null>`、`requireDepartments(db, principal, ids, level:'viewer'|'operator'|'manager', options?:{approve?:boolean}): Promise<void>`、`requireResource(db, principal, ref:{kind:'department'|'project'|'run'|'approval'|'workFile'|'knowledgeSpace'|'knowledgeDocument'|'cost';id:string}, level): Promise<void>`、`visibleProjectIds(db, principal, level): Promise<string[]>`（实际列表优先 SQL `EXISTS`，不取全量 ID 再分页）。共享 `pg.Pool|PoolClient` 查询接口以便写事务内复核。

- [ ] 写失败测试：A-only 对 A+B 项目/运行、`can_approve` 仅 A、`viewer` 带审批标记、空/冲突 `department_ids`、trace-only ID、伪造 body department、auditor、旧文件无 `source_run_id` 全拒绝成员；admin 仍受无记录 404。运行 `node scripts/test-integration.mjs tests/resource-authorization.test.ts`，预期缺接口/断言失败。
- [ ] 用 `projects.department_id`、`policy.allowedDepartmentIds`、计划来源部门和 `project_runs.department_ids` 交叉核验；run/approval/file/cost 通过 DB 外键逐级追源，不信 request/trace 快照增加权。DB 缺失/冲突返回不可授予状态。集合排序后稳定锁 membership；非 admin 的审批 `approve=true` 要每部门 O/M 加标记。
- [ ] `apiAccess` 仅为已逐条标为 member 且可由路径/已解析 query/body 锚定的路由在 idempotency 前调用 `requireResource`；仍保留 admin/device 现有路径与 exact method/path。列表路由在 handler 完成 SQL 过滤前不降权。运行 `node scripts/test-integration.mjs tests/resource-authorization.test.ts tests/api-access.test.ts tests/api-idempotency.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期通过；未分类 route 和同 key 撤权仍拒绝。

### Task 3: 最小持久来源约束与派生合同

**Files:** create `apps/api/src/source-bounds.ts`, `tests/source-bounds.test.ts`; modify `apps/api/src/product-schema.ts`, `work-files.ts`, `knowledge-store.ts`, `automation-learning.ts`（仅来源字段/函数，路由降权由后续任务）。

**Interfaces:** `SourceBounds={requiredDepartmentIds:string[];adminOnly:boolean;private:boolean;refs:Array<{kind:'run'|'file'|'knowledge-revision';id:string;version?:number;sha256?:string}>}`；`combineSourceBounds(bounds:SourceBounds[]):SourceBounds`；`assertTargetContainsSources(targetDepartmentIds:string[],bounds:SourceBounds):void`；`readRunBounds(db,id)`、`readFileBounds(db,id)`、`readKnowledgeRevisionBounds(db,id,version)`。`requiredDepartmentIds` 为必要读者资格集合，绝不是可自动获得的 grant；`adminOnly/private` 取 OR，部门取并集，refs 固定且去重。当前没有私人目标类型，`private=true` 的来源禁止进入部门/公司共享目标；admin 查看仍可，但普通复制不能消去 private 标记。

- [ ] 写失败测试：B 源进入 A-only 目标失败；A+B 目标保留 B；admin 复制仍带 B；两次派生不丢 B；旧 NULL/未知来源、损坏 refs/version/hash 仅 admin 读取且拒绝成员派生。运行 `node scripts/test-integration.mjs tests/source-bounds.test.ts`，预期缺接口失败。
- [ ] additive migration：`project_runs` 加 `requested_by_user_id`/`authorized_by_user_id` 可空 FK、`authorized_epoch bigint` 可空、`authority_kind` 可空受限枚举、`authority_department_ids text[]` 可空、`source_bounds jsonb` 可空；`authorized_epoch` 仅由服务端在真人批准事务中读取当时 `human_users.session_epoch` 写入，不接受客户端/快照值。`work_file_snapshots` 加 `source_bounds jsonb` 可空并保留 `source_run_id`；`knowledge_revisions` 加 `source_bounds jsonb` 可空；`automation_knowledge_candidates` 加 `source_bounds jsonb` 可空。**旧 NULL 不回填 inferred owner/source/epoch**。新行经受限 schema 校验写入，refs 指向现有 run/file/document revision，创建事务验证 FK 或固定 revision hash；不建立任意类型的政策引擎。
- [ ] 将 `work_file_snapshots.source_run_id` 作为 run 来源读证据，`knowledge_revisions.source.runId` 与候选的 `run_id/document_id/source_version/source_hash` 与 source_bounds 交叉核对；新无来源上传/generate 绑定 `adminOnly=true`。版本更新继承旧 revision 与新增来源之并集，不能把来源约束清零。运行 `node scripts/test-integration.mjs tests/source-bounds.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期绿。

### Task 4: 项目、运行、部门列表与写入

**Files:** modify `apps/api/src/app.ts`, `manager-chat.ts`, `product.ts`, `department-workbench.ts`, `employee-history.ts`, `api-route-policies.ts`; create `tests/resource-project-routes.test.ts`。Task 2 后顺序接手 catalog/app。

**Interfaces:** consume Task 2 `requireResource/visibleProjectIds`、Task 3 `assertTargetContainsSources`。项目 create/plan 改动先从 DB 解析主部门+协作部门+计划 agent 来源，必要时 `requireDepartments(...,'operator')`；预算上调/挪用未分配额度只 admin。运行批准在同一事务持久 `authorized_by_user_id`、批准时 `authorized_epoch` 与 `authority_department_ids`，`requested_by_user_id` 来自当前 HTTP principal；本机 local-owner 显式 kind，既有旧 run 留 NULL。retry/重授权须建立新 attempt 与新授权事件，不修改旧 run 的授权人、epoch、审批与审计证据。`automatic-policy` 仍须有可信持久真人授权，否则企业模式不允许后台产生新效果。

- [ ] 写失败测试：只有 A O 无 B 时创建/改 A+B 项目失败，主部门 A 不掩护 B；预算上调即使两部门 O 仍 403；manager 非财务部门配置成功而借 `PUT /departments/:id` 加预算/全局工具 grant 失败；撤 B 后同键 plan 更新/消息/批准不得从幂等缓存成功；部门列表/项目分页/计数先 SQL 限权；AI 员工历史不被当作 human membership。运行 `node scripts/test-integration.mjs tests/resource-project-routes.test.ts`，预期失败。
- [ ] 改项目路由（`/projects` 列表/建、`:id/versions`、plan/messages、planning-quote/generate/confirm/approve）与组织预览的明确归属路径，写事务锁当前权限；无归属组织 chat/自动组建仍 admin-only。`PUT /departments/:id` 对 manager 仅放经新旧数据差异检查的本部门非财务配置；预算增加、组织级模型/工具 grant 与跨部门 agent 引入仍按专门授权或 A-only；本部门 AI 员工历史恢复带审计。运行列表与状态、取消/retry/resource-proposal 等在同一 run 断言下逐条开放；含知识正文/附件/引用/档案/导出的详情路由先继续 admin-only，待 Task 5/6 保护其所有消费端后再降权。trace-only 仍 A-only。`department_versions` 全文与归档/恢复仍 A-only，仅安全概要可开放成员。
- [ ] `run` 批准时 `source_bounds` 合并已选素材/知识来源，必须被目标 `department_ids` 包含；超出既有有效预算/模型/工具权限拒绝，不从 `can_approve` 推断预算。改 catalog 每条已验路由，运行 `node scripts/test-integration.mjs tests/resource-project-routes.test.ts tests/collaboration.test.ts tests/work-file-project.test.ts tests/run-state.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期绿。

### Task 5: 素材导入、运行输入和文件下载

**Files:** modify `apps/api/src/work-files.ts`, `app.ts`, `api-route-policies.ts`, `run-management.ts`, `run-lineage-evidence.ts`; create `tests/resource-file-lineage.test.ts`。Task 4 后顺序接手。

**Interfaces:** `selectedWorkFileInputs`/`selectedWorkFileCopies` 返回每选件的 `sourceBounds`（调用点 `app.ts` 的 plan 校验与 run approve 均消费）；`attachRunInputs`/批准快照保留引用 ID/hash 和 bounds；`/work-files/from-run` 从 run DB 行+完整 trace 验证后复制不可变 bounds。

- [ ] 写失败测试：B 文件导入 A-only run 在读取文件正文前拒绝；A+B 合法且新快照、runInputs、workspace copy 均带 B；再次 `/from-run` 后 B 仍在；仅 A viewer 不能 list/detail/download B 或 A+B 快照；旧 `source_run_id=NULL`/`source_bounds=NULL` 仅 admin，成员任意 upload/generate 拒绝。运行 `node scripts/test-integration.mjs tests/resource-file-lineage.test.ts`，预期失败。
- [ ] 改 `selectedWorkFileInputs/Copies` 在 `readWorkFileSnapshot` 后、`verifiedText` 前验源/目标；`prepareImportedWorkspace` 只消费已获准且 hash 绑定的清单，不能重新按文件名降权。`GET /work-files` 在 SQL 限权后分页；详情/download 和 `runs/:id/artifact(s)/export/lineage-evidence` 在读文件系统前查 run/bounds。由 run 生成快照继承 run bounds；无来源的 admin-only 文件不能作为成员项目输入。
- [ ] 运行 `node scripts/test-integration.mjs tests/resource-file-lineage.test.ts tests/work-file-project.test.ts tests/run-input.test.ts tests/api-access.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期绿。尚无法传递来源的 Office generate/裸上传给成员保持 403，不标为成员交付。

### Task 6: 知识、搜索、经验候选与 Skill 发布

**Files:** modify `apps/api/src/knowledge.ts`, `knowledge-store.ts`, `knowledge-reuse.ts`, `work-records.ts`, `work-efficiency.ts`, `automation-learning.ts`, `native-capabilities.ts`, `app.ts`, `api-route-policies.ts`; create `tests/resource-knowledge-lineage.test.ts`。Task 5 后顺序接手。

**Interfaces:** `knowledgeSnapshot`/`queryKnowledge` 对文档 revision 的 `source_bounds` 与目标 run 部门做包含检查；`searchAvailableKnowledge` 仅在当前真人可见空间内搜；`saveKnowledgeDocument` 的衍生写入参数携带可信 server-computed bounds（不接受 body `sourceBounds`）。`knowledgeReuse`、`acceptedWorkRecord`、`workEfficiency` 必须接收可信当前 principal/服务端授权 scope，候选 run 与 baseline run 均独立校验全部参与部门和来源 bounds；内部自动 `syncReuseCandidates` 也须携带该 scope 或仅在有已绑定、可重验的授权来源下运行。候选 publish 继承**全部**实际 workReferences 的 run 来源加 document revision 来源并集，不只取首个 `run_id`。AI 员工 `knowledgeSpaceIds/agent_ids` grant 独立保持。

- [ ] 写失败测试：B 知识在 A-only run 的 **读取前** 拒绝；company/employee 空间不能因 department viewer 展示；B run 发布到 A-only space 失败；经验候选标题/正文改写与二次发布不洗掉 B；合法 A+B 文档仅双部门可读、搜索/版本/引用均过滤。另建“当前 A 目标 run 可见、同主部门 A 的历史 A+B run 不可见”夹具：`/knowledge/reuse` 不返回历史 run 的作品/引用/notes，也不把它计入 `scannedRuns`、`omissions` 或成员可见容量；`/knowledge/work-records/:id` 的效率 baseline 不读其档案/费用；自动候选合并全部可见来源并在二次发布前仍拒绝放入 A-only 目标。运行 `node scripts/test-integration.mjs tests/resource-knowledge-lineage.test.ts`，预期失败。
- [ ] 逐条接 `knowledge/spaces/documents/versions/search/work-records/publish/reuse` 的 SQL 过滤与对象断言；对文档写入在保存事务内校验目标 scope 和合并来源，`knowledge_chunks/embeddings` 只通过已获准 document IDs 搜索，不在排序后过滤。`knowledge-reuse.ts` 的 run 候选 SQL 在 `ORDER BY/LIMIT 101` 和容量/统计聚合**之前**以当前 principal 的全部参与部门与 run/source bounds 排除不可见行；读取 trace/notes 只发生在这些候选之后，成员响应的容量/count 只用可见行准确计算或省略，不能回送全局候选容量、隐藏行的 omissions 或 workReferences。`work-records.ts` 向 `workEfficiency` 传同一 scope；`work-efficiency.ts` 对同主部门同需求的每个 baseline 候选在 SQL 限量及档案/费用读取前做同样筛选，不能以目标 run 已授权替代 baseline 授权。`company` 无显式发布字段、`employee` 私有全文、vault/sync/index/retrieval 设置继续 A-only。新运行输入的检索与 Skill loader 也在 `queryKnowledge` 校验运行目标/来源，不能只在生成交付时阻断。
- [ ] `knowledge-reuse.ts` 的 `syncReuseCandidates` 与 `automation-learning.ts` 的 `authorizedSource`、create/update/publish 均在保存事务中构造并持久校验每个实际 workReference 的 run bounds、来源文档 revision/hash 的并集；单个 `run_id` 仅作主引用，不代表其余来源可丢弃，候选后续更新/发布继续核全量 refs 与目标 scope。无法传递 bounds 的 schedule/improvement/method 发布仍 A-only 或拒绝成员。`GET /capabilities/plugins` 的成员视图仅投影本部门 AI 员工实际获授权、namespace enabled 且固定 manifest 可验的名称/版本/权限元数据；其他能力与包内容不可见。`PUT` 及 MCP/browser 连接管理仍 A-only。运行 `node scripts/test-integration.mjs tests/resource-knowledge-lineage.test.ts tests/knowledge.test.ts tests/knowledge-reuse.test.ts tests/hybrid.test.ts tests/capabilities.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期绿。

### Task 7: 审批 actor、事务审计和费用边界

**Files:** create `apps/api/src/human-audit.ts`, `tests/resource-approval-audit.test.ts`, `scripts/test-resource-postgres.mjs`; modify `apps/api/src/run-management.ts`, `identity-store.ts`, `identity-schema.ts`, `cost-router.ts`, `app.ts`, `api-route-policies.ts`。Task 6 后顺序接手。

**Prerequisite:** D2 观测计划 Tasks 1–2 先提供共享 append/outbox 合同；D2 Task 3 再消费本任务的业务接线。不是全部 A2 完成后才开始 D2，也不是 A2 另建审计队列。

**Interfaces:** `appendBusinessAudit(db,event)`、`recordDeniedAudit(pool,event)` 是 D2 `appendAudit`/`recordAuditFailure` 的薄适配，使用同一审计表、action/resource/outcome 白名单及当前授权证据。拒绝在业务事务回滚后独立写入，失败不能把拒绝变成功。共享 `projectAuditOutbox(pool,{limit,now})` 在短 DB 事务中按 event ID 幂等写 `audit_run_projection` 并更新 outbox；`published_at` 仅表示这次 DB 投影已提交，不表示 JSONL 或 OTLP 已送达。审批从 `res.locals.principal` 取 actor，绝不读 body 的 identity 字段。

- [ ] 写失败测试：A O+approval/B O 无 approval 拒绝；B viewer+flag 拒绝；A/B O/M+flag 才可批；并发撤 B/双决定最多一个提交；audit INSERT 故障使批准回滚；DB 投影故障仍有 outbox，重试不重批；活动 JSONL 不因投影出现第二写者；历史审批决定人 NULL 不伪填；body 假 actor 忽略/拒绝。运行 `node scripts/test-integration.mjs tests/resource-approval-audit.test.ts`，预期非并发部分失败；真实行锁竞态须由本任务新隔离 PG runner 复测，不能因 PGlite 绿而称通过。
- [ ] additive 扩 `tool_approvals` 历史可空 actor/request/reason 字段；`POST /approvals/:id` 先**无锁只读** approval 的 `run_id` 与 run 的 `project_id` 用于定位；进入事务后按既有协调器顺序锁 `project FOR UPDATE → run FOR UPDATE → approval FOR UPDATE → actor human_users FOR UPDATE → 按 department ID 排序的 actor memberships FOR UPDATE`，重读外键并确认仍是同一链，否则回滚重试/拒绝。检查 pending/running/not-cancelled、active/epoch 和每部门当前 O/M+flag，同事务更新决定、append audit/outbox；提交后投影。人员管理事务按 Task 1 的 user→membership 顺序，不在其后请求 project/run/approval 锁，撤权与审批在共有 user/membership 锁上序列化。拒绝/失败由外层独立结构化审计且无秘密 arguments。运行 JSONL 不当 DB 事务凭证。
- [ ] 关键项目/运行/人员/插件/预算/备份/清理动作逐项接同事务 success audit；跨文件/外部效果用 operation/outbox 关联，失败/拒绝独立记录。`GET /costs` 对成员只回 `{timezone,departments:[{id,spent,retained,limit}]}` 中明确归属部门的脱敏汇总，不含全局总数、calls/recent、费率或上游 request；run/project/department 冗余链冲突或 NULL 仅 A，`query-provider`/`reconcile` A-only。运行 `node scripts/test-integration.mjs tests/resource-approval-audit.test.ts tests/cost.test.ts tests/api-access.test.ts` 与 `./node_modules/.bin/tsc.cmd --noEmit`，预期绿。
- [ ] `scripts/test-resource-postgres.mjs` 必须要求显式 `RESOURCE_TEST_DATABASE_URL`（仅 loopback、数据库名以 `weiwu_resource_test_` 开头），拒绝使用 ambient `DATABASE_URL`；创建随机隔离 schema，给子进程设置该 schema 和 `SIMULATED_INTEGRATION=resource-postgres`，运行选定测试后清理。runner 支持 `tests/identity-management.test.ts`、`tests/resource-approval-audit.test.ts`、`tests/run-current-authority.test.ts`；用 `node scripts/test-resource-postgres.mjs tests/identity-management.test.ts tests/resource-approval-audit.test.ts tests/run-current-authority.test.ts` 在一次性 PostgreSQL 测试库中证明两管理员并发降级/停用、审批与撤权及 epoch 增加与新效果接纳的两个独立连接竞态；缺显式 URL 或库不可用时标记此门禁受阻，不退回 PGlite 假绿。

### Task 8: 长任务授权持久化与每个效果前撤权

**Files:** modify `apps/api/src/run-coordinator.ts`, `run-management.ts`, `knowledge-store.ts`, `native-capabilities.ts`, `local-execution.ts`, `services/agent-runtime/product-runtime.mjs`, `services/agent-runtime/host.mjs`（接现有异步 `tools/pre-execute`，避免新执行引擎）；create `tests/run-current-authority.test.ts`。Task 7 后顺序接手。

**Interfaces:** `assertCurrentRunAuthority(db,runId,effect:'resume'|'model'|'knowledge'|'tool'|'retry'):Promise<void>` 从 run 的 `authorized_by_user_id/authorized_epoch/authority_kind/authority_department_ids` 重读真人 active、当前 `session_epoch`、部门 O/M 与当前 bounds，比较批准时与当前 epoch，核项目/运行参与集合和 capability/grant；`system` actor 只表执行者，授权来源仍是原 human ID。浏览器 session 自然 TTL 过期不阻断已授权后台长跑；显式 epoch 增加立即阻断下一效果。旧 NULL 人类授权记录 enterprise 自动恢复/新效果暂停，管理员可经新显式审批创建新 attempt/授权事件，不回填或改写原批准人/epoch。

- [ ] 写失败测试：冷重启无 cookie 或自然 session TTL 过期，授权人 active/全部门 O 且 epoch 未变时安全继续；仅增加 epoch（仍 active、O/M、其余 grant 不变）后，下一个 model reserve/知识 read/registered tool/local operation dispatch/retry/resume 全阻断并留审计；停用、撤 B、撤 tool grant、停用 namespace、来源撤回也阻断；旧 `authorized_epoch=NULL` 阻断企业新效果；新批准产生新 attempt，旧授权证据不变；已完成效果与未知结果不重放；legacy-local 原路径仍可用。运行 `node scripts/test-integration.mjs tests/run-current-authority.test.ts`，预期失败。
- [ ] 在 `run-coordinator` 的 tick/start/reserve/approval 和 retry、知识 query、实际设备派发前插同一个当前授权检查；效果接纳事务按现有 project→run→actor user→membership 方向取得当前行锁，再比较 `authorized_epoch` 和授权条件，撤权事务提交后新接纳必拒绝，已接纳效果按原 operation/未知结果规则处理，不跨网络调用长期持有 DB 锁。`ProductDshRuntime` 将 runId 绑定的异步 `beforeTool` 传到 `host.mjs` 现有 `tools/pre-execute`，在 `next()` 前 await 当前 DB 判定。DSH `ctx.tools.guard` 是**同步** `string|undefined`，只保留现有员工身份/注册定义的不可放宽检查，绝不把 DB Promise 放进 guard。动态注册工具按 namespace/员工授权判；现有 `assertRunAuthorization`、`assertNativeCapabilities`、预算和固定快照照常执行。无来源持久绑定的企业 schedule/自动化触发保持暂停/需人工授权，不以 system 身份兜底。
- [ ] 运行 `node scripts/test-integration.mjs tests/run-current-authority.test.ts tests/run-state.test.ts tests/execution-policy.test.ts tests/capabilities.test.ts`、`node --test services/agent-runtime/employee-checkpoint-policy.test.mjs` 与 `./node_modules/.bin/tsc.cmd --noEmit`；预期绿。记录撤权停止点、未决操作/费用保持原状的证据。

### Task 9: 全目录负面覆盖与浏览器人员页

**Files:** create `tests/resource-route-coverage.test.ts`, `apps/web/src/IdentityManagement.tsx`; modify `apps/web/src/App.tsx`（**A1 OIDC Task 3** 完成后）、`api-route-policies.ts` 仅补完整登记、`docs/execution-policy.md` 权限说明。不得与 A1 OIDC Task 3 并改通用 `apps/web/src/api.ts`。

**Interfaces:** 消费 **A1 OIDC Task 3** 的 `/auth/session` 与其 CSRF 封装；人员页只调用本计划 Task 1 API，pending 登录显示等待授权，403/401 不自动重放 POST。无 A1 OIDC Task 3 transport 时此任务不标通过。

- [ ] 写失败集成测试：路由登记和实际 Express handler 一一对应；大小写/尾斜杠/HEAD/OPTIONS/encoded path 无绕过；相同幂等键在 revoke 前后不返旧成功；各种 list/search/count/export/download/approval/backup/health/设备路径按矩阵。运行 `node scripts/test-integration.mjs tests/resource-route-coverage.test.ts`，预期失败。
- [ ] 接最小人员页、部门成员管理、本人安全资料与清晰拒绝/过期提示；API 前端继续依赖 **A1 OIDC Task 3** 的 CSRF transport。目录中仍 admin-only 的路由必须明确留下，不能为了覆盖测试给成员通配 GET。
- [ ] 运行 `node scripts/test-integration.mjs tests/resource-route-coverage.test.ts tests/api-access.test.ts tests/api-idempotency.test.ts tests/identity-management.test.ts`、`./node_modules/.bin/tsc.cmd --noEmit`、`./node_modules/.bin/vite.cmd build`，预期全部通过。

### Task 10: 隔离端到端和发布门禁

**Files:** create `docs/validation/enterprise-resource-authorization-2026-10-20.md`（实施时以实际日期命名）；必要时只修复前九任务负责的文件并重跑其测试。不修改 JJ/生产直到总计划发布门禁授权。

- [ ] 隔离真实 PostgreSQL + 本地真实协议 OIDC 两身份跑 A/B 部门全矩阵；测试两管理员并发自我降级/停用、并发审批/撤权、epoch 撤销与效果接纳、任务冷恢复、来源 B→A 拒绝、合法 A+B 派生两次仍限权、旧 NULL 行、设备凭据、人类 CSRF、跨主体 idempotency。PGlite 定向命令 `node scripts/test-integration.mjs tests/identity-management.test.ts tests/resource-authorization.test.ts tests/resource-project-routes.test.ts tests/resource-file-lineage.test.ts tests/resource-knowledge-lineage.test.ts tests/resource-approval-audit.test.ts tests/run-current-authority.test.ts tests/resource-route-coverage.test.ts tests/identity-oidc.test.ts`；独立 backend 行锁用 `node scripts/test-resource-postgres.mjs tests/identity-management.test.ts tests/resource-approval-audit.test.ts tests/run-current-authority.test.ts`，须显式一次性 `RESOURCE_TEST_DATABASE_URL`。记录 DB/schema、命令、退出码及证据路径，不调用模型。
- [ ] 在 **A1 OIDC Task 3** 浏览器 transport 完成后做 HTTPS 登录、pending→active、授/撤成员、刷新/登出/过期、人员页与下载/搜索负例。若不能执行浏览器/TLS 验证，状态明确记“本地 API 已验证、浏览器未验证”，不得称企业可交付。
- [ ] 复核 A1 全路由清单、审批审计 outbox 重试、当前 DSH `0.1.5-rc.1` 工具 guard、现有固定权限/预算；通过后在总计划标注本地已验证，JJ/真实业务验收仍遵守基础设计发布门禁及独立付费授权。

## 自审与未开放功能

- 设计的资源族覆盖 Task 1 人、Task 2 锚点、Task 3 来源、Task 4 部门/项目/运行、Task 5 文件、Task 6 知识/候选、Task 7 审批/费用/审计、Task 8 恢复/工具、Task 9 UI/全路由；前后接口同名。成功审计与 DB 同事务、拒绝/失败独立写、outbox 有界 DB 投影，已分别落 Task 7。2026-10-20 接线裁决：现有 JSONL 游标/去重仅进程内共享，新增 worker 不能安全追加活动档案，故替换原 JSONL 投影设想；原档案和恢复语义保留，外发观测另走 D2 受限摘要。
- 首版 company 知识无公开标志、employee 私有正文、无归属文件/费用/trace、全局自动化/MCP/browser 连接、预算上调与旧无授权人运行均继续 admin-only 或暂停。公司范围的“全员可读”发布、员工私有真人直读、来源授权降密、无归属历史归并需要后续单独设计/证据；不以 A2 计划声称这些路径已完成。
- 外部手动复制粘贴或外部文件导入若无法证明来源，应用无法凭正文推断原约束；此类入口不授予成员跨资源发布权。应用内显式来源与派生链按上述持久绑定强制执行。
