# A2：真人资源授权与可归责审计设计

状态：方案，未实施、未验收。日期：2026-10-20。适用单组织 OIDC 企业模式；本机单人模式继续由现有 `local-owner` 明示身份处理。A1/OIDC API 边界尚在集成，A2 不以代码已存在等同已可用。本文只规划复用与缺口，不变更源码、依赖、生产数据或 JJ 服务。

本设计采用文末的保守默认作为首版边界。全路由 admin-only 是 A1 过渡状态；A2 须完成按资源过滤和撤权验收，才能逐类开放成员访问。下述顺序是设计分解，尚不能代替带文件所有权、具体接口和测试命令的逐任务实施计划；在 A1 接线接口稳定后补齐后实施。

## 依据与复用边界

- [基础设计](../../../docs/superpowers/specs/2026-10-20-enterprise-foundations.md)要求身份/资源授权先于幂等缓存，撤权影响新读、工具调用和恢复；历史快照仅供审计。[既有身份调研](../../../docs/research/enterprise-identity-2026-10-20.md)已核对 DSH 固定 `0.1.5-rc.1` 的凭据授权、匿名安装 ID、client-connection 与 user-approval 均不能充当真人 RBAC；选用既有 OIDC/会话方案，不再另造认证或插件引擎。此方案不重复联网选型。
- [OIDC 集成计划](../../../docs/superpowers/plans/2026-10-20-oidc-api-integration.md)及其 [路由盘点](../../../.superpowers/sdd/2026-10-20-oidc-api-integration/task-2-inventory.md)：现有 142 个业务 method/path 先显式登记为 admin（四个设备专用路由除外），A2 只能逐条降权；登录 UI/全局 CSRF 传输由 OIDC Task 3 承接，不能以 A2 的权限实现代替浏览器验收。`api-route-policies.ts` 当前的 `RouteAccess` 仅 `admin | device`，需要在同一清单扩充经过审查的资源规则，不开第二个权限入口。
- [identity-schema.ts](../../../apps/api/src/identity-schema.ts)、[identity-types.ts](../../../apps/api/src/identity-types.ts)、[identity-store.ts](../../../apps/api/src/identity-store.ts)已有 `human_users` 的 `member/admin/auditor`、`department_memberships` 的 `viewer/operator/manager + can_approve`、当前 session epoch 校验、结构化 `human_audit_events` 和 `audit_outbox`。当前 `appendHumanAudit` 的 action/resource/change 白名单只涵盖身份事件，A2 应扩展受限枚举；不能把任意请求正文塞进 `changes`。`human_audit_events` 仅应用级 append-only，不宣称抵御 DBA 篡改。
- [db.ts](../../../apps/api/src/db.ts)、[product-schema.ts](../../../apps/api/src/product-schema.ts)：`projects.department_id` 为主部门；`project_runs.project_id` 连接项目且 `department_ids` 存参与部门；`tool_approvals.run_id` 连运行；费用 `usage`/`model_reservations` 有可空 `project_id/run_id/department_id`。人工成员不是 `departments.data.agents` 中的 AI 员工，[employee-history.ts](../../../apps/api/src/employee-history.ts)也只管理 AI 员工历史。
- [knowledge.ts](../../../apps/api/src/knowledge.ts)及 [knowledge-store.ts](../../../apps/api/src/knowledge-store.ts)已有 company/department/employee 知识空间与 **AI 员工** grant。真人可读权限应在 API 入口按空间/部门判断，仍须保留运行时 `validateKnowledgeGrants`、固定文档版本和员工私有检索约束；人可读不等于 agent 可调用。
- [native-capabilities.ts](../../../apps/api/src/native-capabilities.ts)已有 namespace/manifest 固定版本与运行快照/停用检查；真人只能见获授权能力，执行还要经既有任务工具策略和注册工具 guard。插件安装、全局启停和凭据仍是管理员操作。

## 实施原则

