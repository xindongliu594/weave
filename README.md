# 为伍

一个想法，一支团队。

v0.2 工作台：长期或一次性部门与员工、DSH AgentTeams 执行、Obsidian 知识库、运行追溯，以及 Windows/macOS 桌面客户端。新版源码支持用户授权的本机工作区文件与逐次批准的命令；后端继续管理模型、任务、费用与档案。本机模式的后端和数据保存在当前电脑；既有服务器部署仍使用 Mac 后端。

## 先体验项目雏形

Todo API 演示串起预置团队、方案批准、员工执行、命令审批、实际接口测试与交付物下载。使用固定响应模型和独立本地数据库，不需要 Docker、API Key 或线上部署；模型演示与实际测试结果在页面和档案中分别标明。

```sh
npm ci
npm --prefix services/agent-runtime ci
npm run demo
```

打开 http://127.0.0.1:4320，在首页选择“查看 Todo 示例方案”，批准项目，再在执行页逐次批准两条测试命令。Windows 安装依赖后也可双击 `start-demo.cmd`。开发自检 2 项、独立接口验收 6 项；查看并下载代码、运行说明和报告。Ctrl+C 停止，演示数据保留在 `.data/demo/<本次编号>`；每次启动创建新的演示空间。完整使用与范围见 [项目雏形](docs/mvp.md)。

此入口验证产品流程，真实模型的任务质量须另行通过验收。要在本机填写真实 API，可使用下面的本机运行入口。

## 本机使用真实 API（无需 Docker）

```sh
npm run local
```

打开 http://127.0.0.1:4310/，首页通过对话描述需求，由模型追问并生成部门和任务草案；确认后进入项目方案，再批准执行。首次使用先到“模型目录”填写中转站地址、API Key 和模型，测试连接和工具能力。Windows 可双击 `start-local.cmd`。保存配置不自动调用模型；实际模型调用由你配置的服务计费。数据库和配置保存在 `.data/local`，重启保留；新项目默认使用已有的本机 Node 执行器，命令仍逐次审批。这个入口不使用固定响应模型，也不限制写入预置 Todo 源码。使用和验证范围见 [本机运行](docs/local-run.md)。

本轮 Windows MVP 的启动、网页操作、现有数据沿用与费用核对步骤见 [简明使用说明](docs/mvp-quickstart.md)；实际通过、失败与受阻项见 [验收报告](docs/mvp-acceptance-2026-10-02.md)，变更见 [已修复问题清单](docs/mvp-fixed-issues.md)。真实正常完成记录已保留；恢复运行的经理交付仍受待核对账单阻塞，不能视为全部验收完成。

## 正式开发启动

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
2. 点击“测试 API 服务”检查目录可达性，或“获取模型与价格”读取模型列表。默认匹配核对于 2026-10-02 的官方报价维护表；未匹配单价手动填写，显示单位为 USD / 百万 Token。目录测试不推理，实际账单以服务提供方为准，见 [目录与价格](docs/model-catalog.md)。
3. 测试模型连接，再测试工具能力：文本连接成功后，主模型和备用模型都需要通过工具参数与结果的往返测试，才能批准团队执行。工具测试最多两次收费请求，有独立费用上限及记录，见 [模型能力验证](docs/model-capabilities.md)。
4. 首页“需求组建”：用对话描述目标。模型可追问，也可生成部门、岗位与任务卡片；继续补充可修订方案，确认后创建部门与项目草案。
5. 在项目方案中检查模型、工具、预算、任务及验收标准，再批准运行。复用已有部门时，在“部门与员工”提交新需求，也可以选择跨部门协作员工；协作员工沿用原部门的知识权限和费用归属。
6. 查看后端校验、历史版本并导出 JSON。已校验方案可批准并交给 DSH AgentTeams 执行；部门删除后，已有项目和运行快照继续保留。

API Key 使用本机生成的 AES-256-GCM 密钥加密保存。主密钥位于 `.data/credential.key`（0600），不要提交版本库；备份数据库时需要同时安全备份此文件。更换中转站连接会将其模型重置为待测试。

## 当前范围

已实现：组织/岗位模板、角色提示词版本、部门和单员工恢复、跨部门员工协作与任务交接、需求生成部门、方案校验与审批、持久队列和租约、参与部门单运行、模型/工具并发限流、上下文裁剪、轮次/期限/费用限制、显式检查点恢复与重试、工具权限和 Docker 隔离、终端审批、交付物预览下载、完整追溯、Obsidian 资料索引与引用、加密备份恢复。

