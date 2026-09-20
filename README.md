# Agent Department

本地网页版的首个开发切片：可持久化的部门、员工、项目方案，以及一个 API 中转站接入多个模型。页面沿用用户提供的原型设计方向。用户可以保留或删除部门和员工，已有项目快照继续保留；部门知识沉淀留待后续版本。

## 启动

需要 Docker Desktop 和 Node.js `^22.19.0 || >=24`。在当前电脑上可双击 `start.command`，它也会发现相邻 `ylab-dsh-lab` 的既有 Node 工具链。

```sh
docker compose -p agent-department -f infra/compose.yml up -d --wait
npm ci
npm --prefix services/agent-runtime ci
npm run dev
```

浏览器打开 http://127.0.0.1:4310 。API 监听 127.0.0.1:4311，数据库映射到 127.0.0.1:55432。终端 Ctrl+C 停止前后端；数据库通过 `docker compose -p agent-department -f infra/compose.yml stop` 停止，数据卷保留。当前仅支持本机单用户，不能直接作为公网服务部署。

## 使用流程

1. 模型目录 → 接入中转站：填写名称、Base URL、API Key。Base URL 是完整 API 前缀，例如 `https://relay.example/v1`，不含 `/chat/completions`。
2. 添加模型：调用中转站的 `GET /models` 获取列表，也可以手动输入模型 ID。填写中转站的 USD / 百万 Token 单价。
3. 测试模型连接：发起真实的少量 Token 文本请求；此项不证明工具调用能力。
4. 创建部门：配置一位经理与 0–5 位员工，分配模型、职责和工具配置。
5. 新建项目：提交需求与预算，保存手动草案。可以选择规划模型生成 AI 方案，或直接编辑任务和成员模型。
6. 查看后端校验、历史版本并导出 JSON。纯文本方案可批准并交给 DSH AgentTeams 执行；部门删除后，已有项目和运行快照继续保留。

API Key 使用本机生成的 AES-256-GCM 密钥加密保存。主密钥位于 `.data/credential.key`（0600），不要提交版本库；备份数据库时需要同时安全备份此文件。更换中转站连接会将其模型重置为待测试。

## 当前范围

已实现：部门及员工管理、PostgreSQL 持久化、中转站配置与加密密钥、模型发现/手动添加、真实文本连接测试、真实组织规划调用、任务 DAG 与预算基础校验、方案版本、正式 Run 快照、DSH AgentTeams 纯文本执行、中转站工具调用转换、取消、执行用量及完整追溯。

尚未实现：文件/终端工具的执行侧权限隔离、进程重启后的运行恢复、AgentTeams 调度并发限流、知识库、文件交付物收集和全自动模式。正式 Run 当前只接受工具权限为空且并发上限不少于员工数的方案；不满足时审批接口明确拒绝，不会静默降级。

当前规划只接受一次模型返回，不自动重试。规划和执行都会按输入字节数与输出上限保守预留；并发请求共享同一个 Run 预算。中转站若不返回标准 Token 用量，规划或执行将失败。实际账单、缓存折扣和非 Token 计费仍以具体中转站为准。

用户先创建部门，再生成项目方案；从需求直接生成并保存全新部门的入口是下一步。规划器可调整方案内角色，暂不反向覆盖保留的部门配置。第一切片采用 React/Vite + Express 模块化后端，保留 TypeScript、PostgreSQL 与独立 DSH Adapter；不增加暂时不需要的 Redis 或服务拆分。

## 检查

```sh
npm run build
npm test
cd services/agent-runtime
npm ci
cd ../..
npm run runtime:inspect
npm run runtime:test
```

测试使用当前数据库内随机命名的独立 schema、临时凭证目录和本地协议测试服务器，完成后清理，不调用付费模型。真实中转站与多 Agent Todo API 验收尚未完成。

独立 DSH 团队运行验证已通过：审批隔离、两位成员按依赖执行、结果传递、历史恢复及 Host 关闭取消。产品审批桥已经接入 OpenAI Compatible 中转站；自动化验收使用本地协议服务，不代表某个具体中转站和模型已经通过真实工具调用测试。具体证据和未覆盖范围见 [运行验证记录](docs/runtime-spike.md)。

## 目录

- `apps/web`：产品界面。
- `apps/api`：管理 API、规划与 Provider 接入。
- `packages/contracts`：共享字段和确定性校验。
- `services/agent-runtime`：独立锁定的 DSH / AgentTeams 依赖与 Adapter。
- `infra`：本地 PostgreSQL/pgvector。
- `references`：用户提供的启动包和原型，仅作为参考资料。
- `docs`：已确认的范围与运行时验证记录。

## 执行追溯

打开 `http://127.0.0.1:4310/#run`，可以查看正式项目和无 API 验证的员工提示词、任务指令、模型请求、工具调用与团队结果。运行档案保存在 `.data/runs`，重启后可读取；执行中的 Run 在服务重启后尚不能恢复。测试模型记录会明确标注。详见 [执行追溯说明](docs/execution-trace.md)。