1. 复用 A1 的 `Principal`、session 当前状态/epoch、路由清单、`principalKey`、HTTP 设备白名单以及现有 DB/事务。只补一个供路由调用的资源解析/校验模块和查询过滤；权限来自数据库中当前行，不从 URL/body 的 `departmentId`、自报 `owner` 或运行快照反向授予。
2. 只在 `active` 真人上评价权限。`pending`、`disabled`、缺失成员、未知角色/资源/路由拒绝；`auditor` 初期只读经脱敏的独立审计视图，不自动读运行正文、密钥、全部成本明细。`admin` 可管理组织，但仍过 CSRF、业务预算、工具/知识授权、风险操作确认与审计。
3. 部门角色只作用于当前 `department_memberships` 行：`viewer` 可读所属部门的已明确归属资源；`operator` 在此基础上创建/修改/执行项目；`manager` 再可改本部门设置、成员的低风险授权。非 admin 的工具审批必须在该运行的**每一个参与部门**同时具有 `operator` 或 `manager` 角色及 `can_approve=true`；单有 manager/operator、只在某一个部门有审批权、或 viewer 带审批标记均不能批准。
4. 项目和运行是跨部门整体对象。主部门与参与部门集合都必须满足相应权限；缺失、空集合、无法核对的旧快照与当前 `projects` 不一致时只限 admin，并记录修复/归属决定，不猜测。共享对象详情、附件、成本和引用不因“能看到主部门”而外泄其他部门内容。
5. 列表、计数、搜索、版本历史、引用、导出、下载、异步任务与文件系统读取都用同一资源断言；SQL 在分页/限制前筛可见 ID，不能先取全量前 50/200 再过滤。对象不存在与无权可统一 404；拒绝结果不写幂等缓存。
6. 对有副作用的操作在同一事务内锁资源及相关 membership（固定顺序）再核当前权；外部工具执行/恢复的每个新效果边界再查当前授权和 capability enablement。任务固定版本是完整性/可复现条件，不是撤权后的许可证。
7. 读取权不包含再分发权。运行导入、复制、派生文件、知识发布和经验/Skill 提炼，必须保留来源与其可见性下限，目标不能扩大来源读者范围。首版要求目标已经包含所有来源所要求的部门（仍按“全部部门有权”读取），并保留 admin-only、私有等更严格条件；不自动修改目标参与部门或给员工新增授权。缺来源绑定或尚不能传递这些条件的路径保持 admin-only 或拒绝。模型概括、改文件名或复制正文不消除来源限制。

## 最小权限矩阵与确切归属链

下表的“成员”均指 active human；V/O/M 分别是 **每个涉及部门** 当前 membership 为 viewer/operator/manager。A 是 org admin。`auditor` 不继承 V。没有明确归属链的一项保持 A-only，直到有持久迁移及负面验收。

