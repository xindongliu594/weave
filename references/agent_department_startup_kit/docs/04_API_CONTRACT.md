# 04 API 契约

API 前缀：`/api/v1`。错误统一返回 `code`、`message`、`requestId` 和可选 `details`。

## 项目需求与组织方案

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/project-requests` | 保存需求、模式和执行硬约束 |
| POST | `/project-requests/{id}/plans` | 请求主模型生成候选方案 |
| GET | `/organization-plans/{id}` | 获取完整方案和费用估算 |
| PATCH | `/organization-plans/{id}` | 用户编辑并生成新版本 |
| POST | `/organization-plans/{id}/validate` | 运行确定性校验 |
| POST | `/organization-plans/{id}/approve` | 批准方案并创建 TeamRun |
| POST | `/organization-plans/{id}/regenerate` | 带用户反馈重新规划 |

`approve` 必须检查当前方案版本、ValidationResult 版本和模型目录版本；任一变化都要求重新校验。

## 部门

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/departments` | 创建部门 |
| GET | `/departments` | 查询部门 |
| GET | `/departments/{id}` | 部门详情 |
| PATCH | `/departments/{id}` | 修改部门 |
| POST | `/departments/{id}/archive` | 归档部门 |
| POST | `/departments/{id}/validate` | 验证模型、工具、知识库配置 |

写接口要求 `Idempotency-Key`。修改接口要求提交当前 `version`，避免覆盖并发编辑。

## 员工

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/departments/{id}/agents` | 添加员工 |
| PATCH | `/agents/{id}` | 修改员工 |
| POST | `/agents/{id}/archive` | 归档员工 |
| POST | `/agents/{id}/model/test` | 测试所选模型 |

## 模型目录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/model-providers` | 已配置 Provider |
| GET | `/models?provider=` | 可选模型及能力 |
| GET | `/model-catalog/snapshot` | 返回规划器可选模型的不可变目录快照 |
| POST | `/credentials` | 保存密钥并返回引用 |
| DELETE | `/credentials/{id}` | 删除密钥 |

模型能力至少包含：工具调用、视觉、上下文长度、推理强度、结构化输出和可用状态。

## 知识库

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/knowledge-bases` | 创建知识库 |
| POST | `/knowledge-bases/{id}/documents` | 上传文档 |
| GET | `/knowledge-bases/{id}/documents` | 查看文档与索引状态 |
| POST | `/knowledge-bases/{id}/search` | 调试检索结果 |
| PUT | `/knowledge-bases/{id}/grants` | 设置授权 |

## 运行

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/departments/{id}/runs` | 完全自定义模式下直接创建 Run |
| GET | `/runs/{id}` | 获取快照与当前状态 |
| POST | `/runs/{id}/approve` | 批准计划并运行 |
| POST | `/runs/{id}/messages` | 向经理发送补充信息 |
| POST | `/runs/{id}/cancel` | 请求停止 |
| POST | `/runs/{id}/resume` | 恢复可恢复运行 |
| GET | `/runs/{id}/events` | SSE 事件流 |
| GET | `/runs/{id}/artifacts` | 交付物列表 |
| GET | `/runs/{id}/usage` | Token 和费用汇总 |

## 事件信封

```json
{
  "eventId": "evt_...",
  "runId": "run_...",
  "sequence": 101,
  "type": "task.updated",
  "occurredAt": "2026-09-14T12:00:00Z",
  "actor": {"type": "agent", "id": "agent_..."},
  "payload": {}
}
```

首批事件类型：

- `run.status_changed`
- `plan.created`
- `plan.approved`
- `agent.status_changed`
- `task.created`
- `task.updated`
- `message.created`
- `tool.approval_requested`
- `tool.completed`
- `artifact.created`
- `usage.recorded`
- `runtime.warning`
