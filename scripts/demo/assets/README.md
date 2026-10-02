# Todo API 演示交付物

需要 Node.js 22.19 或 24 及以上版本，无第三方运行依赖。把下载的文件保存在同一目录。

启动：`node todo.mjs`，访问 `http://127.0.0.1:3000/health`。用 `TODO_PORT` 环境变量可以调整端口。

开发自检：`node --test smoke.test.mjs`。

独立验收：`node --test acceptance.test.mjs`。

| 请求 | 行为 |
|---|---|
| GET /health | 健康检查 |
| GET /todos | 列表 |
| POST /todos | 创建，JSON 包含 title，可选 completed |
| GET /todos/:id | 查询 |
| PATCH /todos/:id | 更新 title / completed |
| DELETE /todos/:id | 删除 |

此项目使用内存存储，重新启动后清空 Todo。未知字段、空标题、错误类型和无效 JSON 会被拒绝。

代码来自固定响应演示服务，用于体验团队分工、实际测试和交付流程。它没有调用真实模型，也不代表真实模型能独立完成相同任务。
