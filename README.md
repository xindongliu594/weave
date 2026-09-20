# Agent Department

v0.2 工作台：长期或一次性部门与员工、DSH AgentTeams 执行、Obsidian 知识库、运行追溯，以及 Windows/macOS 远程桌面客户端。后端和数据保存在 Mac，网页和下载文件部署在现有服务器。

## 启动

需要 Docker Desktop 和 Node.js `^22.19.0 || >=24`。在当前电脑上可双击 `start.command`，它也会发现相邻 `ylab-dsh-lab` 的既有 Node 工具链。

```sh
docker compose -p agent-department -f infra/compose.yml up -d --wait
npm ci
npm --prefix services/agent-runtime ci
npm run dev
```

浏览器打开 http://127.0.0.1:4310 。API 监听 127.0.0.1:4311，数据库映射到 127.0.0.1:55432。终端 Ctrl+C 停止前后端；数据库通过 `docker compose -p agent-department -f infra/compose.yml stop` 停止，数据卷保留。API 自身没有账号体系，不应直接暴露公网；服务器部署使用 HTTPS 登录代理和 SSH 隧道。

本地预览或 SSH 转发可使用动态端口（例如 `http://localhost:54234`）。网页通过构建 base 下的 `api` 路径访问后端；代理应保留浏览器的 `Origin` 和 `Sec-Fetch-Site` 请求头。动态回环来源仅在 `Sec-Fetch-Site: same-origin` 时放行，其他来源仍被拒绝；无该标记的浏览器请使用固定的本地 4310 端口。

已部署的服务器入口：<https://47.88.76.167/agent-department/>。前端在服务器，后端和数据仍在 Mac；登录信息、后台服务、更新及停用方式见 [部署说明](docs/deployment.md)。已安装后台服务时，只调前端请使用 `npm run dev:web`，避免重复占用后端端口。

## 使用流程

1. 模型目录 → 接入中转站：填写名称、Base URL、API Key。Base URL 是完整 API 前缀，例如 `https://relay.example/v1`，不含 `/chat/completions`。
2. 添加模型：调用中转站的 `GET /models` 获取列表，也可以手动输入模型 ID。填写中转站的 USD / 百万 Token 单价。
3. 测试模型连接：发起真实的少量 Token 文本请求；此项不证明工具调用能力。
4. 创建部门：配置一位经理与 0–5 位员工，分配模型、职责和工具配置。
5. 新建项目：提交需求与预算，保存手动草案。可以选择规划模型生成 AI 方案，或直接编辑任务和成员模型。
6. 查看后端校验、历史版本并导出 JSON。已校验方案可批准并交给 DSH AgentTeams 执行；部门删除后，已有项目和运行快照继续保留。

API Key 使用本机生成的 AES-256-GCM 密钥加密保存。主密钥位于 `.data/credential.key`（0600），不要提交版本库；备份数据库时需要同时安全备份此文件。更换中转站连接会将其模型重置为待测试。

## 当前范围

已实现：组织/岗位模板、角色提示词版本、归档恢复、需求生成部门、方案校验与审批、持久队列和租约、部门单运行、模型/工具并发限流、上下文裁剪、轮次/期限/费用限制、显式检查点恢复与重试、工具权限和 Docker 隔离、终端审批、交付物预览下载、完整追溯、Obsidian 资料索引与引用、加密备份恢复。

- [Obsidian 配置与同步](docs/obsidian.md)
- [v0.2 验收与使用说明](docs/v0.2.md)
- [功能清单](docs/completion-plan.md)

模型预算采用输入字节数与最大输出的保守预留，实际费用按返回 Token 和配置单价记录。价格以中转站实际账单为准。备用模型仅在明确 HTTP 429/503 后切换一次，必须提前配置；不自动重放结果未知的请求。规划、连接测试和执行共用持久费用预留及全局/部门每日限额；未知费用保留至用户核对。

当前上下文管理会移除较早的完整对话组，保留完整追溯；不是模型摘要或无限记忆。恢复依赖已完成任务检查点，未完成操作可能重复，必须人工确认。知识检索支持关键词与本地多语言向量混合检索，按批准时的员工授权、文档版本和本次资料范围查询；运行详情可查看引用原文。旧运行保留原先检索方式。尚未实现 OCR 或多媒体解析。终端在无网络 Docker 容器内执行，需要预装依赖的项目应预先准备镜像。

任务可配置独立费用和调用次数上限，执行侧同时检查任务与项目预留；70% 提醒、90% 限制重试、100% 停止新调用。同一方案重试保留已用次数与任务费用。部门日预算、规划预留、未知费用核对见 [预算说明](docs/budgets.md)。

桌面客户端连接服务器，不内嵌后端。已打包 Windows x64、macOS arm64/x64；macOS 连接操作已验证，Windows 原生 CI 已通过安装、登录、隔离、重连和卸载；商业签名/Apple 公证尚未完成。真实模型全流程验收按用户要求留待后续。

## 检查

```sh
npm run build
python3 scripts/install-embedding-model.py
npm test
cd services/agent-runtime
npm ci
cd ../..
npm run runtime:inspect
npm run runtime:test
```

测试使用当前数据库内随机命名的独立 schema、临时凭证目录和本地协议测试服务器，完成后清理，不调用付费模型。语义测试使用真实本地模型，须先按上方命令下载约 136 MB 固定文件；下载完成后推理无需网络。数据库迁移需要有安装 pgvector 扩展的权限（默认开发数据库已满足）。真实中转站与多 Agent Todo API 验收尚未完成。

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

打开 `http://127.0.0.1:4310/#run`，可以查看正式项目和无 API 验证的员工提示词、任务指令、模型请求、工具调用与团队结果。运行档案保存在 `.data/runs`，重启后可读取；失去进程租约的 Run 标记为中断，可经人工确认后从任务检查点恢复。测试模型记录会明确标注。详见 [执行追溯说明](docs/execution-trace.md)。