2026-10-02 新增九项最小能力，入口为“工作能力”“项目素材”“自动化与经验”以及项目详情里的“与经理对话”：

| 能力 | 当前可用范围 | 后续边界 |
| --- | --- | --- |
| 浏览器操作 | 独立静态浏览器打开、读取、截图、选择器点击/填写；员工按批准站点只读 | 不支持 JavaScript 网站、个人登录态和写入流程 |
| MCP | Streamable HTTP 初始化、工具发现、凭证加密和逐项授权；员工仅调用批准的只读工具 | 不支持 stdio、OAuth、服务端采样或任意工具自动写入 |
| 办公文件 | 提取 DOCX/XLSX/PPTX 文本，生成简单 DOCX/XLSX/CSV | 不支持 PDF/OCR、复杂排版和公式重算 |
| 导入已有目录 | 浏览器选择目录生成不可变快照，按文件和员工授权，选定文本可复制到独立 Run 工作区 | 不回写原目录，不继承凭证、链接或依赖目录 |
| 经理持续对话 | 持久多轮消息，运行结束后回复，单次及项目预算约束 | 对话建议需另行保存方案并批准 |
| 定时任务与结果通知 | 单次/间隔计划、暂停恢复取消、重启补检和应用内已读通知 | 到期只建待批准草案；没有外部推送 |
| 长期监督 | 跨重启每小时状态/费用快照和终态记录 | 不延长运行时限；多日行为仅经虚拟时钟验证 |
| 知识整理 | 固定授权版本的摘录、来源去重、人工审查后发布回原空间 | 不自动判断事实或扩大授权 |
| 改进评测 | 固定案例前后规则评分、人工采纳与回滚记录 | 输出需人工提供；不自动修改员工提示与权限 |

使用说明：[浏览器与 MCP](docs/browser-mcp.md)、[项目素材与办公文件](docs/work-files.md)、[经理对话](docs/manager-chat.md)、[自动化与经验整理](docs/automation-learning.md)。

- [Obsidian 配置与同步](docs/obsidian.md)
- [项目策略与执行授权](docs/execution-policy.md)
- [文件合同、版本核验与质量任务](docs/reliable-handoff.md)
- [v0.2 验收与使用说明](docs/v0.2.md)
- [功能清单](docs/completion-plan.md)
- [下一阶段待办：员工运行时调整与桌面本机操作](docs/next-stage-plan.md)
- [员工独立运行时与核心 CI](docs/employee-runtime.md)
- [员工上下文管理配置与验收边界](docs/context-management.md)
- [受控返工、独立复验与额度继承](docs/controlled-rework.md)
- [运行心跳、停滞检测与安全恢复](docs/runtime-recovery.md)
- [DAG 断点恢复与工作上下文](docs/checkpoint-resume.md)
- [桌面本机文件与命令：授权、执行流程与恢复边界](docs/local-execution.md)

模型预算采用输入字节数与最大输出的保守预留，实际费用按返回 Token 和配置单价记录。价格以中转站实际账单为准。备用模型仅在明确 HTTP 429/503 后切换一次，必须提前配置；不自动重放结果未知的请求。规划、连接测试和执行共用持久费用预留及全局/部门每日限额；未知费用保留至用户核对。

当前上下文管理支持员工独立测量、工具结果缩减和自动摘要，需填写模型上下文容量才能自动摘要；普通请求仍有字节保护，完整来源保留在追溯中。恢复依赖已完成任务检查点，未完成操作可能重复，必须人工确认。知识检索支持关键词与本地多语言向量混合检索，按批准时的员工授权、文档版本和本次资料范围查询；运行详情可查看引用原文。旧运行保留原先检索方式。尚未实现 OCR 或多媒体解析。默认终端在无网络 Docker 容器内执行，需要预装依赖的项目应预先准备镜像。项目也可显式选择本机设备；本机命令使用系统当前用户权限，能够访问工作区外的资源，仍需逐次批准。

独立实现审查可在批准方案中授权最多两轮自动返工。原员工修复、原审查员工独立复验，共用原任务的费用和调用上限；越界、超限或明确拒绝时停止并交给用户处理。已独立验收的返工结果可作为恢复检查点，中途修复/复验仍需检查后完整重试，额度继续累计，见 [受控返工](docs/controlled-rework.md)。程序监控重复动作、连续错误和无进展，区分模型/审批等待；短暂只读错误有限重试，修改结果未知时先停止核对，见 [异常恢复](docs/runtime-recovery.md)。

任务可配置独立费用和调用次数上限，执行侧同时检查任务与项目预留；70% 提醒、90% 限制重试、100% 停止新调用。同一方案重试保留已用次数与任务费用。部门日预算、规划预留、未知费用核对见 [预算说明](docs/budgets.md)。