| 资源与现有锚点 | V | O | M | A / 初期限制 |
| --- | --- | --- | --- | --- |
| 部门 `departments.id`；历史 `department_versions.department_id`；部门 workbench | 只读自己部门当前非归档概要 | V | 编辑本部门非身份配置；AI 员工历史恢复须审计 | A 可跨部门；建/删/恢复部门、归档全局列表先 A-only；版本可能含敏感员工工具/提示，需字段审查后才给 V |
| 人类账号 `human_users.id`、成员关系 `(department_id,user_id)` | 可读自己的安全 profile/所在部门；不能列全体人 | 同 V | 可列本部门成员；可增删 viewer/operator，但不得给 `can_approve`、manager/admin、自己或同级提升/撤销 | A 激活/停用、组织角色、session 撤销、授 manager/审批权；永不按 email 自动授权；必须保留最后一位 active admin |
| 项目 `projects.id → department_id` 加 `policy.allowedDepartmentIds`、`plan.agents[].sourceDepartmentId` 等参与集合 | 参与部门全为 V 时读项目、方案与版本 | 全为 O 时建/改计划/消息；生成与执行仅在既有有效预算授权内 | O；部门配置可管理 | 批准运行和跨部门项目创建先要求每个部门 O，外加既有预算与模型门禁；预算上调/挪用未分配额度先 A-only，工具 `can_approve` 不产生财务授权。若跨部门参与集合无法从持久项目与计划一致重建则 A-only |
| 运行 `project_runs.id → project_id → projects` 与 `project_runs.department_ids` | 所有参与部门 V 才可读状态、结果、trace、引用、artifact、export、recovery check | 所有参与部门 O 可取消、发起 retry/资源提案；仍须运行状态/预算检查 | O | 缺失 DB 行的 trace-only、部门集合不一致或旧档案仅 A；任何下载均先查 run ID；恢复前再次验当前权 |
| 工具审批 `tool_approvals.id → run_id → project_runs` | 可读本可见运行的已脱敏审批摘要；原 `arguments` 可能含秘密，默认不发给 V | 同 V | 同 V | 决策仅 A 或在**每个**参与部门均有 O/M 且 `can_approve=true` 的人；锁 pending/running 和权限后同事务写决定与审计。审批历史不因身份撤销被重写 |
| 工作素材 `work_file_snapshots.id → source_run_id? → run` | **仅**有 `source_run_id` 且所链运行可见的快照可读/下载 | 来源可读、目标各部门 O，且目标可见性不宽于全部来源时才可导入 | O | 任意上传、generate、`source_run_id=NULL`、全局列表中的无归属文件先 A-only；创建新持久 file scope/绑定及迁移前不得按文件名猜部门。只满足来源读取和目标写入仍不足以复制 |
| 知识空间 `knowledge_spaces.id(scope,department_id,agent_ids)` → document → revision/chunk/embedding | department 范围本部门 V 可读；company 范围需显式可见策略；employee 范围 **不**因同部门 V 自动可读 | department 范围可编辑本部门文档；搜索必须预先裁剪空间/文档 ID | O；发布工作记录需来源 run 与目标 space 均授权、保留 shareable 检查 | company 创建/修改/删除、employee 私有内容、全局 vault/sync/index/retrieval 设置先 A-only；AI 员工 grant 继续独立生效；旧/坏 scope 只 A |
| 统一能力目录 `native_capabilities.namespace/manifest_id`、员工 tools/grants | 只列本部门获授权且启用的能力元数据，不读凭据/包源码 | 可在项目中选择本部门获授权工具，且 DSH guard/版本/预算再判 | 可调整本部门员工授权（若现有部门配置允许） | 安装、启停、配置、凭据、MCP/browser 连接全局管理及测试调用先 A-only；不能用全局 enabled 推出所有成员可用 |
| 费用 `usage`/`model_reservations` 的 `run_id → project`，其次 `project_id → project`，其次单独 `department_id` | 有明确单一归属链且部门 V 时仅本部门脱敏汇总；跨部门运行明细需所有部门 V | V | V | 全局总额、无归属、链冲突、费率/上游请求标识、query-provider/reconcile 与未知费用处置先 A-only；绝不按可空 department_id 单字段覆盖冲突的 run/project |
| 计划组织预览/会话 `organization_previews.project_id? / department_id?`、`organization_conversations.preview_id?` | 仅明确绑定且所属部门 V 的可读预览；无绑定不可见 | 可生成/确认所有涉及部门 O 的预览 | O | 无归属对话、全组织自动组建先 A；创建时绑定 actor/部门才可开放成员操作 |
| 备份、存储清理、模型/网关、产品设置、设备、诊断、自动化全局规则 | 无 | 无 | 无 | A-only，直到各自有资源锚点和负面测试；`/api/health` 也 A-only，`/healthz` 仅最小活性 |
| 结构化审计 `human_audit_events` 与运行 JSONL | 仅自己可见资源的必要操作历史且脱敏（后续可选） | 同 V | 本部门汇总可读（后续可选） | A 全量脱敏查询；auditor 的独立只读审计视图可跨部门但不透出交付正文/凭据；无审计查询 API 前保持 A-only |

