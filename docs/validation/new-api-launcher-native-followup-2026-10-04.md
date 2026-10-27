# 启动器续审：实际重启与原生退出观察

**尚未确定新 WMI 服务退出的根因；没有完成稳定性修复。** 本次只读应用数据、查询系统元数据，并在隔离目录验证退出观察器，没有启动/停止主服务、改动凭据、调用模型或添加自动重启。完整结果见 [JSON 证据](../test-evidence/new-api-launcher-native-followup-2026-10-04.json)。

## 已证实与未证实

Windows `LastBootUpTime` 为 **2026-10-04 19:23:36.500 +08**；System `Microsoft-Windows-Kernel-General` 事件 12 为 19:23:36.758，`EventLog` 6005 为 19:23:58.246。旧 TTY 服务 35540/17032 在 19:20:55 就绪，早于这次实际重启。它跨重启后的消失不能仅归因于新用户回复、工具 turn 或 Job 清理。已在重启前消失的其他历史实例，也不能被这次重启倒推解释。

WMI 新服务 28328/33852 则在 **21:31/32、重启后**启动，最后日志仍是就绪；原 CMD 没有记录 Node 的退出码。进程结束后 `OpenProcess` 返回 87，无法还原旧 Job 属性或旧退出码；原因仍未知。21:39 曾出现的同 PID 35540 创建于 21:34:41，是 PID 复用，不能视为旧服务。

21:42 采样物理内存使用 49%、可用约 15.7 GiB，commit 约 56.6%。已查三小时窗口未发现相关 Node/PowerShell/CMD 应用崩溃、Resource-Exhaustion 2004 或选定 Defender 1116/1117/1121/1122 事件。晚于故障的资源采样、缺失事件均不能证明没有外部强杀或故障时资源异常。

`Win32_ProcessStopTrace` 类和普通进程查询可用，但直接临时订阅实际返回 **HRESULT 0x80041003 / NativeErrorCode 2，访问被拒绝**，未创建永久订阅或调整权限。[该事件包含 ExitStatus](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/krnlprov/win32-processstoptrace)；本环境本次采用原生句柄作为退出证据。

[Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)说明 WMI `Win32_Process.Create` 与普通 `CreateProcess` 的 Job 继承不同。因此，当前工具 PowerShell 的 `0x2800/KillOnClose` 不能直接解释 WMI 实例。`QueryInformationJobObject(NULL, …)` [查询调用者自己的直接 Job](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject)，不能冒充被观察服务的 flags。

## 已验证的只读观察器

[`watch-local-processes-2026-10-04.ps1`](../test-evidence/helpers/watch-local-processes-2026-10-04.ps1) 只申请 `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`，保留实际进程句柄，记录创建时间与 `IsProcessInJob`，确认 `WaitForSingleObject` 已 signaled 后读取 `GetExitCodeProcess`。它只读取 `session.json` 的数字 PID 和新 PID 元数据文件，不查询 HTTP、不读取凭据，不启动或终止进程；结束时关闭句柄。

隔离测试：Node 37224 于 12 秒后自行 `exit(7)`；15 秒观察器 36252 捕获实际 `inAnyJob=true` 和 **7 / 0x00000007**，正常退出且已关闭句柄。PowerShell 语法与真实退出码校验均通过。这验证观察工具，不代表真实 API 的历史退出原因或业务成功。

## 一次受控启动顺序

根任务已审阅脚本，所有正式服务启动由根任务执行。先启动独立的 600 秒观察器，再启动唯一一次静态 WMI CMD。观察器示例参数如下；输出必须是尚不存在的新文件：

```powershell
& './docs/test-evidence/helpers/watch-local-processes-2026-10-04.ps1' `
  -OutputPath '.data/controlled-launch-20261004-observer.jsonl' `
  -SessionFile 'C:\Users\JJ\Desktop\la\agent_department\.data\local\session.json' `
  -PidFile '.data/controlled-launch-20261004-pids.json' `
  -DurationSeconds 600
```

服务启动时立即将实际 `wrapperPid`、`launcherPid`、`apiPid` 数字写入新 PID 文件，并按 Parent 与创建时间确认身份，使 API ready 前也能持有句柄。保留本次独立 stdout/stderr，CMD 仅追加本次真实 Node 退出后的 exit code，不能猜测旧 code。

首先检查 `observer-start` 和 `process-attached`：`ownImmediateJob` 仅指观察器，`inAnyJob` 才是实际目标测量。若捕获 `process-exit`，对照数值与十六进制 code、启动器日志、资源及 OS boot 时间；退出码单独也不一定能识别结束者。观察器自身若也无结束记录而消失，需保留这一失败，不把未捕获记作 0。

用户长期运行仍建议普通独立 PowerShell，保持窗口打开、Ctrl+C 正常结束，避免依赖工具会话；本次受控启动用于查证，不宣称跨 turn 持久或稳定性已经通过。
