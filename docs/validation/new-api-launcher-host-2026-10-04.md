# 本机启动器宿主边界审查 · 2026-10-04

**根因未确定，不能宣称产品停止问题已修复。** 根任务报告两组启动器/API 进程同时消失（7400/43444、8524/37976），第二组最后只有 `workbench-ready`，未留下退出或异常日志。本次未启动、停止或修改主服务，未访问凭据或调用模型。

可证实的结果见 [完整 JSON 证据](../test-evidence/new-api-launcher-host-audit-2026-10-04.json)：

- 对本子 agent 工具创建的 **PowerShell** 调用 `IsProcessInJob` 和 `QueryInformationJobObject`，得到 `LimitFlags=0x2800`、`KillOnClose=true`。探测对象不是已经退出的旧 PID；无法据此证明旧启动器所在 Job 的属性、结束者或根因。
- 最近两小时 Application 的 1000/1001/1002 事件查询成功，在所取最多 50 条记录中未发现 Node/PowerShell/Pwsh 匹配；System 未有选定的 41/1074/6005/6006/6008 事件。没有事件不能排除强制结束或未记录的原生失败。CIM 进程查询被拒绝，未提权。
- 独立目录中的隐藏 Node 心跳进程（43472，启动 PowerShell 53560）于 11:05:53.401Z 启动，记录 12 次心跳，11:06:18.414Z 完成、18.415Z 正常退出；stderr 0 字节，工具会话退出码 0。它只使用文件与计时器，25 秒后自行结束，未导入应用或联网。实验未复现提前消失，也不能概括为所有 `Start-Process` 都会立即被工具清理。

源码 [`scripts/local.mjs`](../../scripts/local.mjs) 会记录正常 SIGINT/SIGTERM、API 子进程退出、启动失败、未捕获异常及同步退出；[`scripts/local-api.ts`](../../scripts/local-api.ts) 在父进程 IPC 断开时停止 API。若只有 API 退出且启动器仍存活，预期应有 `api-exit`。整组进程被强制结束时，JavaScript 日志未必有最后一条；工具 Job、控制台/会话清理等仍只是待核对候选。

19:09 左右的根任务状态记录为非 PTY 持续工具会话 42871，启动器 22060/API 45924，原数据可读且调用未新增；这是当时继续观察与网页验收的安排，不是当前存活或稳定性修复证据。本子 agent 未操作该服务。

后续实际查询确认 Windows 在 **19:23:36.500 +08 重启**（Kernel-General 12 与 EventLog 6005 相互印证）。此前 19:20 启动的旧 TTY 35540/17032 跨这次重启消失，不能仅归因于工具 turn 或 Job 清理。21:31 启动的新 WMI 实例则发生在重启后，根因仍未知，见 [续审、最小事件元数据与原生观察方案](new-api-launcher-native-followup-2026-10-04.md)。

给用户的启动建议：在最新代码所在项目根目录，用普通独立 PowerShell 长期运行启动命令并保持窗口打开，避免依赖 Codex 工具会话的生命周期。使用同一数据目录前，先确认旧服务已正常停止；不要同时启动两份服务。本次已有数据可沿用现有使用说明中的命令：

```powershell
node scripts/local.mjs '--data-dir=C:\Users\JJ\Desktop\la\agent_department\.data\local'
```

打开 `http://127.0.0.1:4310/`，结束时在该 PowerShell 使用 Ctrl+C。此建议不保证进程脱离所有 Windows Job，也不证明提前停止的根因；没有添加后台自动重启。