**查询优先级**：运行/项目外键优先于冗余 department 字段；run 的参与部门取 `project_runs.department_ids` 并与项目已批准参与集合核对；knowledge 以 space 行为准；file 只能循 `source_run_id`；approval 只能循 run；成本以 run、project、department 逐级解析，任意两条非空链冲突即拒绝成员。旧记录不能补写虚构 creator/owner。跨部门读取要求所有部门 V，写入要求所有部门 O；新增参与部门在保存方案/批准前先验新集合权限。部门归档不扩大权限。

## 路由与数据流改造顺序

1. **A1 gate 稳定后再降权**：复跑 `assertRouteInventory`，记录实际 142+ 新增身份路由。保持已登记 admin-only 与精确设备路由；对每个开放的 method/path 附一项资源解析和所需级别，未分类与 Express 匹配歧义拒绝。`GET`/`HEAD`/`OPTIONS`、大小写、尾斜杠和编码形式须与真实 handler 一致，不能只测字符串函数。
2. **当前 membership 读取与统一资源解析**：以 `human_users` 当前 active/epoch、`department_memberships` 当前行和 DB 外键为输入，返回可见/不可见或明确 `unowned/ambiguous`。先落 SQL 可见 ID 查询，再改列表、详情、导出、下载、搜索、计数。事务内写操作复核，并用负面用例锁定“主部门有权、协作部门无权”失败。
3. **最小人员管理**：管理员分页读 pending/active/disabled；按精确 user ID+version 激活/停用/改 org role/撤 session；管理 membership 的 role、can_approve、version。manager 仅在本部门管理 viewer/operator 且不能改自己、同级、审批权；可先将 manager 管人功能保持 A-only，若不能在首轮充分验收。所有变更与审计同一事务，改变权限后下一请求即失效；停用与撤 session 增加 epoch，禁止最后管理员消失。前端人员页依赖 OIDC Task 3 的登录状态和全局 CSRF 传输，可同页增量连接，不另外做登录系统。
4. **项目/运行/知识/素材依次开放**：先只读，再项目写与运行控制，最后审批；每一族同时修齐列表、明细、引用、导出与关联资源，避免部分路由泄漏。company/employee 知识与无归属素材不因部门访问而开放。跨部门项目的参与集合形成时、运行批准时和恢复时均检查。复制及派生内容需持久关联不可变来源，目标资源断言合并来源限制；列表、下载、索引和后续再复制也消费同一限制。员工知识检索亦须在读取前检查目标运行能承载来源限制，不能等交付后才阻断。来源允许的部门不是新授权，仍按真人/员工当前权限计算。首版不提供自动降密或扩大共享；确需扩大共享，须后续独立来源授权与审计流程完成后再开放，管理员普通复制也不能默默丢掉来源条件。
5. **审批及审计事务**：扩 `tool_approvals` 可空历史字段 `decided_by_user_id`、`decided_actor_kind`、`decided_actor_snapshot`、`decision_request_id`、`decision_reason`；新企业真人决策强制写人。`SELECT ... FOR UPDATE` 锁 approval/run/project/权限关联，pending 且 run running/未取消才可改；同事务写 `human_audit_events` 与 outbox，提交后投影 JSONL，按 event ID 去重。DB 写失败不得批准；JSONL 写失败留 outbox 重试。未决旧审批不补真人。
6. **其余敏感动作归责**：项目创建/方案确认/批准、运行取消/重试、预算变更、知识发布/删除、人员授权、插件/模型/设备配置、备份/恢复/清理均有 actor `human|system|device|local-owner`、request ID、resource、部门集合、变更摘要、outcome。经 UI 发起的长期运行保留 `requestedBy`；后台唤醒记录 `executedBy=system` 和原授权来源，不能伪造当前用户会话。失败/拒绝事件由独立可靠写入路径记录，不能因主事务回滚消失；成功审计与业务变更同事务。敏感参数、token、cookie、文件正文和模型密钥一概不写审计。
7. **运行时撤权**：HTTP gate 在幂等命中前检查当前 resource scope；缓存按既有 `principalKey` 分隔。agent 每次工具调用与从 checkpoint 恢复前复核当前用户/部门/员工工具 grant、能力启用和固定版本，撤权则停止新效果并留原因。已完成外部效果不回滚、不自动重放；未知结果走现有对账/批准流程。内部 system/device 只有明确机器能力，不借用浏览器 session。

