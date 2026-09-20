# 多模型 Agent 部门平台：项目启动包

版本：0.2（自动组织规划版）  
目标：在本地构建一个多模型 Agent 部门平台。用户提交项目需求与预算约束后，主模型可以自动设计部门、角色、模型和任务；用户也可以编辑方案或完全自定义。

## 1. 项目定位

平台提供三种模式：

- 推荐方案：主模型生成组织与任务方案，用户编辑或批准后执行（默认）。
- 全自动：方案通过系统硬校验且风险较低时自动执行。
- 完全自定义：用户自行设置部门、员工、模型和任务。

每名员工由角色、模型、知识库、工具、权限和预算共同定义。主模型只在系统给定的模型目录和执行策略内规划，不能扩大预算、权限或模型白名单。

本项目采用“业务控制面与 Agent 执行引擎分离”的设计：

- 产品后端保存用户、部门、员工、任务、权限、用量等权威业务状态。
- 组织规划器调用主模型，把项目需求转为结构化组织方案。
- 确定性校验器检查模型、预算、权限和任务 DAG，模型不能绕过。
- DSH 作为可替换的 Agent Runtime。
- dsh-agent-teams 用于单个部门内部的 Captain/Member 协作。
- 独立知识服务提供公司、部门和员工三级 RAG。
- 统一模型网关屏蔽不同模型供应商的接口差异。

## 2. 启动包内容

| 文件 | 用途 |
|---|---|
| `docs/01_MVP_PRD.md` | MVP 产品需求与边界 |
| `docs/02_ARCHITECTURE.md` | 系统架构、组件边界与执行流程 |
| `docs/03_DOMAIN_DATA.md` | 领域模型与数据库设计 |
| `docs/04_API_CONTRACT.md` | 第一版 HTTP/SSE API 契约 |
| `docs/05_AGENT_PROTOCOL.md` | Agent、部门、模型与调度协议 |
| `docs/06_RAG_DESIGN.md` | 分层知识库与检索权限设计 |
| `docs/07_SECURITY_COST.md` | 权限、安全、密钥和成本控制 |
| `docs/08_TEST_ACCEPTANCE.md` | 技术验证、测试计划与验收标准 |
| `docs/09_ROADMAP.md` | 分阶段开发计划与工作拆分 |
| `docs/10_RISKS_DECISIONS.md` | 风险清单与冻结决策 |
| `docs/11_DEPENDENCY_DUE_DILIGENCE.md` | 上游依赖、许可证和版本锁定要求 |
| `docs/12_AUTO_ORGANIZATION_PLANNING.md` | 主模型自动组建部门与任务的完整协议 |
| `schemas/*.json` | 部门与员工配置 JSON Schema |
| `examples/software-department.yaml` | 软件研发部示例配置 |
| `examples/project-request.yaml` | 用户只提交需求与上限的示例 |
| `examples/generated-organization-plan.yaml` | 生成并校验后的组织方案示例 |
| `compatibility-lock.template.md` | DSH Spike 后填写的兼容性记录 |
| `.env.example` | 本地环境变量模板 |
| `docker-compose.dev.yml` | 本地基础设施模板 |

## 3. 推荐本地技术栈

- Web：Next.js + TypeScript
- API/控制面：NestJS + TypeScript
- Agent Runtime：DeepSeek Harness（DSH）
- 部门协作：dsh-agent-teams
- 数据库：PostgreSQL
- 向量检索：pgvector
- 队列与运行锁：Redis
- 文件存储：本地目录；产品化后切换 MinIO/S3
- 模型接入：自建轻量 Provider Adapter；后期可接统一网关
- 本地部署：Docker Compose

选择 TypeScript 作为主语言，是为了降低 DSH/Cordis 插件、后端和前端之间的类型与集成成本。

## 4. 开工顺序

1. 完成 `docs/08_TEST_ACCEPTANCE.md` 中的 DSH 技术验证。
2. 记录并锁定可工作的 DSH、Node.js、dsh-agent-teams 版本组合。
3. 创建 monorepo：`apps/web`、`apps/api`、`services/agent-runtime`、`packages/contracts`。
4. 先实现“项目需求 → 主模型生成方案 → 后端校验 → 用户批准”。
5. 再实现“三个不同模型员工 → 执行任务 → 返回结果”。
6. 最后接完整 RAG、审批和 UI。

## 5. MVP 完成定义

MVP 必须能够：

- 用户创建、修改和归档部门。
- 用户可只输入项目需求、费用上限和执行偏好。
- 主模型从真实模型目录生成结构化组织方案。
- 后端能确定性拒绝超预算、越权或无效方案。
- 用户指定经理及员工数量、角色和模型。
- 每位员工绑定不同知识库与工具权限。
- 经理生成任务计划，经用户批准后运行。
- 展示任务状态、Agent 消息、模型用量和交付物。
- 支持停止任务，并在服务重启后恢复到可解释状态。
- 任何高风险外部写操作都不能绕过人工审批。

## 6. 当前不做

- 无限组织层级和 Agent 自主招聘。
- 完整商业计费与支付。
- Kubernetes 多集群调度。
- 无人值守的外部发送、部署或删除操作。
- 将 DSH 内部文件作为产品业务数据库。