桌面客户端连接服务器，不内嵌后端。已打包 Windows x64、macOS arm64/x64；macOS 连接操作已验证，Windows 原生 CI 已通过安装、登录、隔离、重连和卸载；商业签名/Apple 公证尚未完成。早期真实模型 Todo 验证的三次运行均未完成端到端验收；最后一轮测试命令通过，但交接未完成，独立 Windows CLI 启动也未通过，见 [早期真实 Todo 验证记录](docs/real-todo-validation-2026-10-02.md)。随后正常运行 `99551bf3-94f0-464a-8cd7-6935ad679ab8` 完成开发、独立测试和经理验收，最新完成与恢复受阻证据见 [本轮 MVP 验收报告](docs/mvp-acceptance-2026-10-02.md)。不能把测试命令成功或模拟流程通过视为真实项目通过。

新版桌面端可通过“工作空间 → 本机执行设置”选择父目录、启用设备，再在项目策略中选择执行位置并重新批准。每次运行创建独立子目录，文件和命令回传后进行已有的合同验收与交接；断线或进程重启只补交回执，修改结果未知时先人工核对。当前源码另有上述隔离浏览器和目录快照导入；通用桌面应用键鼠控制尚未实现。线上旧安装包和部署尚未更新，需使用对应源码构建和后端。

## 检查

固定文件的无模型 API 交接验证：`npm run test:handoff`。覆盖依赖等待、同一员工继续任务、文件版本传递及预设修复链；缺文件拒绝完成，过期输入在下游模型请求前阻塞。资料和边界见 [固定文件测试](tests/fixtures/offline-handoff/README.md) 与 [可靠交接说明](docs/reliable-handoff.md)。首次运行需安装下方的 runtime 依赖。

```sh
npm run build
python3 scripts/install-embedding-model.py
npm test
cd services/agent-runtime
npm ci
cd ../..
npm run runtime:inspect
npm run runtime:test
scripts/verify-clean-install.sh
```

无需 PostgreSQL、Docker 或付费模型的跨平台检查：`npm run test:rules`、`npm run runtime:test:portable`、`npm run test:integration`。核心 CI 自动在 Windows、macOS、Linux 检查这些路径，并以独立 Linux 作业验证真实 PostgreSQL、Docker 沙箱与本地嵌入模型；工作流与本地验证边界见 [员工独立运行时](docs/employee-runtime.md)。

`test:integration` 为每个文件创建独立内存 PGlite 和临时凭证目录，防止单后端的会话参数造成跨文件污染；直接使用 PostgreSQL 的测试采用随机 schema。本地协议测试服务器不调用付费模型。浏览器集成项在已安装 Chrome/Edge/Chromium 时运行实际隔离浏览器，未安装时明确跳过该项。语义测试使用真实本地模型，须先按上方命令下载约 136 MB 固定文件；下载完成后推理无需网络。数据库迁移需要有安装 pgvector 扩展的权限（默认开发数据库已满足）。干净安装脚本会重新安装锁定依赖并创建临时 Compose 卷；需联网、Docker 和可用磁盘空间。默认数据库/API/网页端口分别为 55432/4311/4310，可通过 `POSTGRES_PORT`、`API_PORT`、`WEB_PORT` 覆盖。

2026-10-02 本地分组回归：API/扩展 54 项加原产品流程 15 项，共 69 项集成检查；便携运行时 70 项、规则 25 项，合计 164 项通过。隔离 Chrome 的 10 项入口、表单与移动端检查通过，无页面/API 错误；最终 TypeScript/Vite 构建通过。具体范围见 [完成度复核](docs/completion-audit.md)。新增源码尚不代表线上版本或本轮云端 CI 已更新。

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

无需外部模型与 Docker 的产品流程复验：`npm run test:integration`。该命令使用 PGlite、模拟 HTTP 模型和固定文件执行器，验证 API、审批、交接、取消与用量。测试边界及实际结果见 [模拟产品流程验证](docs/simulated-product-flow.md)。真实 PostgreSQL 并发锁、Docker 隔离与部署验收仍单独执行。

打开 `http://127.0.0.1:4310/#run`，可以查看正式项目和无 API 验证的员工提示词、任务指令、模型请求、工具调用与团队结果。运行档案保存在 `.data/runs`，重启后可读取；失去进程租约的 Run 标记为中断，可经人工确认后从任务检查点恢复。测试模型记录会明确标注。详见 [执行追溯说明](docs/execution-trace.md)。