## 验收与交付门禁

- 隔离 PostgreSQL + 两个真实 OIDC 测试身份：pending 无业务权限；admin 授 A 部门 viewer 后只读 A；B 部门拒绝；撤 membership/停用/epoch 后下一读、同键缓存重试、工具调用及恢复均拒绝。成员无权访问网关/备份/插件启停/无归属素材与费用；设备 key 不能访问人的 API。
- 跨部门 A+B 项目：只有 A membership 时列表不可见、ID 详情/trace/引用/导出/下载/审批均拒绝；双部门授权才开放相应级别；只撤 B 即立即失效。项目参与集合在创建、修改、批准、retry 三处分别测。SQL 分页/计数不得泄露不可见对象数量。
- 复制/派生负面验收：B viewer+A operator 尝试把 B 文件导入 A-only 项目必须拒绝；把 B 内容概括成新文件、发布知识/Skill、从派生结果再次导入也不能去掉 B 限制。A+B 目标合法导入后，仅有 A 的用户仍不能通过列表、搜索、下载或新的运行获得内容。验证员工从 B 知识读取到 A-only 运行在读取前拒绝；admin 复制保留来源约束。匿名上传或遗失来源按保守边界处理，不从文件内容猜来源。
- 跨部门审批量词验收：A operator+审批权、B operator 无审批权拒绝；A/B 都有审批标记但 B viewer 拒绝；每个部门均 O/M 且各自审批标记有效才允许。并发撤回任一部门权限时，事务不能提交批准。
- 知识 `company/department/employee` 三种 scope、AI 员工 grant 与真人可见性分别测；无 `source_run_id` 文件、trace-only 运行、冲突/空部门集合、无归属费用保持 A-only。路径和外键关联错误不能被 body/query 参数伪造。
- 并发批准与撤权竞态：只有一个 pending 决策提交；审计失败回滚批准；投影失败仍保留 outbox，重试无重复效果。验证旧审批 actor 为空而非回填管理员，审计与导出均脱敏。
- Task 3 浏览器接入完成后，实际登录、CSRF、人员/部门管理页、403/会话过期提示及登出、重启、HTTPS cookie 端到端验收；不能只用 API 单测标记企业身份完成。所有新路由纳入清单检查，需保留 A1 路由/设备/幂等负面测试。最后隔离验证，再按基础设计的发布门禁决定 JJ 上线，真实付费调用仍受独立金额/次数授权。

## 待明确产品规则与保守默认

1. **跨部门项目的可见范围**：推荐整体可见须全部参与部门会员资格；若将来需要部分视图，应先定义字段级拆分与共享审批。本轮不开放部分正文。
2. **company 知识范围**：名称不等于向全部成员公开；初期 admin 管理、成员只见经明确发布为全员可读的文档。若尚无持久发布标志，全部 company 文档先 A-only。
3. **employee 私有知识**：`agent_ids` 是 AI 员工 ID，不是人类 user ID。初期真人正文 A-only；可由获授权员工工具在固定 grant 下检索，之后若需真人直读须定义独立授权。
4. **manager 授权边界**：建议仅管理本部门低于自己角色的 viewer/operator，`can_approve` 和 manager 由 A 授；若审查发现自我授权或间接权限提升，首版 manager 管人保持 A-only。
5. **审计员**：现有 schema 有 `auditor`，但无脱敏查询/导出合同；首版不开放原业务路由，只在专用审计视图完成并验收后启用。
6. **无归属历史数据**：保留、标记、由管理员逐项核定迁移，不以首管理员、旧本机操作者或文件名补写身份；旧会话/审批/预算证据保持原状。

完成标准是上述测试和实际运行证据，而非方案文档或 A1 admin-only gate 本身。分项状态应分别标记未开始、实现中、本地已验证、JJ 已验证、真实业务已验证或受阻。
