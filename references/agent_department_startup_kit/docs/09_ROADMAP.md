# 09 开发路线

## Phase 0：技术验证（3–5天）

- 锁定 Node.js、DSH、dsh-agent-teams 版本。
- 跑通三个不同模型成员的标准场景。
- 验证停止、重启、事件和用量。
- 输出 Go/No-Go 结论和兼容性记录。
- 用约束 Schema 跑通“需求 → 自动方案 → 校验 → 批准”。

## Phase 1：控制面骨架（1周）

- 创建 monorepo、CI、格式化和基础测试。
- PostgreSQL migration。
- Department、AgentProfile、ModelConfig API。
- Runtime Adapter 接口和 mock 实现。
- Provider 密钥与模型目录。
- ProjectRequest、ExecutionPolicy、PlanningRun 和 OrganizationPlan API。
- 确定性方案校验器及测试。

## Phase 2：单部门闭环（1–2周）

- DSH Adapter 实现。
- 创建 TeamRun 和快照。
- 计划生成与批准。
- 任务、消息、事件同步。
- 取消、错误和基础恢复。

## Phase 3：知识库与权限（1–2周）

- 文档导入、切片、Embedding 和检索。
- 公司/部门 Grant。
- `knowledge_search` 与引用。
- 工具权限和审批记录。

## Phase 4：完整 MVP UI（1–2周）

- 部门和员工编辑器。
- 模型与知识库选择器。
- 计划审批。
- 运行监控、消息、用量和交付物页面。
- 安装脚本与本地使用说明。

## 开发里程碑

- M0：命令行 JSON 成功运行三 Agent 部门。
- M1：数据库可保存部门和不可变 Run 快照。
- M2：浏览器完成单部门任务闭环。
- M3：RAG 权限和引用闭环。
- M4：本地一键启动并通过验收测试。

## 首批 Backlog

1. 建立 ProjectRequest 和 ExecutionPolicy Schema。
2. 建立 ModelCatalogSnapshot 和确定性校验器。
3. 建立 OrganizationPlan Schema 与规划提示协议。
4. 建立 `AgentRuntimeAdapter` 契约和 Mock。
5. 进行 DSH 多模型 Team Spike。
6. 记录 DSH 事件到统一 Event 表。
7. 实现 Run 状态机、批准和取消。
8. 实现知识授权过滤。
9. 实现 Token/费用聚合。
10. 完成自动规划研发部 E2E。
