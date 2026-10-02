# Windows 本机启动与恢复进度

2026-10-02；基于 `origin/main 0befc094953880b6b3ede88506f6fa3e41088e85`。保留既有主数据、服务、凭据与权限，没有调用收费模型或补写员工交付。

## 已完成

- 复核 `scripts/local.mjs`、`local-api.ts`、`start-local.cmd`、运行协调器、检查点与本机回执实现。Windows 网页入口使用 PGlite 与 Node 本机执行器，不依赖 macOS、Docker 或桌面 UI。
- 加入 `npm run local -- '--data-dir=绝对路径'`。默认仍为仓库 `.data/local`；参数必须为唯一非空绝对路径；`local:check` 明确拒绝覆盖。指定原目录时沿用原数据库、加密配置、工作区和已有设备授权，原有 `launcher.lock` 防止双开。
- 使用说明在 `docs/local-run.md`。未停止主目录运行中的服务，也未复制密钥。
- `node --import tsx --test tests/local-launcher.test.ts`：5/5 通过。验证参数说明、检查隔离拒绝、相对/空路径拒绝、重复参数拒绝、带空格绝对路径沿用已有锁且不创建新数据库。
- `npm run local:check`：退出码 0。实际本机文件写入、逐次审批后的 Node 命令、成果下载、两次 API 重启、配置与设备授权保留、完成节点不重放，以及停用设备不被重启重新启用均通过。固定协议模型，不作为真实模型业务验收。

## 本机检查证据

- 检查空间：`.data/local-check/31c5d67e-530b-4157-ba87-034b1b364906`。
- 运行 ID：`28434f73-be16-40ea-b896-54a3ac29dcec`；审批 1 次、本机操作 4 次。
- 检查结果：上述目录 `verification.json`，`persistedAfterRestart=true`、`disabledAfterRestart=true`、`fixtureModel=true`、`paidModelCalled=false`。
- 员工档案及本机成果：上述目录 `runs/28434f73-be16-40ea-b896-54a3ac29dcec` 与 `workspaces/28434f73-be16-40ea-b896-54a3ac29dcec`。本机实际命令为 `node check.mjs`，退出码 0，生成正确的 `result.json`；脚本检验工作区、成果镜像与下载 JSON 相同。
- 本机检查输出：`本机运行检查通过：外部 API 配置、本机执行、逐次审批和重启后配置/授权保留；未调用付费模型。`

## 恢复实现核查与真实验收时机

新版已保存原批准完整 DAG、task ID、宿主验收及完成 attempt；恢复前核验文件 SHA256，保留固定知识引用、任务历史及预算/调用历史。恢复创建新 Run，在 staged 团队中还原已完成节点后只调度剩余节点。服务租约失效后停止旧运行，不自动重放；未知模型费用与未知修改操作继续阻止未经核对的恢复。

真实受控中断建议等开发节点有 `handoff/accepted` 与 `team/checkpoint`、独立测试节点等待尚未批准的 terminal 审批，且没有结果未知的操作或尚在请求中的模型调用。停止服务，再用最新代码指向原数据目录启动；检查原 Run 的停止状态、恢复入口、新 Run 的完整 DAG、开发节点继承与测试/经理续跑。停止后的终态可以为 cancelled 或 interrupted，取决于正常关闭还是进程断开。

优先通过原终端 Ctrl+C 正常关闭；强制结束进程的恢复依赖已写入的检查点与最长约 30 秒租约过期。禁止同时运行两份启动器访问同一数据库。已有主服务由主任务负责受控停止，本任务未触碰。

## 尚待补齐的证据

- 真实模型 Todo 项目的服务重启与续跑由主任务执行；上述固定协议本机检查不能替代它。
- 真实运行完整 DAG、完成节点不重复调用、预算/调用累积、文件版本与上下文的最终比对须记录真实父/子 Run ID。
- 知识授权/版本及隔离备份恢复由其他验证工作补齐；本任务未覆盖当前数据作恢复实验。
