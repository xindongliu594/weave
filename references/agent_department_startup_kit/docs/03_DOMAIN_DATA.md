# 03 领域模型与数据设计

## 核心实体

### ProjectRequest

- `id`
- `company_id`
- `requirement`
- `creation_mode`: `recommended | automatic | custom`
- `quality_preference`: `economy | balanced | quality | custom`
- `execution_policy_id`
- `status`

### ExecutionPolicy

- `max_budget`
- `currency`
- `max_agents`
- `max_concurrent_agents`
- `deadline_seconds`
- `allowed_model_ids`
- `allowed_tool_ids`
- `allowed_knowledge_base_ids`
- `network_policy`
- `external_write_policy`
- `approval_policy`

### PlanningRun / OrganizationPlan

- PlanningRun：主模型、输入目录版本、Token、费用、状态和错误。
- OrganizationPlan：部门、经理、员工、模型、任务 DAG、费用估算与风险。
- 每次重新生成或用户编辑都创建新版本，不覆盖旧版本。
- 只有通过校验的一个版本可以被批准并生成 TeamRun。

### Company

- `id`
- `name`
- `status`
- `created_at`

### Department

- `id`
- `company_id`
- `name`
- `description`
- `goal`
- `status`
- `version`

### AgentProfile

- `id`
- `department_id`
- `name`
- `role_type`: `manager | member`
- `role_title`
- `instructions`
- `expected_outputs`
- `model_config_id`
- `tool_policy_id`
- `budget_policy_id`
- `status`
- `version`

### ModelConfig

- `id`
- `provider`
- `model`
- `reasoning_effort`
- `credential_ref`
- `base_url_ref`
- `timeout_seconds`
- `fallback_config_id`

### KnowledgeBase / KnowledgeGrant

- KnowledgeBase：名称、层级、Embedding 配置和状态。
- KnowledgeGrant：主体、知识库、许可动作和过滤范围。

### TeamRun

- `id`
- `department_id`
- `runtime_type`
- `runtime_run_id`
- `status`
- `input`
- `snapshot_json`
- `plan_json`
- `started_at`
- `finished_at`
- `cancel_requested_at`
- `failure_code`

### Task

- `id`
- `team_run_id`
- `subject`
- `description`
- `assignee_agent_snapshot_id`
- `status`
- `attempt`
- `dependencies_json`
- `acceptance_criteria_json`
- `result_json`

### Event / Message / Artifact / Usage

- Event：统一运行事件，按 `team_run_id + sequence` 排序。
- Message：Agent 间或用户与 Agent 的消息。
- Artifact：输入文档、生成文件、报告和引用清单。
- Usage：Provider、模型、输入/输出 Token、费用、延迟和错误。

## 必须保存配置快照

Run 创建时把以下内容复制进 `snapshot_json`：

- 部门版本
- 所有员工角色文本
- 每位员工的模型和推理强度
- 工具白名单与审批策略
- 知识库授权
- 预算与最大轮数
- DSH 与插件精确版本
- 原始 ProjectRequest、ExecutionPolicy 和批准的 OrganizationPlan 版本
- 规划模型、模型目录版本和校验结果

之后用户修改部门配置，不能改变历史 Run。

## 关键约束

- 同部门的 `role_type=manager` 最多一个处于 active。
- Event 的 `(team_run_id, sequence)` 唯一。
- Usage 必须关联 Run；能关联 Agent/Task 时也一并保存。
- 密钥正文不能出现在 ModelConfig、RunSnapshot、日志或消息中。
- 所有删除默认软删除，Artifact 按数据保留策略清理。
- OrganizationPlan 不能直接执行；必须先产生通过状态的 ValidationResult。
- 主模型输出的预算和权限只能小于或等于 ExecutionPolicy，不能作为新授权来源。

## 首批数据库索引

- `department(company_id, status)`
- `agent_profile(department_id, status)`
- `team_run(department_id, created_at desc)`
- `task(team_run_id, status)`
- `event(team_run_id, sequence)`
- `usage(team_run_id, created_at)`
- 向量表：`embedding vector(...)` + 对应 pgvector 索引
