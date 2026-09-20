# 02 系统架构

## 核心原则

1. PostgreSQL 是产品业务状态的唯一事实来源。
2. DSH 是执行引擎，不保存唯一一份部门定义。
3. 所有模型调用经过 Provider Adapter，并产生统一用量记录。
4. 所有知识检索先鉴权，再检索。
5. 高风险工具调用采用“申请—批准—执行”。
6. 每次运行保存不可变配置快照，保证结果可追溯。
7. 主模型负责提出方案；普通代码负责验证和执行硬约束。

## 逻辑组件

| 组件 | 职责 |
|---|---|
| Web | 部门配置、计划审批、运行监控 |
| API/Control Plane | 用户、部门、员工、权限和业务 API |
| Organization Planner | 调用主模型生成候选组织与任务方案 |
| Deterministic Validator | 校验模型目录、能力、预算、权限与无环 DAG |
| Organization Orchestrator | 创建运行、同步 DSH 状态、处理取消与恢复 |
| DSH Adapter | 封装 DSH 版本差异，不向业务层暴露内部对象 |
| DSH Runtime | Agent 会话、工具、模型调用与运行轨迹 |
| Agent Teams Plugin | 单部门 Captain、成员、任务 DAG 与消息 |
| Model Gateway | Provider 认证、模型目录、调用与用量标准化 |
| Knowledge Service | 导入、切片、向量化、权限过滤、引用 |
| PostgreSQL/pgvector | 业务数据、运行数据和向量索引 |
| Redis | 队列、短锁、取消信号和事件分发 |
| Artifact Store | 原始文档、生成文件与任务产物 |

## 建议 monorepo

```text
agent-department/
  apps/
    web/                     # Next.js
    api/                     # NestJS
  services/
    agent-runtime/           # DSH 启动与适配
    knowledge/               # 导入、切片与检索
  packages/
    contracts/               # DTO、事件、JSON Schema
    model-adapters/          # Provider 统一接口
    policy/                  # 权限与审批策略
    observability/           # 日志、trace、usage
  infra/
    docker/
    migrations/
  docs/
```

## 规划与执行状态流

```text
REQUEST_DRAFT -> PLANNING -> VALIDATING -> PLAN_INVALID
                                     -> AWAITING_APPROVAL
                                     -> APPROVED -> QUEUED -> RUNNING
                                     -> SUCCEEDED | FAILED | CANCELLED | NEEDS_ATTENTION
```

执行流程：

1. API 保存 ProjectRequest 和由用户设定的 ExecutionPolicy。
2. Planner 把需求、模型目录和硬约束交给主模型，得到候选 OrganizationPlan。
3. Validator 确定性检查人数、模型能力、预算、权限和任务 DAG。
4. 推荐模式进入 `AWAITING_APPROVAL`；全自动模式仅在低风险且校验通过时自动批准。
5. 批准时保存不可变 RunSnapshot，Orchestrator 再调用 DSH Adapter 创建团队。
6. DSH 事件被转换为内部统一事件并保存。
7. 经理完成汇总；系统保存交付物、引用和用量。

主模型规划阶段不能直接获得业务工具和外部写工具，只能调用受限的模型目录与规划输出接口。

## 适配层边界

业务层只能依赖以下抽象：

```ts
interface AgentRuntimeAdapter {
  validateConfiguration(input: RuntimeConfig): Promise<ValidationResult>;
  createTeam(input: TeamSnapshot): Promise<{ runtimeRunId: string }>;
  approvePlan(runtimeRunId: string): Promise<void>;
  sendMessage(runtimeRunId: string, message: string): Promise<void>;
  cancel(runtimeRunId: string): Promise<void>;
  resume(runtimeRunId: string): Promise<void>;
  getSnapshot(runtimeRunId: string): Promise<RuntimeSnapshot>;
  subscribe(runtimeRunId: string): AsyncIterable<RuntimeEvent>;
}
```

DSH 升级导致的字段或事件变化，只能在 Adapter 内处理。

## 本地部署拓扑

- `web`: 3000
- `api`: 4000
- `postgres`: 5432
- `redis`: 6379
- `dsh-runtime`: 3080，仅暴露给本机或内部网络
- `ollama`: 11434，可选

生产化前不得将 DSH 管理端口直接暴露到公网。
